"""Signing service abstraction for principal-bound token signing and verification."""

from __future__ import annotations

from typing import Any, Iterable

import jwt
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import serialization

from caracal.core.principal_keys import parse_vault_key_reference
from caracal.core.vault import get_vault, vault_access_context


class SigningServiceError(RuntimeError):
    """Base signing service error."""


class SigningServiceKeyError(SigningServiceError):
    """Raised when signing keys cannot be resolved or loaded."""


class SigningServiceExpiredToken(SigningServiceError):
    """Raised when verification fails due to token expiration."""


class SigningServiceInvalidToken(SigningServiceError):
    """Raised when verification fails due to token format/signature issues."""


class SigningService:
    """Centralized signer/verifier for principal-scoped JWT operations."""

    def __init__(self, principal_registry: Any) -> None:
        self._principal_registry = principal_registry

    def _resolve_signing_key_reference(self, principal_id: str) -> tuple[str, str, str]:
        if not hasattr(self._principal_registry, "get_signing_key_reference"):
            raise SigningServiceKeyError(
                "Principal registry does not implement get_signing_key_reference"
            )

        try:
            key_reference = self._principal_registry.get_signing_key_reference(str(principal_id))
        except Exception as exc:
            raise SigningServiceKeyError(
                f"Failed to resolve signing key reference for principal '{principal_id}': {exc}"
            ) from exc

        if not key_reference:
            raise SigningServiceKeyError(
                f"Principal '{principal_id}' has no resolvable signing key reference"
            )

        try:
            return parse_vault_key_reference(str(key_reference))
        except Exception as exc:
            raise SigningServiceKeyError(
                f"Failed to parse signing key reference for principal '{principal_id}': {exc}"
            ) from exc

    def _resolve_public_key(self, principal_id: str):
        principal = self._principal_registry.get_principal(str(principal_id))
        if principal is None:
            raise SigningServiceKeyError(f"Principal '{principal_id}' not found")

        public_key_pem = getattr(principal, "public_key", None)
        metadata = getattr(principal, "metadata", None)
        if not public_key_pem and isinstance(metadata, dict):
            public_key_pem = metadata.get("public_key_pem")

        if not public_key_pem:
            raise SigningServiceKeyError(f"Principal '{principal_id}' has no public key for verification")

        try:
            return serialization.load_pem_public_key(
                public_key_pem.encode() if isinstance(public_key_pem, str) else public_key_pem,
                backend=default_backend(),
            )
        except Exception as exc:
            raise SigningServiceKeyError(
                f"Failed to load public key for principal '{principal_id}': {exc}"
            ) from exc

    def sign_jwt_for_principal(
        self,
        *,
        principal_id: str,
        payload: dict[str, Any],
        headers: dict[str, Any],
        algorithm: str = "ES256",
    ) -> str:
        try:
            workspace_id, env_id, secret_name = self._resolve_signing_key_reference(principal_id)
            with vault_access_context():
                return get_vault().sign_jwt(
                    workspace_id=workspace_id,
                    env_id=env_id,
                    name=secret_name,
                    payload=payload,
                    headers=headers,
                    algorithm=algorithm,
                    actor=f"signing-service:{principal_id}",
                )
        except Exception as exc:
            if isinstance(exc, SigningServiceError):
                raise
            raise SigningServiceError(
                f"Failed to sign JWT for principal '{principal_id}': {exc}"
            ) from exc

    def sign_canonical_payload_for_principal(
        self,
        *,
        principal_id: str,
        payload: dict[str, Any],
    ) -> str:
        """Sign canonicalized payload with principal ECDSA-P256 private key.

        This preserves the historical detached-signature format used for
        execution mandates: SHA-256(canonical-json) bytes signed with
        ECDSA(SHA-256), returned as a hex string.
        """
        if not isinstance(payload, dict):
            raise SigningServiceError(f"payload must be a dictionary, got {type(payload)}")
        if not payload:
            raise SigningServiceError("payload cannot be empty")

        try:
            workspace_id, env_id, secret_name = self._resolve_signing_key_reference(principal_id)
            with vault_access_context():
                return get_vault().sign_canonical_payload(
                    workspace_id=workspace_id,
                    env_id=env_id,
                    name=secret_name,
                    payload=payload,
                    actor=f"signing-service:{principal_id}",
                )
        except Exception as exc:
            if isinstance(exc, SigningServiceError):
                raise
            raise SigningServiceError(
                f"Failed to sign canonical payload for principal '{principal_id}': {exc}"
            ) from exc

    def verify_jwt_for_principal(
        self,
        *,
        token: str,
        principal_id: str,
        audience: str,
        algorithms: Iterable[str],
    ) -> dict[str, Any]:
        public_key = self._resolve_public_key(principal_id)
        try:
            decoded = jwt.decode(
                token,
                public_key,
                algorithms=list(algorithms),
                audience=audience,
                options={"verify_exp": True},
            )
            if not isinstance(decoded, dict):
                raise SigningServiceInvalidToken("JWT payload is not an object")
            return decoded
        except jwt.ExpiredSignatureError as exc:
            raise SigningServiceExpiredToken("Token has expired") from exc
        except jwt.InvalidTokenError as exc:
            raise SigningServiceInvalidToken(f"Invalid token: {exc}") from exc


class VaultReferenceJwtSigner:
    """JWT signer backed by an opaque vault key reference."""

    def __init__(
        self,
        *,
        workspace_id: str,
        env_id: str,
        key_name: str,
        actor: str,
    ) -> None:
        self._workspace_id = str(workspace_id or "").strip()
        self._env_id = str(env_id or "").strip()
        self._key_name = str(key_name or "").strip()
        self._actor = str(actor or "signing-service").strip() or "signing-service"
        if not self._workspace_id or not self._env_id or not self._key_name:
            raise SigningServiceKeyError("Vault signer requires workspace_id, env_id, and key_name")

    def sign_token(
        self,
        *,
        claims: dict[str, Any],
        algorithm: str,
    ) -> str:
        try:
            with vault_access_context():
                return get_vault().sign_jwt(
                    workspace_id=self._workspace_id,
                    env_id=self._env_id,
                    name=self._key_name,
                    payload=claims,
                    headers={},
                    algorithm=algorithm,
                    actor=self._actor,
                )
        except Exception as exc:
            if isinstance(exc, SigningServiceError):
                raise
            raise SigningServiceError(
                f"Failed to sign JWT with vault reference '{self._workspace_id}/{self._env_id}/{self._key_name}': {exc}"
            ) from exc
