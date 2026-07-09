"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Public surface of the Caracal Python SDK.
"""

from caracalai_oauth import (
    AccessDenied,
    ApprovalRequired,
    CaracalError,
    CaracalEvent,
    ClientCredentials,
    CredentialsResolver,
    CredentialsUnavailableError,
    DelegationRequired,
    EventHook,
    InvalidRequest,
    InvalidToken,
    OperationNotPermitted,
    ResourceNotFound,
    ScopeInsufficient,
    ServiceUnavailable,
    ZoneMismatch,
)

from .client import Caracal, CaracalConfig, GatewayRequest, ResourceBinding
from .context import (
    AuthoritySummary,
    CaracalContext,
    VerifiedClaims,
    abind,
    bind,
    capture_context,
    current,
    describe_authority,
)
from .coordinator import CoordinatorClient, DelegationConstraints, DelegationResponse
from .envelope import Envelope
from .errors import CoordinatorError, MissingTokenError
from .http import CaracalASGIMiddleware, TokenVerifier
from .json_types import JsonObject, JsonPrimitive, JsonValue
from .primitives import (
    Authority,
    Delegation,
    LifecycleHook,
    SessionHandle,
    accept_delegation,
)

__all__ = [
    "ApprovalRequired",
    "AccessDenied",
    "CaracalError",
    "ClientCredentials",
    "CoordinatorError",
    "CredentialsResolver",
    "CredentialsUnavailableError",
    "DelegationRequired",
    "InvalidRequest",
    "InvalidToken",
    "MissingTokenError",
    "OperationNotPermitted",
    "ResourceNotFound",
    "ScopeInsufficient",
    "ServiceUnavailable",
    "ZoneMismatch",
    "Caracal",
    "CaracalConfig",
    "CaracalContext",
    "CaracalEvent",
    "EventHook",
    "AuthoritySummary",
    "VerifiedClaims",
    "abind",
    "bind",
    "capture_context",
    "current",
    "describe_authority",
    "CaracalASGIMiddleware",
    "TokenVerifier",
    "CoordinatorClient",
    "DelegationConstraints",
    "DelegationResponse",
    "Envelope",
    "GatewayRequest",
    "Authority",
    "Delegation",
    "JsonObject",
    "JsonPrimitive",
    "JsonValue",
    "LifecycleHook",
    "ResourceBinding",
    "SessionHandle",
    "accept_delegation",
]
