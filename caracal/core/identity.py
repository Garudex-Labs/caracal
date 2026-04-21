"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

PostgreSQL-backed principal identity management for Caracal Core.
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional
from uuid import UUID

from caracal.db.models import (
    AuthorityLedgerEvent,
    Principal,
    PrincipalAttestationStatus,
    PrincipalKind,
    PrincipalLifecycleStatus,
)
from caracal.core.principal_keys import (
    generate_and_store_principal_keypair,
    principal_has_key_custody,
    resolve_principal_key_reference,
)
from caracal.core.lifecycle import PrincipalLifecycleStateMachine
from caracal.exceptions import DuplicatePrincipalNameError, PrincipalNotFoundError
from caracal.logging_config import get_logger

logger = get_logger(__name__)

# Canonical principal lifecycle API expected across SDK, CLI, and TUI.
CANONICAL_PRINCIPAL_LIFECYCLE_METHODS = (
    "register_principal",
    "list_principals",
    "get_principal",
    "update_principal",
)


class VerificationStatus(Enum):
    UNVERIFIED = "unverified"
    VERIFIED = "verified"
    TRUSTED = "trusted"


@dataclass
class PrincipalIdentity:
    principal_id: str
    name: str
    owner: str
    created_at: str
    metadata: Dict[str, Any]
    principal_kind: str = PrincipalKind.WORKER.value
    public_key: Optional[str] = None
    workspace_id: Optional[str] = None
    source_principal_id: Optional[str] = None
    lifecycle_status: str = PrincipalLifecycleStatus.ACTIVE.value
    attestation_status: str = PrincipalAttestationStatus.UNATTESTED.value
    verification_status: VerificationStatus = VerificationStatus.UNVERIFIED
    trust_level: int = 0
    capabilities: List[str] = field(default_factory=list)
    last_verified_at: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "principal_id": self.principal_id,
            "principal_kind": self.principal_kind,
            "name": self.name,
            "owner": self.owner,
            "created_at": self.created_at,
            "metadata": self.metadata,
            "public_key": self.public_key,
            "workspace_id": self.workspace_id,
            "source_principal_id": self.source_principal_id,
            "lifecycle_status": self.lifecycle_status,
            "attestation_status": self.attestation_status,
            "verification_status": self.verification_status.value,
            "trust_level": self.trust_level,
            "capabilities": self.capabilities,
            "last_verified_at": self.last_verified_at,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "PrincipalIdentity":
        status = data.get("verification_status", "unverified")
        if isinstance(status, str):
            status = VerificationStatus(status)
        return cls(
            principal_id=str(data["principal_id"]),
            principal_kind=data.get("principal_kind", PrincipalKind.WORKER.value),
            name=data["name"],
            owner=data["owner"],
            created_at=str(data["created_at"]),
            metadata=data.get("metadata", {}) or {},
            public_key=data.get("public_key"),
            workspace_id=data.get("workspace_id"),
            source_principal_id=data.get("source_principal_id"),
            lifecycle_status=data.get("lifecycle_status", PrincipalLifecycleStatus.ACTIVE.value),
            attestation_status=data.get("attestation_status", PrincipalAttestationStatus.UNATTESTED.value),
            verification_status=status,
            trust_level=int(data.get("trust_level", 0)),
            capabilities=data.get("capabilities", []),
            last_verified_at=data.get("last_verified_at"),
        )


class PrincipalRegistry:
    """Database-backed registry used by CLI, MCP, and delegation flows."""

    def __init__(self, session, backup_count: int = 3, delegation_token_manager=None):
        self.session = session
        self.backup_count = backup_count
        self.delegation_token_manager = delegation_token_manager
        self.lifecycle_state_machine = PrincipalLifecycleStateMachine()
        if self.delegation_token_manager is not None:
            self.delegation_token_manager.principal_registry = self

    @staticmethod
    def _to_identity(row: Principal) -> PrincipalIdentity:
        metadata = row.principal_metadata or {}
        created_at = row.created_at.isoformat() + "Z" if isinstance(row.created_at, datetime) else str(row.created_at)
        return PrincipalIdentity(
            principal_id=str(row.principal_id),
            principal_kind=row.principal_kind,
            name=row.name,
            owner=row.owner,
            created_at=created_at,
            metadata=metadata,
            public_key=row.public_key_pem or (metadata.get("public_key_pem") if isinstance(metadata, dict) else None),
            source_principal_id=str(row.source_principal_id) if row.source_principal_id else None,
            lifecycle_status=row.lifecycle_status,
            attestation_status=row.attestation_status,
        )

    def register_principal(
        self,
        name: str,
        owner: str,
        principal_kind: str = PrincipalKind.WORKER.value,
        metadata: Optional[Dict[str, Any]] = None,
        principal_id: Optional[str] = None,
        source_principal_id: Optional[str] = None,
        lifecycle_status: str = PrincipalLifecycleStatus.ACTIVE.value,
        attestation_status: str = PrincipalAttestationStatus.UNATTESTED.value,
        generate_keys: bool = True,
    ) -> PrincipalIdentity:
        if self.session.query(Principal).filter_by(name=name).first():
            raise DuplicatePrincipalNameError(f"Principal with name '{name}' already exists")

        principal_metadata = dict(metadata or {})

        source_uuid: Optional[UUID] = None
        if source_principal_id:
            source_uuid = UUID(str(source_principal_id))

        principal_uuid: Optional[UUID] = None
        if principal_id:
            principal_uuid = UUID(str(principal_id))

        row = Principal(
            principal_id=principal_uuid,
            name=name,
            principal_kind=principal_kind,
            owner=owner,
            source_principal_id=source_uuid,
            lifecycle_status=lifecycle_status,
            attestation_status=attestation_status,
            created_at=datetime.utcnow(),
            principal_metadata=principal_metadata or None,
        )
        self.session.add(row)
        self.session.flush()

        if generate_keys:
            generated = generate_and_store_principal_keypair(
                row.principal_id,
                db_session=self.session,
            )
            row.public_key_pem = generated.public_key_pem
            merged_metadata = dict(row.principal_metadata or {})
            merged_metadata.update(generated.storage.metadata)
            row.principal_metadata = merged_metadata
            self.session.flush()

        self.session.commit()
        logger.info("Registered principal", principal_id=str(row.principal_id), name=name)
        return self._to_identity(row)

    def create_principal(self, *args, **kwargs) -> PrincipalIdentity:
        return self.register_principal(*args, **kwargs)

    def update_principal(self, principal_id: str, metadata: Optional[Dict[str, Any]] = None) -> PrincipalIdentity:
        principal = self._get_row(principal_id)
        principal_metadata = dict(principal.principal_metadata or {})
        principal_metadata.update(metadata or {})
        principal.principal_metadata = principal_metadata
        self.session.flush()
        self.session.commit()
        return self._to_identity(principal)

    def transition_lifecycle_status(
        self,
        principal_id: str,
        target_status: str,
        actor_principal_id: Optional[str] = None,
    ) -> PrincipalIdentity:
        """Transition principal lifecycle status with kind-aware guardrails."""
        principal = self._get_row(principal_id)
        current_status = str(principal.lifecycle_status or PrincipalLifecycleStatus.ACTIVE.value)
        self.lifecycle_state_machine.assert_transition_allowed(
            principal_kind=str(principal.principal_kind),
            from_status=current_status,
            to_status=target_status,
            attestation_status=str(principal.attestation_status or "").strip().lower(),
        )

        normalized_target = str(target_status).strip().lower()
        if normalized_target == current_status:
            return self._to_identity(principal)

        principal.lifecycle_status = normalized_target
        principal_metadata = dict(principal.principal_metadata or {})
        principal_metadata["lifecycle_status"] = normalized_target
        principal_metadata["lifecycle_transitioned_at"] = datetime.utcnow().isoformat() + "Z"
        if actor_principal_id:
            principal_metadata["lifecycle_transitioned_by"] = str(actor_principal_id)
        principal.principal_metadata = principal_metadata

        self.session.add(
            AuthorityLedgerEvent(
                event_type="lifecycle_transition",
                timestamp=datetime.utcnow(),
                principal_id=principal.principal_id,
                mandate_id=None,
                decision="allowed",
                denial_reason=None,
                requested_action="lifecycle_transition",
                requested_resource=f"principal:{principal.principal_id}",
                correlation_id=None,
                event_metadata={
                    "principal_kind": principal.principal_kind,
                    "from_status": current_status,
                    "to_status": normalized_target,
                    "actor_principal_id": actor_principal_id,
                },
            )
        )

        self.session.flush()
        self.session.commit()
        logger.info(
            "Principal lifecycle transitioned",
            principal_id=str(principal.principal_id),
            principal_kind=principal.principal_kind,
            from_status=current_status,
            to_status=normalized_target,
            actor_principal_id=actor_principal_id,
        )
        return self._to_identity(principal)

    def _get_row(self, principal_id: str) -> Principal:
        try:
            principal_uuid = UUID(str(principal_id))
        except ValueError as exc:
            raise PrincipalNotFoundError(f"Invalid principal ID: {principal_id}") from exc
        row = self.session.query(Principal).filter_by(principal_id=principal_uuid).first()
        if not row:
            raise PrincipalNotFoundError(f"Principal {principal_id} not found")
        return row

    def get_principal(self, principal_id: str) -> Optional[PrincipalIdentity]:
        try:
            return self._to_identity(self._get_row(principal_id))
        except PrincipalNotFoundError:
            return None

    def list_principals(self) -> List[PrincipalIdentity]:
        rows = self.session.query(Principal).order_by(Principal.created_at.asc()).all()
        return [self._to_identity(row) for row in rows]

    def ensure_signing_keys(self, principal_id: str) -> PrincipalIdentity:
        """Ensure a principal has custody-backed ES256 key material."""
        principal = self._get_row(principal_id)
        principal_metadata = dict(principal.principal_metadata or {})

        if principal.public_key_pem and principal_has_key_custody(principal.principal_id, self.session):
            return self._to_identity(principal)

        generated = generate_and_store_principal_keypair(
            principal.principal_id,
            db_session=self.session,
        )
        principal.public_key_pem = generated.public_key_pem
        principal_metadata.update(generated.storage.metadata)
        principal.principal_metadata = principal_metadata
        self.session.flush()
        self.session.commit()
        return self._to_identity(principal)

    def rotate_signing_keys(
        self,
        principal_id: str,
        reason: str = "Key rotation",
        rotated_by: Optional[str] = None,
    ) -> PrincipalIdentity:
        """Rotate custody-backed signing keys for a principal."""
        principal = self._get_row(principal_id)
        principal_metadata = dict(principal.principal_metadata or {})

        rotation_history = principal_metadata.get("key_rotation_history")
        if not isinstance(rotation_history, list):
            rotation_history = []

        rotation_history.append(
            {
                "rotated_at": datetime.utcnow().isoformat(),
                "old_public_key": principal.public_key_pem,
                "reason": reason,
            }
        )
        principal_metadata["key_rotation_history"] = rotation_history

        generated = generate_and_store_principal_keypair(
            principal.principal_id,
            db_session=self.session,
        )
        principal.public_key_pem = generated.public_key_pem
        principal_metadata.update(generated.storage.metadata)
        principal_metadata["key_rotation_reason"] = reason
        principal_metadata["key_rotated_at"] = datetime.utcnow().isoformat() + "Z"
        if rotated_by:
            principal_metadata["key_rotated_by"] = str(rotated_by)
        principal.principal_metadata = principal_metadata

        self.session.flush()
        self.session.commit()
        return self._to_identity(principal)

    def generate_delegation_token(
        self,
        source_principal_id: str,
        target_principal_id: str,
        expiration_seconds: int = 86400,
        allowed_operations: Optional[List[str]] = None,
        delegation_type: str = "directed",
        source_principal_kind: str = "worker",
        target_principal_kind: str = "worker",
        context_tags: Optional[List[str]] = None,
    ) -> Optional[str]:
        if self.delegation_token_manager is None:
            return None

        source = self._get_row(source_principal_id)
        target = self._get_row(target_principal_id)

        # Ensure source has signing keys persisted via custody-backed key storage.
        source_metadata = dict(source.principal_metadata or {})
        if not source.public_key_pem or not principal_has_key_custody(source.principal_id, self.session):
            generated = generate_and_store_principal_keypair(
                source.principal_id,
                db_session=self.session,
            )
            source.public_key_pem = generated.public_key_pem
            source_metadata.update(generated.storage.metadata)
            source.principal_metadata = source_metadata
            self.session.flush()

        token = self.delegation_token_manager.generate_token(
            source_principal_id=UUID(str(source.principal_id)),
            target_principal_id=UUID(str(target.principal_id)),
            expiration_seconds=expiration_seconds,
            allowed_operations=allowed_operations,
            delegation_type=delegation_type,
            source_principal_kind=source_principal_kind,
            target_principal_kind=target_principal_kind,
            context_tags=context_tags,
        )

        target_metadata = dict(target.principal_metadata or {})
        target_metadata.setdefault("delegation_tokens", [])
        target_metadata["delegation_tokens"].append(
            {
                "token_id": token[:20] + "...",
                "source_principal_id": str(source.principal_id),
                "delegation_type": delegation_type,
                "created_at": datetime.utcnow().isoformat() + "Z",
                "expires_in_seconds": expiration_seconds,
            }
        )
        target.principal_metadata = target_metadata
        self.session.flush()
        self.session.commit()
        return token

    def get_signing_key_reference(self, principal_id: str) -> str:
        """Resolve the vault-backed signing key reference for a principal."""
        principal_uuid = UUID(str(principal_id))
        row = self.session.query(Principal).filter_by(principal_id=principal_uuid).first()
        if row is None:
            raise PrincipalNotFoundError(f"Principal {principal_id} not found")
        return resolve_principal_key_reference(
            principal_uuid,
            db_session=self.session,
            principal_metadata=row.principal_metadata,
        )
