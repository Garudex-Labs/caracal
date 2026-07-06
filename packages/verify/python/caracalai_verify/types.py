# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Transport-neutral types for MCP authentication: principal, error code, result.

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from caracalai_identity import Claims
from caracalai_revocation import RevocationStore

Principal = Claims

ErrorCode = Literal[
    "missing_token",
    "invalid_token",
    "invalid_zone",
    "insufficient_scope",
    "session_revoked",
    "delegation_stale",
    "agent_required",
    "delegation_required",
    "chain_mismatch",
    "hop_count_exceeded",
]


@dataclass(frozen=True)
class AuthError:
    code: ErrorCode
    description: str
    hint: str | None = None


@dataclass(frozen=True)
class AuthResult:
    principal: Principal | None
    error: AuthError | None

    @property
    def ok(self) -> bool:
        return self.error is None


@dataclass(frozen=True)
class AuthOptions:
    issuer: str
    audience: str
    revocations: RevocationStore
    # The zone is a mandatory trust anchor fixed at construction; it selects the
    # signing keyset and can never be steered by the unverified zone_id claim.
    expected_zone_id: str
    required_scopes: list[str] = field(default_factory=list)
    require_agent: bool = False
    require_delegation: bool = False
    require_chain_contains: list[str] = field(default_factory=list)
    max_hop_count: int | None = None
    required_targets: list[str] = field(default_factory=list)
    required_use: str | None = "resource"
