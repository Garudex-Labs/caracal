"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Advanced surface: low-level primitives, codec, bound context plumbing, and the raw coordinator client.
"""

from .envelope import (
    HEADER_AUTHORIZATION,
    HEADER_BAGGAGE,
    HEADER_TRACEPARENT,
    HEADER_TRACESTATE,
    BAGGAGE_AGENT_SESSION,
    BAGGAGE_DELEGATION_EDGE,
    BAGGAGE_HOP,
    BAGGAGE_PARENT_EDGE,
    BAGGAGE_SESSION,
    MAX_HOP,
    Envelope,
    Traceparent,
    decode_envelope,
    encode_envelope,
    encode_baggage,
    format_traceparent,
    from_headers,
    parse_baggage,
    parse_traceparent,
    to_headers,
)
from .context import (
    CaracalContext,
    AuthoritySummary,
    VerifiedClaims,
    abind,
    bind,
    capture_context,
    current,
    describe_authority,
    from_envelope,
    to_envelope,
    with_overrides,
)
from .coordinator import (
    Lifecycle,
    CoordinatorClient,
    DelegationConstraints,
    DelegationRequest,
    DelegationResponse,
    HeartbeatResponse,
    InboundDelegation,
    StartSessionRequest,
    StartSessionResponse,
    create_delegation,
    get_inbound_delegation,
    heartbeat_session,
    list_inbound_delegations,
    revoke_delegation,
    start_coordinator_session,
    terminate_session,
)
from .primitives import (
    Authority,
    Delegation,
    LifecycleHook,
    SessionHandle,
    attach_session,
    accept_delegation,
    delegate,
    session,
    start_session,
)
from caracalai_oauth import ClientCredentials, CredentialsResolver

from .client import (
    Caracal,
    CaracalConfig,
    ResourceBinding,
    _config_from_client_secret,
    _config_from_env,
    _config_from_file,
)
from .errors import CoordinatorError, MissingTokenError
from .http import CaracalASGIMiddleware

__all__ = [
    "HEADER_AUTHORIZATION",
    "HEADER_TRACEPARENT",
    "HEADER_TRACESTATE",
    "HEADER_BAGGAGE",
    "BAGGAGE_AGENT_SESSION",
    "BAGGAGE_DELEGATION_EDGE",
    "BAGGAGE_PARENT_EDGE",
    "BAGGAGE_SESSION",
    "BAGGAGE_HOP",
    "MAX_HOP",
    "Envelope",
    "Traceparent",
    "decode_envelope",
    "encode_envelope",
    "encode_baggage",
    "format_traceparent",
    "from_headers",
    "to_headers",
    "parse_baggage",
    "parse_traceparent",
    "CaracalContext",
    "AuthoritySummary",
    "VerifiedClaims",
    "current",
    "capture_context",
    "bind",
    "abind",
    "describe_authority",
    "with_overrides",
    "to_envelope",
    "from_envelope",
    "Lifecycle",
    "DelegationConstraints",
    "CoordinatorClient",
    "StartSessionRequest",
    "StartSessionResponse",
    "DelegationRequest",
    "DelegationResponse",
    "HeartbeatResponse",
    "InboundDelegation",
    "start_coordinator_session",
    "terminate_session",
    "heartbeat_session",
    "create_delegation",
    "get_inbound_delegation",
    "list_inbound_delegations",
    "revoke_delegation",
    "session",
    "start_session",
    "attach_session",
    "accept_delegation",
    "Authority",
    "Delegation",
    "SessionHandle",
    "delegate",
    "LifecycleHook",
    "Caracal",
    "CaracalConfig",
    "ResourceBinding",
    "CoordinatorError",
    "MissingTokenError",
    "CaracalASGIMiddleware",
    "ClientCredentials",
    "CredentialsResolver",
    "from_config",
    "from_credentials",
    "from_env",
]


def from_env(env) -> Caracal:
    """Build a client from only the supplied environment mapping."""
    return Caracal(_config_from_env(env))


def from_config(path, env=None) -> Caracal:
    """Build a client from one explicit profile and optional environment values."""
    return Caracal(_config_from_file(path, env))


def from_credentials(
    *,
    coordinator_url: str,
    sts_url: str,
    credentials: CredentialsResolver,
    resources=None,
    gateway_url=None,
    scope: str = "agent:lifecycle",
    default_ttl_seconds=None,
    http_client=None,
    coordinator_http_client=None,
) -> Caracal:
    """Build a client with a dynamic credential resolver."""
    return Caracal(
        _config_from_client_secret(
            coordinator_url=coordinator_url,
            sts_url=sts_url,
            credentials=credentials,
            resources=resources,
            gateway_url=gateway_url,
            scope=scope,
            default_ttl_seconds=default_ttl_seconds,
            http_client=http_client,
            coordinator_http_client=coordinator_http_client,
        )
    )
