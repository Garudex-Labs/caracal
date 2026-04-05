"""Signing service abstraction for principal-bound token signing and verification."""

from __future__ import annotations

from typing import Any, Iterable

import jwt
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import serialization


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

    def _resolve_private_key(self, principal_id: str):
        if not hasattr(self._principal_registry, "resolve_private_key"):
            raise SigningServiceKeyError("Principal registry does not implement resolve_private_key")

        try:
            private_key_pem = self._principal_registry.resolve_private_key(str(principal_id))
        except Exception as exc:
            raise SigningServiceKeyError(
                f"Failed to resolve private key for principal '{principal_id}': {exc}"
            ) from exc

        if not private_key_pem:
            raise SigningServiceKeyError(f"Principal '{principal_id}' has no resolvable private key")

        try:
            return serialization.load_pem_private_key(
                private_key_pem.encode() if isinstance(private_key_pem, str) else private_key_pem,
                password=None,
                backend=default_backend(),
            )
        except Exception as exc:
            raise SigningServiceKeyError(
                f"Failed to load private key for principal '{principal_id}': {exc}"
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
        private_key = self._resolve_private_key(principal_id)
        try:
            return jwt.encode(payload, private_key, algorithm=algorithm, headers=headers)
        except Exception as exc:
            raise SigningServiceError(
                f"Failed to sign JWT for principal '{principal_id}': {exc}"
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
