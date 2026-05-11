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
    require_agent: bool = False
    require_delegation: bool = False
    require_chain_contains: list[str] = field(default_factory=list)
    max_hop_count: int | None = None


@dataclass
class ChainHop:
    application_id: str
    agent_session_id: str | None = None
    delegation_edge_id: str | None = None


@dataclass
class Claims:
    sub: str
    zone_id: str
    client_id: str
    sid: str
    scope: str
    agent_session_id: str | None = None
    delegation_edge_id: str | None = None
    source_session_id: str | None = None
    target_session_id: str | None = None
    delegation_path: list[str] = field(default_factory=list)
    delegation_chain: list[ChainHop] = field(default_factory=list)
    graph_epoch: int | None = None
    hop_count: int | None = None
