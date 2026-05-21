# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# caracalai_identity — JWT verify, JWKS cache, scope evaluation, and claim shapes.

from .jwks import JwksCache
from .scope import has_scope
from .types import (
    MANDATE_USE_RESOURCE,
    MANDATE_USE_SESSION,
    SUBJECT_TYPE_APPLICATION,
    SUBJECT_TYPE_USER,
    ChainHop,
    Claims,
    JwtConfig,
)
from .verify import (
    AgentIdentityRequiredError,
    ChainMismatchError,
    DelegationRequiredError,
    HopCountExceededError,
    ScopeInsufficientError,
    TokenInvalidError,
    ZoneInvalidError,
    verify_chain_contains,
    verify_config,
    verify_token,
)

__all__ = [
    "AgentIdentityRequiredError",
    "ChainHop",
    "ChainMismatchError",
    "Claims",
    "DelegationRequiredError",
    "HopCountExceededError",
    "JwksCache",
    "JwtConfig",
    "MANDATE_USE_RESOURCE",
    "MANDATE_USE_SESSION",
    "SUBJECT_TYPE_APPLICATION",
    "SUBJECT_TYPE_USER",
    "ScopeInsufficientError",
    "TokenInvalidError",
    "ZoneInvalidError",
    "has_scope",
    "verify_chain_contains",
    "verify_config",
    "verify_token",
]
