"""Atomic principal spawn orchestration for hard-cut authority flows."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Optional
from uuid import UUID

from sqlalchemy.orm import Session

from caracal.identity.attestation_nonce import AttestationNonceManager
from caracal.core.ledger import LedgerWriter
from caracal.core.mandate import MandateManager
from caracal.core.principal_keys import generate_and_store_principal_keypair
from caracal.db.models import (
    ExecutionMandate,
    MandateContextTag,
    Principal,
    PrincipalAttestationStatus,
    PrincipalKind,
    PrincipalLifecycleStatus,
    PrincipalWorkloadBinding,
)
from caracal.exceptions import DuplicatePrincipalNameError, PrincipalNotFoundError


_IDEMPOTENCY_BINDING_TYPE = "spawn_idempotency"
_BOOTSTRAP_BINDING_TYPE = "attestation_bootstrap"
_LEDGER_RESOURCE_TYPE = "principal_spawn"


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
    ) -> None:
        self.db_session = db_session
        self.mandate_manager = mandate_manager or MandateManager(db_session=db_session)
        self.ledger_writer = ledger_writer
        self.attestation_nonce_manager = attestation_nonce_manager

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
        source_mandate_uuid = UUID(str(source_mandate_id)) if source_mandate_id else None

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

                duplicate = (
                    self.db_session.query(Principal)
                    .filter(Principal.name == principal_name)
                    .first()
                )
                if duplicate is not None:
                    raise DuplicatePrincipalNameError(
                        f"Principal with name '{principal_name}' already exists"
                    )

                principal = Principal(
                    name=principal_name,
                    principal_kind=principal_kind,
                    owner=owner,
                    source_principal_id=issuer_uuid,
                    lifecycle_status=PrincipalLifecycleStatus.PENDING_ATTESTATION.value,
                    attestation_status=PrincipalAttestationStatus.PENDING.value,
                    created_at=datetime.utcnow(),
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
                    validity_seconds=validity_seconds,
                    source_mandate_id=source_mandate_uuid,
                    network_distance=network_distance,
                    context_tags=context_tags,
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

        if self.attestation_nonce_manager is None:
            raise RuntimeError(
                "Attestation nonce manager is required for spawn attestation bootstrap"
            )

        issued_nonce = self.attestation_nonce_manager.issue_nonce(spawn_result.principal_id)
        return SpawnResult(
            principal_id=spawn_result.principal_id,
            principal_name=spawn_result.principal_name,
            principal_kind=spawn_result.principal_kind,
            mandate_id=spawn_result.mandate_id,
            attestation_bootstrap_artifact=spawn_result.attestation_bootstrap_artifact,
            attestation_nonce=issued_nonce.nonce,
            idempotent_replay=spawn_result.idempotent_replay,
        )

    def _find_existing_spawn(self, issuer_id: UUID, idempotency_key: str) -> Optional[SpawnResult]:
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
            .join(MandateContextTag, MandateContextTag.mandate_id == ExecutionMandate.mandate_id)
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
