# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Caracal JWT claim shapes and verification configuration types.

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class JwtConfig:
    issuer: str
    audience: str
    expected_zone_id: str | None = None
    required_scopes: list[str] = field(default_factory=list)


@dataclass
class Claims:
    sub: str
    zone_id: str
    sid: str
    scope: str
    agent_session_id: str | None = None
