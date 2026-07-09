"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

OAuth token exchange types and errors.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

ApprovalState = Literal["pending", "approved", "rejected", "expired", "consumed"]
"""Lifecycle state of an approval challenge. ``approved`` means a retry of the
held mint with the challenge id will succeed; ``rejected`` and ``expired`` are
terminal; ``consumed`` means another request already spent the approval;
``pending`` means no decision arrived within the wait and polling again is safe."""

APPROVAL_STATES: frozenset[str] = frozenset(
    ("pending", "approved", "rejected", "expired", "consumed")
)


@dataclass(frozen=True)
class TokenExchangeResponse:
    access_token: str
    token_type: str
    expires_in: int
    issued_at: int


@dataclass(frozen=True)
class ExchangeOptions:
    client_secret: str | None = None
    client_assertion: str | None = None
    client_assertion_type: str | None = None
    actor_token: str | None = None
    session_id: str | None = None
    agent_session_id: str | None = None
    delegation_edge_id: str | None = None
    challenge_id: str | None = None
    scopes: list[str] = field(default_factory=list)
    timeout_ms: int = 30_000
    retries: int = 3
    ttl_seconds: int | None = None
