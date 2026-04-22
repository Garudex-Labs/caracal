"""Attestation nonce issuance and one-time consumption semantics."""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

from caracal.redis.client import RedisClient


class AttestationNonceValidationError(RuntimeError):
    """Raised when attestation nonce lifecycle constraints are violated."""


class AttestationNonceConsumedError(AttestationNonceValidationError):
    """Raised when nonce cannot be consumed because it is missing/expired/used."""


@dataclass(frozen=True)
class IssuedAttestationNonce:
    """Metadata returned when minting a new nonce."""

    nonce: str
    principal_id: str
    expires_at: datetime


class AttestationNonceManager:
    """Issues and consumes single-use nonce values backed by Redis."""

    _NONCE_PREFIX = "caracal:identity:attestation_nonce"

    def __init__(
        self,
        redis_client: RedisClient,
        *,
        ttl_seconds: int = 300,
    ) -> None:
        if ttl_seconds <= 0:
            raise AttestationNonceValidationError("ttl_seconds must be greater than zero")
        self._redis = redis_client
        self._ttl_seconds = int(ttl_seconds)

    def _key(self, nonce: str) -> str:
        return f"{self._NONCE_PREFIX}:{nonce}"

    @property
    def ttl_seconds(self) -> int:
        """Configured nonce lifetime in seconds."""
        return self._ttl_seconds

    @staticmethod
    def _normalize_principal_id(principal_id: str) -> str:
        normalized = str(principal_id or "").strip()
        if not normalized:
            raise AttestationNonceValidationError("principal_id cannot be empty")
        return normalized

    def issue_nonce(self, principal_id: str) -> IssuedAttestationNonce:
        """Issue a fresh nonce bound to principal_id with TTL."""
        normalized_principal = self._normalize_principal_id(principal_id)

        # Extremely low collision probability; bounded retries for defensive NX semantics.
        for _ in range(5):
            nonce = secrets.token_urlsafe(32)
            key = self._key(nonce)
            created = self._redis.set(key, normalized_principal, ex=self._ttl_seconds, nx=True)
            if created:
                expires_at = datetime.now(timezone.utc) + timedelta(seconds=self._ttl_seconds)
                return IssuedAttestationNonce(
                    nonce=nonce,
                    principal_id=normalized_principal,
                    expires_at=expires_at,
                )

        raise AttestationNonceValidationError("failed to allocate unique attestation nonce")

    def revoke_nonce(self, nonce: str) -> None:
        """Best-effort cleanup for a nonce issued during a failed spawn transaction."""
        normalized_nonce = str(nonce or "").strip()
        if not normalized_nonce:
            return
        self._redis.delete(self._key(normalized_nonce))

    def consume_nonce(self, nonce: str, *, expected_principal_id: Optional[str] = None) -> str:
        """Consume nonce exactly once and return the bound principal_id.

        Consumption is atomic via Redis GETDEL semantics.
        """
        normalized_nonce = str(nonce or "").strip()
        if not normalized_nonce:
            raise AttestationNonceValidationError("nonce cannot be empty")

        consumed_principal = self._redis.getdel(self._key(normalized_nonce))
        if consumed_principal is None:
            raise AttestationNonceConsumedError(
                "attestation nonce is missing, expired, or already consumed"
            )

        consumed_principal_id = self._normalize_principal_id(consumed_principal)

        if expected_principal_id is not None:
            normalized_expected = self._normalize_principal_id(expected_principal_id)
            if consumed_principal_id != normalized_expected:
                raise AttestationNonceValidationError(
                    "attestation nonce principal binding mismatch"
                )

        return consumed_principal_id
