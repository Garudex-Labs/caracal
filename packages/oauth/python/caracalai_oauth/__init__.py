"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Python OAuth token exchange client exports.
"""

from __future__ import annotations

from .cache import InMemoryTokenCache, TokenCache
from .client import OAuthClient
from .errors import (
    AccessDenied,
    ApprovalRequired,
    CaracalError,
    CredentialsUnavailableError,
    DelegationRequired,
    InvalidRequest,
    InvalidToken,
    OperationNotPermitted,
    ResourceNotFound,
    ScopeInsufficient,
    ServiceUnavailable,
    ZoneMismatch,
    raise_for_caracal_error,
)
from .events import CaracalEvent, EventHook, emit_event
from .exchanger import (
    ClientCredentials,
    ClientSecretExchanger,
    CredentialsResolver,
    TokenSource,
    decode_jwt_exp,
    decode_jwt_payload,
)
from .types import (
    APPROVAL_STATES,
    ApprovalState,
    ExchangeOptions,
    MintedMandate,
    TokenExchangeResponse,
)

__all__ = [
    "APPROVAL_STATES",
    "AccessDenied",
    "ApprovalRequired",
    "ApprovalState",
    "CaracalError",
    "CaracalEvent",
    "ClientCredentials",
    "ClientSecretExchanger",
    "CredentialsResolver",
    "CredentialsUnavailableError",
    "DelegationRequired",
    "EventHook",
    "ExchangeOptions",
    "InMemoryTokenCache",
    "InvalidRequest",
    "InvalidToken",
    "MintedMandate",
    "OAuthClient",
    "OperationNotPermitted",
    "ResourceNotFound",
    "ScopeInsufficient",
    "ServiceUnavailable",
    "TokenCache",
    "TokenExchangeResponse",
    "TokenSource",
    "ZoneMismatch",
    "decode_jwt_exp",
    "decode_jwt_payload",
    "emit_event",
    "raise_for_caracal_error",
]
