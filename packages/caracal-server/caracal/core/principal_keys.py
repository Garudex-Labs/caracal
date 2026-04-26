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

from sqlalchemy.orm import Session

from caracal.core.vault import VaultError, get_vault, vault_access_context
from caracal.db.models import (
    PrincipalKeyBackend,
    PrincipalKeyCustody,
    PrincipalKeyCustodyVault,
)

from caracal.logging_config import get_logger

logger = get_logger(__name__)

_VAULT_BACKEND = PrincipalKeyBackend.VAULT.value
_VAULT_BACKEND_ENV = "CCL_PRINCIPAL_KEY_BACKEND"
_VAULT_WORKSPACE_ENV = "CCL_VAULT_WORKSPACE_ID"
_VAULT_ENV_ENV = "CCL_VAULT_ENVIRONMENT"
_VAULT_KEY_PREFIX_ENV = "CCL_VAULT_PRINCIPAL_KEY_PREFIX"

_DEFAULT_VAULT_WORKSPACE = "caracal"
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
    backend = (os.getenv(_VAULT_BACKEND_ENV) or _VAULT_BACKEND).strip().lower()
    if backend != _VAULT_BACKEND:
        raise PrincipalKeyStorageError(
            f"{_VAULT_BACKEND_ENV}={backend!r} is unsupported. "
            f"Hard-cut mode requires '{_VAULT_BACKEND}'."
        )
    return backend


def _resolve_vault_context() -> tuple[str, str]:
    workspace_id = (os.getenv(_VAULT_WORKSPACE_ENV) or _DEFAULT_VAULT_WORKSPACE).strip()
    env_id = (os.getenv(_VAULT_ENV_ENV) or _DEFAULT_VAULT_ENV).strip()

    if workspace_id:
        try:
            UUID(workspace_id)
        except Exception:
            try:
                resolved_project = str(getattr(get_vault()._config, "default_project", "") or "").strip()
                if resolved_project:
                    UUID(resolved_project)
                    workspace_id = resolved_project
            except Exception:
                pass

    if not env_id:
        try:
            resolved_env = str(getattr(get_vault()._config, "default_environment", "") or "").strip()
            if resolved_env:
                env_id = resolved_env
        except Exception:
            pass

    if not workspace_id or not env_id:
        raise PrincipalKeyStorageError(
            "Vault context is incomplete. "
            f"Set {_VAULT_WORKSPACE_ENV} and {_VAULT_ENV_ENV}."
        )
    return workspace_id, env_id


def _resolve_secret_name(principal_id: UUID) -> str:
    prefix = (os.getenv(_VAULT_KEY_PREFIX_ENV) or _DEFAULT_VAULT_KEY_PREFIX).strip().strip("/")
    if not prefix:
        prefix = _DEFAULT_VAULT_KEY_PREFIX
    return f"{prefix}/{principal_id}"


def _resolve_public_secret_name(principal_id: UUID) -> str:
    return f"{_resolve_secret_name(principal_id)}.public"


def _build_vault_reference(workspace_id: str, env_id: str, secret_name: str) -> str:
    return f"vault://{workspace_id}/{env_id}/{secret_name}"


def _parse_vault_reference(reference: str) -> tuple[str, str, str]:
    normalized = (reference or "").strip()
    if not normalized.startswith("vault://"):
        raise PrincipalKeyStorageError(
            "Invalid vault key reference format. Expected 'vault://<workspace>/<env>/<secret>'."
        )
    payload = normalized[len("vault://") :]
    parts = payload.split("/", 2)
    if len(parts) != 3 or not all(parts):
        raise PrincipalKeyStorageError(
            "Invalid vault key reference format. Expected 'vault://<workspace>/<env>/<secret>'."
        )
    return parts[0], parts[1], parts[2]


def parse_vault_key_reference(reference: str) -> tuple[str, str, str]:
    """Parse a vault signing-key reference."""
    return _parse_vault_reference(reference)


def _vault_get_secret(workspace_id: str, env_id: str, secret_name: str) -> str:
    try:
        with vault_access_context():
            return get_vault().get(workspace_id=workspace_id, env_id=env_id, name=secret_name)
    except VaultError as exc:
        raise PrincipalKeyStorageError(
            f"Failed to read principal key material from vault ({workspace_id}/{env_id}/{secret_name})."
        ) from exc


def generate_and_store_principal_keypair(
    principal_id: UUID,
    db_session: Optional[Session] = None,
) -> PrincipalKeypairResult:
    """Provision a custody-backed ES256 keypair without exposing private key material."""
    backend = _resolve_backend()
    workspace_id, env_id = _resolve_vault_context()
    private_secret_name = _resolve_secret_name(principal_id)
    public_secret_name = _resolve_public_secret_name(principal_id)
    key_reference = _build_vault_reference(workspace_id, env_id, private_secret_name)
    public_key_reference = _build_vault_reference(workspace_id, env_id, public_secret_name)

    try:
        with vault_access_context():
            vault = get_vault()
            vault.ensure_asymmetric_keypair(
                workspace_id=workspace_id,
                env_id=env_id,
                private_key_name=private_secret_name,
                public_key_name=public_secret_name,
                algorithm="ES256",
                actor=f"principal-keys:{principal_id}",
            )
    except VaultError as exc:
        raise PrincipalKeyStorageError(
            "Failed to provision principal signing keypair in vault "
            f"({workspace_id}/{env_id}/{private_secret_name}): {exc}"
        ) from exc

    public_pem = _vault_get_secret(
        workspace_id=workspace_id,
        env_id=env_id,
        secret_name=public_secret_name,
    )

    storage = PrincipalKeyStorageResult(
        backend=backend,
        reference=key_reference,
        metadata={
            "key_backend": backend,
            "vault_key_ref": key_reference,
            "vault_public_key_ref": public_key_reference,
            "key_updated_at": datetime.utcnow().isoformat(),
        },
    )

    if db_session is not None:
        _upsert_custody_record(db_session=db_session, principal_id=principal_id, storage=storage)
    return PrincipalKeypairResult(public_key_pem=public_pem, storage=storage)


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


def resolve_principal_key_reference(
    principal_id: UUID,
    db_session: Session,
    principal_metadata: Optional[Mapping[str, object]] = None,
) -> str:
    """Resolve the opaque vault reference for a principal signing key."""
    custody = db_session.query(PrincipalKeyCustody).filter_by(principal_id=principal_id).first()
    if custody is not None:
        backend = str(custody.backend or "").strip().lower()
        if backend != _VAULT_BACKEND:
            raise PrincipalKeyStorageError(
                "Unsupported key backend in custody record: "
                f"{backend!r}. Expected '{_VAULT_BACKEND}'."
            )
        key_reference = str(custody.key_reference or "").strip()
        if not key_reference:
            raise PrincipalKeyStorageError("Missing vault key reference in custody record")
        return key_reference

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
    return key_reference.strip()


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
        workspace_id, env_id, _ = _parse_vault_reference(storage.reference)
        vault_namespace = f"{workspace_id}/{env_id}"
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
