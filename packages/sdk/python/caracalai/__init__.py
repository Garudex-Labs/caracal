"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Public surface of the Caracal Python SDK.
"""

from caracalai_oauth import (
    AccessDenied,
    ApprovalRequired,
    ApprovalState,
    CaracalError,
    CaracalEvent,
    CredentialsUnavailableError,
    DelegationRequired,
    EventHook,
    InvalidRequest,
    InvalidToken,
    MintedMandate,
    OperationNotPermitted,
    ResourceNotFound,
    ScopeInsufficient,
    ServiceUnavailable,
    ZoneMismatch,
)

from .client import (
    Caracal,
    FederatedSubject,
    GatewayTarget,
    ResourceBinding,
)
from .context import (
    AuthoritySummary,
    CaracalContext,
    VerifiedClaims,
    capture_context,
    describe_authority,
)
from .coordinator import DelegationConstraints, DelegationResponse
from .errors import CoordinatorError, MissingTokenError
from .json_types import JsonObject, JsonPrimitive, JsonValue
from .primitives import (
    Authority,
    Delegation,
    LifecycleHook,
    SessionHandle,
)

__all__ = [
    "ApprovalRequired",
    "ApprovalState",
    "AccessDenied",
    "CaracalError",
    "CoordinatorError",
    "CredentialsUnavailableError",
    "DelegationRequired",
    "InvalidRequest",
    "InvalidToken",
    "MintedMandate",
    "MissingTokenError",
    "OperationNotPermitted",
    "ResourceNotFound",
    "ScopeInsufficient",
    "ServiceUnavailable",
    "ZoneMismatch",
    "Caracal",
    "CaracalContext",
    "CaracalEvent",
    "EventHook",
    "AuthoritySummary",
    "VerifiedClaims",
    "capture_context",
    "describe_authority",
    "DelegationConstraints",
    "DelegationResponse",
    "GatewayTarget",
    "FederatedSubject",
    "Authority",
    "Delegation",
    "JsonObject",
    "JsonPrimitive",
    "JsonValue",
    "LifecycleHook",
    "ResourceBinding",
    "SessionHandle",
]
