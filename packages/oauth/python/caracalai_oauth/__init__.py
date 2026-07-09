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
)
from .types import ExchangeOptions, TokenExchangeResponse

__all__ = [
    "AccessDenied",
    "ApprovalRequired",
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
    "emit_event",
    "raise_for_caracal_error",
]
