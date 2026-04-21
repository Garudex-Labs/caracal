"""Shared session-facing protocol contracts."""

from __future__ import annotations

from datetime import datetime
from typing import Protocol


class SessionDenylistBackend(Protocol):
    """Async deny-list contract shared by session and revocation flows."""

    async def add(self, token_jti: str, expires_at: datetime) -> None:
        """Record token JTI with TTL."""

    async def contains(self, token_jti: str) -> bool:
        """Return True if token JTI is deny-listed."""

    async def mark_principal_revoked(
        self,
        principal_id: str,
        revoked_at: datetime,
    ) -> None:
        """Record principal-level session revocation cutoff."""

    async def is_principal_revoked(
        self,
        principal_id: str,
        token_auth_time: datetime | int | float | str | None,
    ) -> bool:
        """Return True when token auth time predates principal revocation cutoff."""
