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
from uuid import UUID

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

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


def generate_and_store_principal_keypair(principal_id: UUID) -> PrincipalKeypairResult:
    """Generate an ECDSA P-256 keypair and store private key via configured backend."""
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

    storage = store_principal_private_key(principal_id=principal_id, private_key_pem=private_pem)
    return PrincipalKeypairResult(public_key_pem=public_pem, storage=storage)


def store_principal_private_key(principal_id: UUID, private_key_pem: str) -> PrincipalKeyStorageResult:
    """Store a principal private key using configured backend.

    Backend selection:
    - local (default)
    - aws_kms (requires CARACAL_AWS_KMS_KEY_ID and boto3)
    """
    backend = os.getenv("CARACAL_PRINCIPAL_KEY_BACKEND", _LOCAL_BACKEND).strip().lower()
    strict_aws = os.getenv("CARACAL_PRINCIPAL_KEY_STRICT_AWS", "false").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }

    if backend not in {_LOCAL_BACKEND, _AWS_KMS_BACKEND}:
        raise PrincipalKeyStorageError(
            "Unsupported CARACAL_PRINCIPAL_KEY_BACKEND value: "
            f"{backend!r}. Expected '{_LOCAL_BACKEND}' or '{_AWS_KMS_BACKEND}'."
        )

    if backend == _AWS_KMS_BACKEND:
        kms_result = _store_in_aws_kms(principal_id=principal_id, private_key_pem=private_key_pem)
        if kms_result is not None:
            return kms_result
        if strict_aws:
            raise PrincipalKeyStorageError(
                "AWS KMS backend is configured but key storage failed and "
                "CARACAL_PRINCIPAL_KEY_STRICT_AWS is enabled."
            )
        logger.warning("Falling back to local key storage for principal %s", principal_id)

    return _store_locally(principal_id=principal_id, private_key_pem=private_key_pem)


def resolve_principal_private_key(
    principal_id: UUID,
    principal_metadata: Optional[Mapping[str, object]],
) -> str:
    """Resolve a principal private key PEM from metadata-backed storage references.

    Backward compatibility:
    - If ``private_key_pem`` exists in metadata, it is returned as-is.

    Preferred path:
    - ``key_backend=local`` resolves ``private_key_ref`` as a local file path.
    - ``key_backend=aws_kms`` decrypts ``aws_kms_ciphertext_b64`` via AWS KMS.
    """
    metadata = dict(principal_metadata or {})

    legacy_private_key = metadata.get("private_key_pem")
    if isinstance(legacy_private_key, str) and legacy_private_key.strip():
        return legacy_private_key

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
        return (Path.home() / ".caracal" / "keystore").expanduser().resolve(strict=False)


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
