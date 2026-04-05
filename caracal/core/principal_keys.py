"""
Principal key generation and storage helpers.

This module centralizes principal key behavior so Flow and CLI use the same
storage backend selection and metadata conventions.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime
from typing import Mapping, Optional
from uuid import UUID, uuid4

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from sqlalchemy.orm import Session

from caracal.core.vault import VaultError, gateway_context, get_vault
from caracal.db.models import (
    PrincipalKeyBackend,
    PrincipalKeyCustody,
    PrincipalKeyCustodyVault,
)

from caracal.logging_config import get_logger

logger = get_logger(__name__)

_VAULT_BACKEND = PrincipalKeyBackend.VAULT.value
_VAULT_BACKEND_ENV = "CARACAL_PRINCIPAL_KEY_BACKEND"
_VAULT_ORG_ENV = "CARACAL_VAULT_ORG_ID"
_VAULT_ENV_ENV = "CARACAL_VAULT_ENV_ID"
_VAULT_KEY_PREFIX_ENV = "CARACAL_VAULT_PRINCIPAL_KEY_PREFIX"

_DEFAULT_VAULT_ORG = "caracal"
_DEFAULT_VAULT_ENV = "runtime"
_DEFAULT_VAULT_KEY_PREFIX = "principal-keys"


@dataclass
class PrincipalKeyStorageResult:
    """Details about where a principal private key was stored."""

    backend: str
    reference: str
    metadata: dict


@dataclass
class PrincipalKeypairResult:
    """Generated keypair values plus storage details."""

    public_key_pem: str
    storage: PrincipalKeyStorageResult


class PrincipalKeyStorageError(RuntimeError):
    """Raised when principal key storage or resolution cannot be completed safely."""


def _resolve_backend() -> str:
    backend = os.getenv(_VAULT_BACKEND_ENV, _VAULT_BACKEND).strip().lower()
    if backend != _VAULT_BACKEND:
        raise PrincipalKeyStorageError(
            f"{_VAULT_BACKEND_ENV}={backend!r} is unsupported. "
            f"Hard-cut mode requires '{_VAULT_BACKEND}'."
        )
    return backend


def _resolve_vault_context() -> tuple[str, str]:
    org_id = (os.getenv(_VAULT_ORG_ENV) or _DEFAULT_VAULT_ORG).strip()
    env_id = (os.getenv(_VAULT_ENV_ENV) or _DEFAULT_VAULT_ENV).strip()
    if not org_id or not env_id:
        raise PrincipalKeyStorageError(
            "Vault context is incomplete. "
            f"Set {_VAULT_ORG_ENV} and {_VAULT_ENV_ENV}."
        )
    return org_id, env_id


def _resolve_secret_name(principal_id: UUID) -> str:
    prefix = (os.getenv(_VAULT_KEY_PREFIX_ENV) or _DEFAULT_VAULT_KEY_PREFIX).strip().strip("/")
    if not prefix:
        prefix = _DEFAULT_VAULT_KEY_PREFIX
    return f"{prefix}/{principal_id}"


def _build_vault_reference(org_id: str, env_id: str, secret_name: str) -> str:
    return f"vault://{org_id}/{env_id}/{secret_name}"


def _parse_vault_reference(reference: str) -> tuple[str, str, str]:
    normalized = (reference or "").strip()
    if not normalized.startswith("vault://"):
        raise PrincipalKeyStorageError(
            "Invalid vault key reference format. Expected 'vault://<org>/<env>/<secret>'."
        )
    payload = normalized[len("vault://") :]
    parts = payload.split("/", 2)
    if len(parts) != 3 or not all(parts):
        raise PrincipalKeyStorageError(
            "Invalid vault key reference format. Expected 'vault://<org>/<env>/<secret>'."
        )
    return parts[0], parts[1], parts[2]


def _vault_put_secret(org_id: str, env_id: str, secret_name: str, value: str) -> None:
    try:
        with gateway_context():
            get_vault().put(org_id=org_id, env_id=env_id, name=secret_name, plaintext=value)
    except VaultError as exc:
        raise PrincipalKeyStorageError(
            f"Failed to persist principal key in vault ({org_id}/{env_id}/{secret_name})."
        ) from exc


def _vault_get_secret(reference: str) -> str:
    org_id, env_id, secret_name = _parse_vault_reference(reference)
    try:
        with gateway_context():
            return get_vault().get(org_id=org_id, env_id=env_id, name=secret_name)
    except VaultError as exc:
        raise PrincipalKeyStorageError(
            f"Failed to resolve principal key from vault reference: {reference}"
        ) from exc


def generate_and_store_principal_keypair(
    principal_id: UUID,
    db_session: Optional[Session] = None,
) -> PrincipalKeypairResult:
    """Generate an ECDSA P-256 keypair and persist custody via configured backend."""
    private_key = ec.generate_private_key(ec.SECP256R1())
    public_key = private_key.public_key()

    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")

    public_pem = public_key.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("utf-8")

    storage = store_principal_private_key(
        principal_id=principal_id,
        private_key_pem=private_pem,
        db_session=db_session,
    )
    return PrincipalKeypairResult(public_key_pem=public_pem, storage=storage)


def store_principal_private_key(
    principal_id: UUID,
    private_key_pem: str,
    db_session: Optional[Session] = None,
) -> PrincipalKeyStorageResult:
    """Store a principal private key in vault custody and persist an opaque reference."""
    backend = _resolve_backend()
    org_id, env_id = _resolve_vault_context()
    secret_name = _resolve_secret_name(principal_id)
    key_reference = _build_vault_reference(org_id, env_id, secret_name)

    _vault_put_secret(org_id=org_id, env_id=env_id, secret_name=secret_name, value=private_key_pem)

    storage = PrincipalKeyStorageResult(
        backend=backend,
        reference=key_reference,
        metadata={
            "key_backend": backend,
            "vault_key_ref": key_reference,
            "key_updated_at": datetime.utcnow().isoformat(),
        },
    )

    if db_session is not None:
        _upsert_custody_record(db_session=db_session, principal_id=principal_id, storage=storage)
    return storage


def principal_has_key_custody(principal_id: UUID, db_session: Session) -> bool:
    """Return True when a custody record exists for the principal."""
    return (
        db_session.query(PrincipalKeyCustody)
        .filter_by(principal_id=principal_id)
        .first()
        is not None
    )


def get_principal_key_backend(principal_id: UUID, db_session: Session) -> Optional[str]:
    """Return the current custody backend for a principal if present."""
    custody = db_session.query(PrincipalKeyCustody).filter_by(principal_id=principal_id).first()
    return custody.backend if custody else None


def resolve_principal_private_key(
    principal_id: UUID,
    db_session: Session,
    principal_metadata: Optional[Mapping[str, object]] = None,
) -> str:
    """Resolve a principal private key PEM from custody records.

    Falls back to metadata references when custody records are absent.
    """
    custody = db_session.query(PrincipalKeyCustody).filter_by(principal_id=principal_id).first()
    if custody is None:
        if principal_metadata:
            return _resolve_from_metadata(principal_id, principal_metadata)
        raise PrincipalKeyStorageError(f"No custody record found for principal '{principal_id}'")

    backend = str(custody.backend or "").strip().lower()
    if backend != _VAULT_BACKEND:
        raise PrincipalKeyStorageError(
            "Unsupported key backend in custody record: "
            f"{backend!r}. Expected '{_VAULT_BACKEND}'."
        )

    key_reference = str(custody.key_reference or "").strip()
    if not key_reference:
        raise PrincipalKeyStorageError("Missing vault key reference in custody record")
    return _vault_get_secret(key_reference)


def _resolve_from_metadata(principal_id: UUID, principal_metadata: Mapping[str, object]) -> str:
    """Resolve key material from vault metadata references."""
    metadata = dict(principal_metadata or {})
    backend = str(metadata.get("key_backend") or _VAULT_BACKEND).strip().lower()
    if backend != _VAULT_BACKEND:
        raise PrincipalKeyStorageError(
            "Unsupported key_backend in principal metadata: "
            f"{backend!r}. Expected '{_VAULT_BACKEND}'."
        )

    key_reference = metadata.get("vault_key_ref") or metadata.get("key_reference")
    if not isinstance(key_reference, str) or not key_reference.strip():
        raise PrincipalKeyStorageError(
            f"Missing vault_key_ref for principal key resolution ({principal_id})"
        )
    return _vault_get_secret(key_reference)


def _upsert_custody_record(
    db_session: Session,
    principal_id: UUID,
    storage: PrincipalKeyStorageResult,
) -> None:
    now = datetime.utcnow()
    custody = db_session.query(PrincipalKeyCustody).filter_by(principal_id=principal_id).first()
    if custody is None:
        custody = PrincipalKeyCustody(
            custody_id=uuid4(),
            principal_id=principal_id,
            backend=storage.backend,
            key_reference=storage.reference,
            key_updated_at=now,
            created_at=now,
            rotated_at=None,
        )
        db_session.add(custody)
        db_session.flush()
    else:
        custody.backend = storage.backend
        custody.key_reference = storage.reference
        custody.key_updated_at = now
        custody.rotated_at = now

    if storage.backend != PrincipalKeyBackend.VAULT.value:
        raise PrincipalKeyStorageError(
            f"Unsupported custody backend for persistence: {storage.backend!r}"
        )

    try:
        org_id, env_id, _ = _parse_vault_reference(storage.reference)
        vault_namespace = f"{org_id}/{env_id}"
    except PrincipalKeyStorageError:
        vault_namespace = None

    if custody.vault_details is None:
        custody.vault_details = PrincipalKeyCustodyVault(
            custody_id=custody.custody_id,
            vault_key_ref=storage.reference,
            vault_namespace=vault_namespace,
        )
        return

    custody.vault_details.vault_key_ref = storage.reference
    custody.vault_details.vault_namespace = vault_namespace


def backup_local_private_key(principal_id: UUID) -> Optional[str]:
    """Compatibility no-op: local key files are not used in hard-cut mode."""
    _ = principal_id
    return None
