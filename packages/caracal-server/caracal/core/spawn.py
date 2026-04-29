"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Atomic principal spawn orchestration for hard-cut authority flows.
"""

from __future__ import annotations

from hashlib import sha256
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from fnmatch import fnmatchcase
from typing import Optional
from uuid import UUID

from sqlalchemy.orm import Session

from caracal.identity.principal_ttl import PrincipalTTLManager, serialize_ttl_decision
from caracal.identity.attestation_nonce import AttestationNonceManager
from caracal.core.ledger import LedgerWriter
from caracal.core.mandate import MandateManager
from caracal.core.principal_keys import generate_and_store_principal_keypair
from caracal.db.models import (
    AuthorityLedgerEvent,
    ExecutionMandate,
    MandateContextTag,
    Principal,
    PrincipalAttestationStatus,
    PrincipalKind,
    PrincipalLifecycleStatus,
    PrincipalWorkloadBinding,
)
from caracal.exceptions import DuplicatePrincipalNameError, PrincipalNotFoundError
from caracal.logging_config import get_logger

_IDEMPOTENCY_BINDING_TYPE = "spawn_idempotency"
_BOOTSTRAP_BINDING_TYPE = "attestation_bootstrap"
_LEDGER_RESOURCE_TYPE = "principal_spawn"

logger = get_logger(__name__)


@dataclass
class SpawnResult:
    """Result of an atomic spawn operation."""

    principal_id: str
    principal_name: str
    principal_kind: str
    mandate_id: str
    attestation_bootstrap_artifact: str
    attestation_nonce: str
    idempotent_replay: bool


class SpawnManager:
    """Orchestrate principal spawn and delegated mandate issuance atomically."""

    def __init__(
        self,
        db_session: Session,
        mandate_manager: Optional[MandateManager] = None,
        ledger_writer: Optional[LedgerWriter] = None,
        attestation_nonce_manager: Optional[AttestationNonceManager] = None,
        principal_ttl_manager: Optional[PrincipalTTLManager] = None,
    ) -> None:
        self.db_session = db_session
        self.mandate_manager = mandate_manager or MandateManager(db_session=db_session)
        self.ledger_writer = ledger_writer
        self.attestation_nonce_manager = attestation_nonce_manager
        self.principal_ttl_manager = principal_ttl_manager

    def spawn_principal(
        self,
        *,
        issuer_principal_id: str,
        principal_name: str,
        principal_kind: str,
        owner: str,
        resource_scope: list[str],
        action_scope: list[str],
        validity_seconds: int,
        idempotency_key: str,
        source_mandate_id: Optional[str] = None,
        network_distance: Optional[int] = None,
    ) -> SpawnResult:
        """Create principal + attenuated mandate + bootstrap artifact in one transaction."""
        if principal_kind not in {
            PrincipalKind.ORCHESTRATOR.value,
            PrincipalKind.WORKER.value,
        }:
            raise ValueError(
                "spawn_principal only supports orchestrator and worker principal kinds"
            )

        issuer_uuid = UUID(str(issuer_principal_id))
        source_mandate_uuid = (
            UUID(str(source_mandate_id)) if source_mandate_id else None
        )
        resolved_network_distance = network_distance

        if source_mandate_uuid is not None:
            resolved_network_distance = self._resolve_source_mandate_network_distance(
                issuer_id=issuer_uuid,
                source_mandate_id=source_mandate_uuid,
                requested_resource_scope=resource_scope,
                requested_action_scope=action_scope,
                requested_network_distance=network_distance,
            )

        effective_validity_seconds = int(validity_seconds)
        ttl_decision = None
        if self.principal_ttl_manager is not None:
            ttl_decision = self.principal_ttl_manager.constrain_child_ttl(
                requested_ttl_seconds=effective_validity_seconds,
                parent_principal_id=str(issuer_uuid),
            )
            effective_validity_seconds = ttl_decision.effective_ttl_seconds

        if self.attestation_nonce_manager is None:
            raise RuntimeError(
                "Attestation nonce manager is required for spawn attestation bootstrap"
            )

        issued_nonce = None
        ttl_registered_principal_id: Optional[str] = None
        try:
            with self.db_session.begin_nested():
                existing = self._find_existing_spawn(issuer_uuid, idempotency_key)
                if existing is not None:
                    spawn_result = existing
                else:
                    issuer = (
                        self.db_session.query(Principal)
                        .filter(Principal.principal_id == issuer_uuid)
                        .first()
                    )
                    if issuer is None:
                        raise PrincipalNotFoundError(
                            f"Issuer principal '{issuer_principal_id}' does not exist"
                        )

                    if issuer.principal_kind == PrincipalKind.SERVICE.value:
                        raise ValueError(
                            f"Service principal '{issuer_principal_id}' is not authorized to spawn principals"
                        )

                    stored_principal_name = self._resolve_spawn_principal_name(
                        principal_name=principal_name,
                        owner=owner,
                        issuer_id=issuer_uuid,
                        idempotency_key=idempotency_key,
                    )

                    principal = Principal(
                        name=stored_principal_name,
                        principal_kind=principal_kind,
                        owner=owner,
                        source_principal_id=issuer_uuid,
                        lifecycle_status=PrincipalLifecycleStatus.PENDING_ATTESTATION.value,
                        attestation_status=PrincipalAttestationStatus.PENDING.value,
                        created_at=datetime.utcnow(),
                        principal_metadata=(
                            {"requested_name": principal_name}
                            if stored_principal_name != principal_name
                            else None
                        ),
                    )
                    self.db_session.add(principal)
                    self.db_session.flush()

                    generated = generate_and_store_principal_keypair(
                        principal.principal_id,
                        db_session=self.db_session,
                    )
                    principal.public_key_pem = generated.public_key_pem
                    self.db_session.flush()

                    spawn_binding = PrincipalWorkloadBinding(
                        principal_id=principal.principal_id,
                        workload=f"{issuer_uuid}:{idempotency_key}",
                        binding_type=_IDEMPOTENCY_BINDING_TYPE,
                        created_at=datetime.utcnow(),
                    )
                    self.db_session.add(spawn_binding)

                    bootstrap_artifact = f"attest-bootstrap:{principal.principal_id}"
                    bootstrap_binding = PrincipalWorkloadBinding(
                        principal_id=principal.principal_id,
                        workload=bootstrap_artifact,
                        binding_type=_BOOTSTRAP_BINDING_TYPE,
                        created_at=datetime.utcnow(),
                    )
                    self.db_session.add(bootstrap_binding)
                    self.db_session.flush()

                    context_tags = [
                        f"spawn:idempotency:{idempotency_key}",
                        f"spawn:bootstrap:{bootstrap_artifact}",
                    ]

                    mandate = self.mandate_manager.issue_mandate(
                        issuer_id=issuer_uuid,
                        subject_id=principal.principal_id,
                        resource_scope=resource_scope,
                        action_scope=action_scope,
                        validity_seconds=effective_validity_seconds,
                        source_mandate_id=source_mandate_uuid,
                        network_distance=resolved_network_distance,
                        context_tags=context_tags,
                    )

                    if source_mandate_uuid is not None:
                        graph = self.mandate_manager.delegation_graph
                        if graph is None:
                            from caracal.core.delegation_graph import DelegationGraph

                            graph = DelegationGraph(self.db_session)
                        graph.add_edge(
                            source_mandate_id=source_mandate_uuid,
                            target_mandate_id=mandate.mandate_id,
                            context_tags=context_tags,
                            expires_at=getattr(mandate, "valid_until", None),
                            metadata={
                                "spawned_principal_id": str(principal.principal_id)
                            },
                        )

                    if ttl_decision is not None and ttl_decision.truncated:
                        self.db_session.add(
                            AuthorityLedgerEvent(
                                event_type="principal_ttl_truncated",
                                timestamp=datetime.utcnow(),
                                principal_id=principal.principal_id,
                                mandate_id=mandate.mandate_id,
                                decision="allowed",
                                denial_reason=None,
                                requested_action="principal_spawn",
                                requested_resource=f"principal:{principal.principal_id}",
                                correlation_id=None,
                                event_metadata={
                                    "issuer_principal_id": str(issuer_uuid),
                                    "ttl_decision": serialize_ttl_decision(
                                        ttl_decision
                                    ),
                                },
                            )
                        )
                        logger.info(
                            "Spawn principal TTL truncated to parent lifetime",
                            principal_id=str(principal.principal_id),
                            issuer_principal_id=str(issuer_uuid),
                            requested_ttl_seconds=ttl_decision.requested_ttl_seconds,
                            effective_ttl_seconds=ttl_decision.effective_ttl_seconds,
                            parent_remaining_ttl_seconds=ttl_decision.parent_remaining_ttl_seconds,
                        )

                    if self.ledger_writer is not None:
                        self.ledger_writer.append_event(
                            principal_id=str(principal.principal_id),
                            resource_type=_LEDGER_RESOURCE_TYPE,
                            quantity=Decimal("0"),
                            metadata={
                                "issuer_principal_id": str(issuer_uuid),
                                "mandate_id": str(mandate.mandate_id),
                                "principal_kind": principal_kind,
                                "idempotency_key": idempotency_key,
                                "bootstrap_artifact": bootstrap_artifact,
                            },
                        )

                    spawn_result = SpawnResult(
                        principal_id=str(principal.principal_id),
                        principal_name=principal.name,
                        principal_kind=principal.principal_kind,
                        mandate_id=str(mandate.mandate_id),
                        attestation_bootstrap_artifact=bootstrap_artifact,
                        attestation_nonce="",
                        idempotent_replay=False,
                    )

                issued_nonce = self.attestation_nonce_manager.issue_nonce(
                    spawn_result.principal_id
                )
                if self.principal_ttl_manager is not None:
                    ttl_registered_principal_id = spawn_result.principal_id
                    self.principal_ttl_manager.register_pending_principal(
                        principal_id=spawn_result.principal_id,
                        pending_ttl_seconds=min(
                            effective_validity_seconds,
                            int(self.attestation_nonce_manager.ttl_seconds),
                        ),
                        active_ttl_seconds=effective_validity_seconds,
                        parent_principal_id=str(issuer_uuid),
                    )
        except Exception:
            if issued_nonce is not None and hasattr(
                self.attestation_nonce_manager, "revoke_nonce"
            ):
                try:
                    self.attestation_nonce_manager.revoke_nonce(issued_nonce.nonce)
                except Exception:
                    logger.warning(
                        "Failed to clean up attestation nonce after spawn rollback",
                        principal_id=(
                            spawn_result.principal_id
                            if "spawn_result" in locals()
                            else None
                        ),
                        exc_info=True,
                    )
            if ttl_registered_principal_id and self.principal_ttl_manager is not None:
                try:
                    self.principal_ttl_manager.clear_principal(
                        ttl_registered_principal_id
                    )
                except Exception:
                    logger.warning(
                        "Failed to clean up principal TTL lease after spawn rollback",
                        principal_id=ttl_registered_principal_id,
                        exc_info=True,
                    )
            raise

        return SpawnResult(
            principal_id=spawn_result.principal_id,
            principal_name=spawn_result.principal_name,
            principal_kind=spawn_result.principal_kind,
            mandate_id=spawn_result.mandate_id,
            attestation_bootstrap_artifact=spawn_result.attestation_bootstrap_artifact,
            attestation_nonce=issued_nonce.nonce,
            idempotent_replay=spawn_result.idempotent_replay,
        )

    def _resolve_source_mandate_network_distance(
        self,
        *,
        issuer_id: UUID,
        source_mandate_id: UUID,
        requested_resource_scope: list[str],
        requested_action_scope: list[str],
        requested_network_distance: Optional[int],
    ) -> int:
        """Validate delegated spawn constraints before any write-side transaction begins."""
        source_mandate = (
            self.db_session.query(ExecutionMandate)
            .filter(ExecutionMandate.mandate_id == source_mandate_id)
            .first()
        )
        if source_mandate is None:
            logger.warning(
                "Spawn rejected: source mandate missing",
                source_mandate_id=str(source_mandate_id),
                issuer_principal_id=str(issuer_id),
            )
            raise ValueError(f"Source mandate '{source_mandate_id}' does not exist")
        if source_mandate.revoked:
            logger.warning(
                "Spawn rejected: source mandate revoked",
                source_mandate_id=str(source_mandate_id),
                issuer_principal_id=str(issuer_id),
            )
            raise ValueError(f"Source mandate '{source_mandate_id}' is revoked")
        if source_mandate.subject_id != issuer_id:
            logger.warning(
                "Spawn rejected: source mandate subject mismatch",
                source_mandate_id=str(source_mandate_id),
                issuer_principal_id=str(issuer_id),
                source_subject_id=str(source_mandate.subject_id),
            )
            raise ValueError(
                "Source mandate subject does not match spawn issuer principal"
            )

        now = datetime.utcnow()
        if source_mandate.valid_from and now < source_mandate.valid_from:
            logger.warning(
                "Spawn rejected: source mandate not yet valid",
                source_mandate_id=str(source_mandate_id),
                issuer_principal_id=str(issuer_id),
            )
            raise ValueError(f"Source mandate '{source_mandate_id}' is not yet valid")
        if source_mandate.valid_until and now > source_mandate.valid_until:
            logger.warning(
                "Spawn rejected: source mandate expired",
                source_mandate_id=str(source_mandate_id),
                issuer_principal_id=str(issuer_id),
            )
            raise ValueError(f"Source mandate '{source_mandate_id}' has expired")

        if not self._scope_is_subset(
            requested_resource_scope, source_mandate.resource_scope
        ):
            logger.warning(
                "Spawn rejected: resource scope amplification attempt",
                source_mandate_id=str(source_mandate_id),
                issuer_principal_id=str(issuer_id),
                requested_resource_scope=requested_resource_scope,
                source_resource_scope=source_mandate.resource_scope,
            )
            raise ValueError(
                "Spawn resource scope must be a subset of source mandate scope"
            )
        if not self._scope_is_subset(
            requested_action_scope, source_mandate.action_scope
        ):
            logger.warning(
                "Spawn rejected: action scope amplification attempt",
                source_mandate_id=str(source_mandate_id),
                issuer_principal_id=str(issuer_id),
                requested_action_scope=requested_action_scope,
                source_action_scope=source_mandate.action_scope,
            )
            raise ValueError(
                "Spawn action scope must be a subset of source mandate scope"
            )

        source_depth = int(source_mandate.network_distance or 0)
        if source_depth <= 0:
            logger.warning(
                "Spawn rejected: source mandate has no remaining delegation depth",
                source_mandate_id=str(source_mandate_id),
                issuer_principal_id=str(issuer_id),
                source_network_distance=source_depth,
            )
            raise ValueError(
                f"Source mandate '{source_mandate_id}' has no remaining delegation depth"
            )

        max_child_depth = source_depth - 1
        if requested_network_distance is None:
            return max_child_depth

        resolved_network_distance = int(requested_network_distance)
        if resolved_network_distance < 0:
            logger.warning(
                "Spawn rejected: negative delegation depth requested",
                source_mandate_id=str(source_mandate_id),
                issuer_principal_id=str(issuer_id),
                requested_network_distance=resolved_network_distance,
            )
            raise ValueError("Spawn delegation depth cannot be negative")
        if resolved_network_distance > max_child_depth:
            logger.warning(
                "Spawn rejected: delegation depth amplification attempt",
                source_mandate_id=str(source_mandate_id),
                issuer_principal_id=str(issuer_id),
                requested_network_distance=resolved_network_distance,
                max_child_depth=max_child_depth,
            )
            raise ValueError(
                "Spawn delegation depth exceeds source mandate remaining delegation depth"
            )
        return resolved_network_distance

    @staticmethod
    def _scope_is_subset(requested_scope: list[str], source_scope: list[str]) -> bool:
        for requested_entry in requested_scope:
            if not any(
                fnmatchcase(requested_entry, pattern) for pattern in source_scope
            ):
                return False
        return True

    def _find_existing_spawn(
        self, issuer_id: UUID, idempotency_key: str
    ) -> Optional[SpawnResult]:
        """Resolve idempotent replay when a spawn already exists for the key."""
        marker = f"{issuer_id}:{idempotency_key}"
        binding = (
            self.db_session.query(PrincipalWorkloadBinding)
            .filter(PrincipalWorkloadBinding.binding_type == _IDEMPOTENCY_BINDING_TYPE)
            .filter(PrincipalWorkloadBinding.workload == marker)
            .first()
        )
        if binding is None:
            return None

        principal = (
            self.db_session.query(Principal)
            .filter(Principal.principal_id == binding.principal_id)
            .first()
        )
        if principal is None:
            return None

        tag_value = f"spawn:idempotency:{idempotency_key}"
        mandate = (
            self.db_session.query(ExecutionMandate)
            .join(
                MandateContextTag,
                MandateContextTag.mandate_id == ExecutionMandate.mandate_id,
            )
            .filter(ExecutionMandate.issuer_id == issuer_id)
            .filter(ExecutionMandate.subject_id == principal.principal_id)
            .filter(ExecutionMandate.revoked.is_(False))
            .filter(MandateContextTag.context_tag == tag_value)
            .order_by(ExecutionMandate.created_at.desc())
            .first()
        )
        if mandate is None:
            return None

        bootstrap_binding = (
            self.db_session.query(PrincipalWorkloadBinding)
            .filter(PrincipalWorkloadBinding.principal_id == principal.principal_id)
            .filter(PrincipalWorkloadBinding.binding_type == _BOOTSTRAP_BINDING_TYPE)
            .order_by(PrincipalWorkloadBinding.created_at.desc())
            .first()
        )
        if bootstrap_binding is None:
            return None

        return SpawnResult(
            principal_id=str(principal.principal_id),
            principal_name=principal.name,
            principal_kind=principal.principal_kind,
            mandate_id=str(mandate.mandate_id),
            attestation_bootstrap_artifact=bootstrap_binding.workload,
            attestation_nonce="",
            idempotent_replay=True,
        )

    def _resolve_spawn_principal_name(
        self,
        *,
        principal_name: str,
        owner: str,
        issuer_id: UUID,
        idempotency_key: str,
    ) -> str:
        duplicate = (
            self.db_session.query(Principal)
            .filter(Principal.owner == owner, Principal.name == principal_name)
            .first()
        )
        if duplicate is None:
            return principal_name

        suffix = sha256(
            f"{owner}:{issuer_id}:{idempotency_key}".encode("utf-8")
        ).hexdigest()[:12]
        base = principal_name[: 254 - len(suffix)].rstrip("-") or "spawn"
        scoped_name = f"{base}-{suffix}"
        duplicate = (
            self.db_session.query(Principal)
            .filter(Principal.owner == owner, Principal.name == scoped_name)
            .first()
        )
        if duplicate is not None:
            raise DuplicatePrincipalNameError(
                f"Principal with name '{principal_name}' already exists for owner '{owner}'"
            )
        return scoped_name
