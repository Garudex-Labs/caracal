"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

OAuth token exchange types and errors.
"""

from __future__ import annotations

from dataclasses import dataclass, field


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


class InteractionRequiredError(Exception):
    def __init__(
        self,
        message: str,
        challenge_id: str,
        resource: str,
        acr_values: str | None = None,
        binding: str | None = None,
        expires_at: str | None = None,
    ) -> None:
        super().__init__(message)
        self.challenge_id = challenge_id
        self.resource = resource
        self.acr_values = acr_values
        self.binding = binding
        self.expires_at = expires_at
