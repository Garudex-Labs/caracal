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

from caracal.db.models import Principal
from caracal.core.principal_keys import generate_and_store_principal_keypair
from caracal.exceptions import DuplicatePrincipalNameError, PrincipalNotFoundError
from caracal.logging_config import get_logger

logger = get_logger(__name__)


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
    principal_type: str = "agent"
    public_key: Optional[str] = None
    org_id: Optional[str] = None
    role: Optional[str] = None
    verification_status: VerificationStatus = VerificationStatus.UNVERIFIED
    trust_level: int = 0
    capabilities: List[str] = field(default_factory=list)
    last_verified_at: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "principal_id": self.principal_id,
            "principal_type": self.principal_type,
            "name": self.name,
            "owner": self.owner,
            "created_at": self.created_at,
            "metadata": self.metadata,
            "public_key": self.public_key,
            "org_id": self.org_id,
            "role": self.role,
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
            principal_type=data.get("principal_type", "agent"),
            name=data["name"],
            owner=data["owner"],
            created_at=str(data["created_at"]),
            metadata=data.get("metadata", {}) or {},
            public_key=data.get("public_key"),
            org_id=data.get("org_id"),
            role=data.get("role"),
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
        if self.delegation_token_manager is not None:
            self.delegation_token_manager.principal_registry = self

    @staticmethod
    def _to_identity(row: Principal) -> PrincipalIdentity:
        metadata = row.principal_metadata or {}
        created_at = row.created_at.isoformat() + "Z" if isinstance(row.created_at, datetime) else str(row.created_at)
        return PrincipalIdentity(
            principal_id=str(row.principal_id),
            principal_type=row.principal_type,
            name=row.name,
            owner=row.owner,
            created_at=created_at,
            metadata=metadata,
            public_key=row.public_key_pem or (metadata.get("public_key_pem") if isinstance(metadata, dict) else None),
        )

    def register_principal(
        self,
        name: str,
        owner: str,
        principal_type: str = "agent",
        metadata: Optional[Dict[str, Any]] = None,
        generate_keys: bool = True,
    ) -> PrincipalIdentity:
        if self.session.query(Principal).filter_by(name=name).first():
            raise DuplicatePrincipalNameError(f"Principal with name '{name}' already exists")

        principal_metadata = dict(metadata or {})

        row = Principal(
            name=name,
            principal_type=principal_type,
            owner=owner,
            created_at=datetime.utcnow(),
            principal_metadata=principal_metadata or None,
        )
        self.session.add(row)
        self.session.flush()

        if generate_keys:
            generated = generate_and_store_principal_keypair(row.principal_id)
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

    def update_agent(self, principal_id: str, metadata: Optional[Dict[str, Any]] = None) -> PrincipalIdentity:
        principal = self._get_row(principal_id)
        principal_metadata = dict(principal.principal_metadata or {})
        principal_metadata.update(metadata or {})
        principal.principal_metadata = principal_metadata
        self.session.flush()
        self.session.commit()
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

    def generate_delegation_token(
        self,
        source_principal_id: str,
        target_principal_id: str,
        expiration_seconds: int = 86400,
        allowed_operations: Optional[List[str]] = None,
        delegation_type: str = "directed",
        source_principal_type: str = "agent",
        target_principal_type: str = "agent",
        context_tags: Optional[List[str]] = None,
    ) -> Optional[str]:
        if self.delegation_token_manager is None:
            return None

        source = self._get_row(source_principal_id)
        target = self._get_row(target_principal_id)

        # Ensure source has signing keys persisted via the principal key storage abstraction.
        source_metadata = dict(source.principal_metadata or {})
        has_private_material = any(
            k in source_metadata
            for k in ("private_key_ref", "aws_kms_ciphertext_b64", "private_key_pem")
        )
        if not source.public_key_pem or not has_private_material:
            generated = generate_and_store_principal_keypair(source.principal_id)
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
            source_principal_type=source_principal_type,
            target_principal_type=target_principal_type,
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


# Backward-compatible aliases
AgentRegistry = PrincipalRegistry
AgentIdentity = PrincipalIdentity
