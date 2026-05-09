"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Advanced surface: low-level primitives, codec, ambient context plumbing, and
the raw coordinator client. Most integrators only need ``caracalai_sdk``;
reach for these when building a transport adapter or framework shim.
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
    try_current,
    with_overrides,
)
from .coordinator import (
    AgentKind,
    CoordinatorClient,
    DelegationRequest,
    DelegationResponse,
    SpawnRequest,
    SpawnResponse,
    create_delegation,
    spawn_agent,
    terminate_agent,
)
from .primitives import with_agent, with_delegation
from .client import Caracal, CaracalConfig
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
    "try_current",
    "bind",
    "abind",
    "with_overrides",
    "to_envelope",
    "from_envelope",
    "AgentKind",
    "CoordinatorClient",
    "SpawnRequest",
    "SpawnResponse",
    "DelegationRequest",
    "DelegationResponse",
    "spawn_agent",
    "terminate_agent",
    "create_delegation",
    "with_agent",
    "with_delegation",
    "Caracal",
    "CaracalConfig",
    "CaracalASGIMiddleware",
]
