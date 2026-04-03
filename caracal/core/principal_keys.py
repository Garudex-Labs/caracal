"""
Principal key generation and storage helpers.

This module centralizes principal key behavior so Flow and CLI use the same
storage backend selection and metadata conventions.
"""

from __future__ import annotations

import base64
import os
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Mapping, Optional
from uuid import UUID, uuid4

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from sqlalchemy.orm import Session

from caracal.db.models import (
    PrincipalKeyBackend,
    PrincipalKeyCustody,
    PrincipalKeyCustodyAWSKMS,
    PrincipalKeyCustodyLocal,
)

from caracal.logging_config import get_logger
from caracal.pathing import ensure_source_tree

logger = get_logger(__name__)

_LOCAL_BACKEND = "local"
_AWS_KMS_BACKEND = "aws_kms"


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
    """Store a principal private key using configured backend.

    Backend selection:
    - local (default)
    - aws_kms (requires CARACAL_AWS_KMS_KEY_ID and boto3)
    """
    backend = os.getenv("CARACAL_PRINCIPAL_KEY_BACKEND", _LOCAL_BACKEND).strip().lower()

    if backend not in {_LOCAL_BACKEND, _AWS_KMS_BACKEND}:
        raise PrincipalKeyStorageError(
            "Unsupported CARACAL_PRINCIPAL_KEY_BACKEND value: "
            f"{backend!r}. Expected '{_LOCAL_BACKEND}' or '{_AWS_KMS_BACKEND}'."
        )

    if backend == _AWS_KMS_BACKEND:
        kms_result = _store_in_aws_kms(principal_id=principal_id, private_key_pem=private_key_pem)
        if kms_result is not None:
            if db_session is not None:
                _upsert_custody_record(db_session=db_session, principal_id=principal_id, storage=kms_result)
            return kms_result
        raise PrincipalKeyStorageError(
            "AWS KMS backend is configured but key storage failed."
        )

    local_result = _store_locally(principal_id=principal_id, private_key_pem=private_key_pem)
    if db_session is not None:
        _upsert_custody_record(db_session=db_session, principal_id=principal_id, storage=local_result)
    return local_result


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

    if backend == _LOCAL_BACKEND:
        details = custody.local_details
        private_key_ref = details.private_key_ref if details else custody.key_reference
        if not private_key_ref:
            raise PrincipalKeyStorageError("Missing local private key reference in custody record")

        key_path = Path(private_key_ref).expanduser().resolve(strict=False)
        if not key_path.exists():
            raise PrincipalKeyStorageError(f"Local private key file does not exist: {key_path}")

        try:
            return key_path.read_text(encoding="utf-8")
        except Exception as exc:
            raise PrincipalKeyStorageError(f"Failed to read local private key file: {key_path}") from exc

    if backend == _AWS_KMS_BACKEND:
        details = custody.aws_kms_details
        if details is None:
            raise PrincipalKeyStorageError("Missing AWS KMS custody details for principal key resolution")

        ciphertext_b64 = details.ciphertext_b64
        key_id = details.kms_key_id or os.getenv("CARACAL_AWS_KMS_KEY_ID") or os.getenv("AWS_KMS_KEY_ID")
        region = details.kms_region or os.getenv("CARACAL_AWS_KMS_REGION") or os.getenv("AWS_REGION")

        if not ciphertext_b64:
            raise PrincipalKeyStorageError("Missing ciphertext in AWS KMS custody details")
        if not key_id:
            raise PrincipalKeyStorageError("Missing aws_kms_key_id for AWS KMS key resolution")

        try:
            import boto3  # type: ignore
        except Exception as exc:
            raise PrincipalKeyStorageError("boto3 is required to resolve AWS KMS-backed principal keys") from exc

        try:
            session = boto3.session.Session(region_name=region) if region else boto3.session.Session()
            kms_client = session.client("kms")
            decrypt_response = kms_client.decrypt(
                KeyId=key_id,
                CiphertextBlob=base64.b64decode(ciphertext_b64),
                EncryptionContext={"caracal:principal_id": str(principal_id)},
            )
            return decrypt_response["Plaintext"].decode("utf-8")
        except Exception as exc:
            raise PrincipalKeyStorageError("Failed to decrypt AWS KMS principal key ciphertext") from exc

    raise PrincipalKeyStorageError(
        "Unsupported key backend in custody record: "
        f"{backend!r}. Expected '{_LOCAL_BACKEND}' or '{_AWS_KMS_BACKEND}'."
    )


def _resolve_from_metadata(principal_id: UUID, principal_metadata: Mapping[str, object]) -> str:
    """Resolve key material from legacy metadata references."""
    metadata = dict(principal_metadata or {})
    backend = str(metadata.get("key_backend") or _LOCAL_BACKEND).strip().lower()

    if backend == _LOCAL_BACKEND:
        private_key_ref = metadata.get("private_key_ref")
        if not isinstance(private_key_ref, str) or not private_key_ref.strip():
            raise PrincipalKeyStorageError("Missing local private_key_ref for principal key resolution")
        key_path = Path(private_key_ref).expanduser().resolve(strict=False)
        if not key_path.exists():
            raise PrincipalKeyStorageError(f"Local private key file does not exist: {key_path}")
        try:
            return key_path.read_text(encoding="utf-8")
        except Exception as exc:
            raise PrincipalKeyStorageError(f"Failed to read local private key file: {key_path}") from exc

    if backend == _AWS_KMS_BACKEND:
        ciphertext_b64 = metadata.get("aws_kms_ciphertext_b64")
        key_id = metadata.get("aws_kms_key_id")
        region = metadata.get("aws_kms_region") or os.getenv("CARACAL_AWS_KMS_REGION") or os.getenv("AWS_REGION")

        if not isinstance(ciphertext_b64, str) or not ciphertext_b64.strip():
            raise PrincipalKeyStorageError("Missing aws_kms_ciphertext_b64 for AWS KMS key resolution")
        if not isinstance(key_id, str) or not key_id.strip():
            key_id = os.getenv("CARACAL_AWS_KMS_KEY_ID") or os.getenv("AWS_KMS_KEY_ID")
        if not isinstance(key_id, str) or not key_id.strip():
            raise PrincipalKeyStorageError("Missing aws_kms_key_id for AWS KMS key resolution")

        try:
            import boto3  # type: ignore
        except Exception as exc:
            raise PrincipalKeyStorageError("boto3 is required to resolve AWS KMS-backed principal keys") from exc

        try:
            session = boto3.session.Session(region_name=region) if region else boto3.session.Session()
            kms_client = session.client("kms")
            decrypt_response = kms_client.decrypt(
                KeyId=key_id,
                CiphertextBlob=base64.b64decode(ciphertext_b64),
                EncryptionContext={"caracal:principal_id": str(principal_id)},
            )
            return decrypt_response["Plaintext"].decode("utf-8")
        except Exception as exc:
            raise PrincipalKeyStorageError("Failed to decrypt AWS KMS principal key ciphertext") from exc

    raise PrincipalKeyStorageError(
        "Unsupported key_backend in principal metadata: "
        f"{backend!r}. Expected '{_LOCAL_BACKEND}' or '{_AWS_KMS_BACKEND}'."
    )


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

    if storage.backend == PrincipalKeyBackend.LOCAL.value:
        if custody.aws_kms_details is not None:
            db_session.delete(custody.aws_kms_details)
            db_session.flush()
        private_key_ref = str(storage.metadata.get("private_key_ref") or storage.reference)
        if custody.local_details is None:
            custody.local_details = PrincipalKeyCustodyLocal(
                custody_id=custody.custody_id,
                private_key_ref=private_key_ref,
            )
        else:
            custody.local_details.private_key_ref = private_key_ref
        return

    if storage.backend == PrincipalKeyBackend.AWS_KMS.value:
        if custody.local_details is not None:
            db_session.delete(custody.local_details)
            db_session.flush()
        kms_key_id = str(storage.metadata.get("aws_kms_key_id") or "").strip()
        ciphertext_b64 = str(storage.metadata.get("aws_kms_ciphertext_b64") or "").strip()
        kms_region_raw = storage.metadata.get("aws_kms_region")
        kms_region = str(kms_region_raw).strip() if kms_region_raw else None
        if not kms_key_id or not ciphertext_b64:
            raise PrincipalKeyStorageError(
                "AWS KMS custody metadata is incomplete; cannot persist custody row"
            )
        if custody.aws_kms_details is None:
            custody.aws_kms_details = PrincipalKeyCustodyAWSKMS(
                custody_id=custody.custody_id,
                kms_key_id=kms_key_id,
                kms_region=kms_region,
                ciphertext_b64=ciphertext_b64,
            )
        else:
            custody.aws_kms_details.kms_key_id = kms_key_id
            custody.aws_kms_details.kms_region = kms_region
            custody.aws_kms_details.ciphertext_b64 = ciphertext_b64
        return

    raise PrincipalKeyStorageError(
        f"Unsupported custody backend for persistence: {storage.backend!r}"
    )


def backup_local_private_key(principal_id: UUID) -> Optional[Path]:
    """Backup an existing local key file before rotation."""
    key_path = get_local_private_key_path(principal_id)
    if not key_path.exists():
        return None

    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    backup_path = key_path.with_name(f"{key_path.name}.bak_{timestamp}")
    key_path.rename(backup_path)
    return backup_path.resolve(strict=False)


def get_local_private_key_path(principal_id: UUID) -> Path:
    """Return the absolute local path where a principal key should be stored."""
    key_dir = _resolve_local_keystore_dir()
    return (key_dir / f"{principal_id}.key").expanduser().resolve(strict=False)


def _resolve_local_keystore_dir() -> Path:
    env_path = os.getenv("CARACAL_KEYSTORE_DIR")
    if env_path:
        return Path(env_path).expanduser().resolve(strict=False)

    # Prefer active workspace key directory under the new workspace structure.
    try:
        from caracal.flow.workspace import get_workspace

        return (get_workspace().keys_dir / "principals").expanduser().resolve(strict=False)
    except Exception:
        from caracal.storage.layout import get_caracal_layout

        return (get_caracal_layout().keystore_dir / "principals").expanduser().resolve(strict=False)


def _store_locally(principal_id: UUID, private_key_pem: str) -> PrincipalKeyStorageResult:
    key_path = get_local_private_key_path(principal_id)
    ensure_source_tree(key_path.parent)
    key_path.parent.mkdir(exist_ok=True)
    key_path.write_text(private_key_pem, encoding="utf-8")
    key_path.chmod(0o600)

    logger.info("Stored principal private key locally for %s at %s", principal_id, key_path)

    metadata = {
        "key_backend": _LOCAL_BACKEND,
        "private_key_ref": str(key_path),
        "key_updated_at": datetime.utcnow().isoformat(),
    }
    return PrincipalKeyStorageResult(backend=_LOCAL_BACKEND, reference=str(key_path), metadata=metadata)


def _store_in_aws_kms(principal_id: UUID, private_key_pem: str) -> Optional[PrincipalKeyStorageResult]:
    key_id = os.getenv("CARACAL_AWS_KMS_KEY_ID") or os.getenv("AWS_KMS_KEY_ID")
    region = os.getenv("CARACAL_AWS_KMS_REGION") or os.getenv("AWS_REGION")

    if not key_id:
        logger.warning("AWS KMS key ID not configured; set CARACAL_AWS_KMS_KEY_ID")
        return None

    try:
        import boto3  # type: ignore
    except Exception as exc:
        logger.warning("boto3 is not available for AWS KMS storage: %s", exc)
        return None

    try:
        session = boto3.session.Session(region_name=region) if region else boto3.session.Session()
        kms_client = session.client("kms")

        response = kms_client.encrypt(
            KeyId=key_id,
            Plaintext=private_key_pem.encode("utf-8"),
            EncryptionContext={"caracal:principal_id": str(principal_id)},
        )
        ciphertext = base64.b64encode(response["CiphertextBlob"]).decode("ascii")

        ref = f"aws-kms://{key_id}/principal/{principal_id}"
        logger.info("Stored principal private key in AWS KMS for %s using key %s", principal_id, key_id)

        metadata = {
            "key_backend": _AWS_KMS_BACKEND,
            "private_key_ref": ref,
            "aws_kms_key_id": key_id,
            "aws_kms_region": region or "",
            "aws_kms_ciphertext_b64": ciphertext,
            "key_updated_at": datetime.utcnow().isoformat(),
        }
        return PrincipalKeyStorageResult(backend=_AWS_KMS_BACKEND, reference=ref, metadata=metadata)
    except Exception as exc:
        logger.warning("AWS KMS key storage failed for principal %s: %s", principal_id, exc)
        return None
