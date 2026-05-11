# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Transport-neutral types for MCP authentication: principal, error code, result.

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from caracalai_identity import Claims

Principal = Claims

ErrorCode = Literal[
    "missing_token",
    "invalid_token",
    "invalid_zone",
    "insufficient_scope",
    "session_revoked",
    "agent_required",
    "delegation_required",
    "chain_mismatch",
]


@dataclass(frozen=True)
class AuthError:
    code: ErrorCode
    description: str


@dataclass(frozen=True)
class AuthResult:
    principal: Principal | None
    error: AuthError | None

    @property
    def ok(self) -> bool:
        return self.error is None
