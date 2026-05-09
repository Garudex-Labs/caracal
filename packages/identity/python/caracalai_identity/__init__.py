# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# caracalai_identity — JWT verify, JWKS cache, scope evaluation, and claim shapes.

from .jwks import JwksCache
from .scope import has_scope
from .types import ChainHop, Claims, JwtConfig
from .verify import (
    AgentIdentityRequiredError,
    ChainMismatchError,
    DelegationRequiredError,
    ScopeInsufficientError,
    TokenInvalidError,
    ZoneInvalidError,
    verify,
    verify_chain_contains,
    verify_token,
)

__all__ = [
    "AgentIdentityRequiredError",
    "ChainHop",
    "ChainMismatchError",
    "Claims",
    "DelegationRequiredError",
    "JwksCache",
    "JwtConfig",
    "ScopeInsufficientError",
    "TokenInvalidError",
    "ZoneInvalidError",
    "has_scope",
    "verify",
    "verify_chain_contains",
    "verify_token",
]
