"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Public surface of the Caracal Python SDK.
"""

from .auth import ApprovalRequired
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
from .coordinator import CoordinatorClient, DelegationConstraints
from .envelope import Envelope
from .errors import (
    AccessDenied,
    CaracalError,
    DelegationRequired,
    InvalidRequest,
    InvalidToken,
    MissingTokenError,
    OperationNotPermitted,
    ResourceNotFound,
    ScopeInsufficient,
    ServiceUnavailable,
    ZoneMismatch,
)
from .http import CaracalASGIMiddleware, TokenVerifier
from .json_types import JsonObject, JsonPrimitive, JsonValue
from .primitives import Grant, LifecycleHook, ServiceAgent

__all__ = [
    "ApprovalRequired",
    "AccessDenied",
    "CaracalError",
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
    "Envelope",
    "GatewayRequest",
    "Grant",
    "JsonObject",
    "JsonPrimitive",
    "JsonValue",
    "LifecycleHook",
    "ResourceBinding",
    "ServiceAgent",
]
