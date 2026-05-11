"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Advanced surface: low-level primitives, codec, ambient context plumbing, and the raw coordinator client.
"""

from .envelope import (
    HEADER_AUTHORIZATION,
    HEADER_BAGGAGE,
    HEADER_TRACEPARENT,
    BAGGAGE_AGENT_SESSION,
    BAGGAGE_DELEGATION_EDGE,
    BAGGAGE_HOP,
    BAGGAGE_PARENT_EDGE,
    MAX_HOP,
    Envelope,
    decode_envelope,
    encode_envelope,
    encode_baggage,
    extract,
    format_traceparent,
    from_headers,
    inject,
    parse_baggage,
    parse_traceparent,
    to_headers,
)
from .context import (
    CaracalContext,
    abind,
    bind,
    current,
    from_envelope,
    to_envelope,
    with_overrides,
)
from .coordinator import (
    AgentKind,
    CoordinatorClient,
    DelegationConstraints,
    DelegationRequest,
    DelegationResponse,
    SpawnRequest,
    SpawnResponse,
    create_delegation,
    spawn_agent,
    terminate_agent,
)
from .primitives import LifecycleHook, delegate, spawn
from .client import Caracal, CaracalConfig, ResourceBinding
from .http import CaracalASGIMiddleware

__all__ = [
    "HEADER_AUTHORIZATION",
    "HEADER_TRACEPARENT",
    "HEADER_BAGGAGE",
    "BAGGAGE_AGENT_SESSION",
    "BAGGAGE_DELEGATION_EDGE",
    "BAGGAGE_PARENT_EDGE",
    "BAGGAGE_HOP",
    "MAX_HOP",
    "Envelope",
    "decode_envelope",
    "encode_envelope",
    "encode_baggage",
    "format_traceparent",
    "from_headers",
    "to_headers",
    "inject",
    "extract",
    "parse_baggage",
    "parse_traceparent",
    "CaracalContext",
    "current",
    "bind",
    "abind",
    "with_overrides",
    "to_envelope",
    "from_envelope",
    "AgentKind",
    "DelegationConstraints",
    "CoordinatorClient",
    "SpawnRequest",
    "SpawnResponse",
    "DelegationRequest",
    "DelegationResponse",
    "spawn_agent",
    "terminate_agent",
    "create_delegation",
    "spawn",
    "delegate",
    "LifecycleHook",
    "Caracal",
    "CaracalConfig",
    "ResourceBinding",
    "CaracalASGIMiddleware",
]
