"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Gateway proxy module for Caracal Core v0.5.

This module provides network-enforced policy enforcement through:
- Authentication (mTLS, JWT, API keys)
- Request interception and forwarding
- Policy evaluation before API calls
- Replay protection
- Policy caching for degraded mode operation

Authority Enforcement (v0.5+):
- Pre-execution authority validation
- Mandate-based access control
- Gateway proxy for request interception
- Decorator and middleware patterns
- External API adapters
- Health check endpoints
"""

from caracal.gateway.auth import Authenticator, AuthenticationMethod
from caracal.gateway.replay_protection import (
    ReplayProtection,
    ReplayProtectionConfig,
    ReplayCheckResult,
)
from caracal.gateway.cache import (
    PolicyCache,
    PolicyCacheConfig,
    CachedPolicy,
    CacheStats,
)
from caracal.gateway.proxy import GatewayProxy, GatewayConfig
from caracal.gateway.authority_proxy import (
    AuthorityGatewayProxy,
    require_authority,
    AuthorityMiddleware,
    AuthorityAdapter,
    OpenAIAdapter,
    AnthropicAdapter,
    Request,
    Response,
)
from caracal.gateway.health_endpoints import (
    HealthEndpoints,
    create_flask_health_endpoint,
    create_fastapi_health_endpoint,
    HealthCheckWSGIApp,
    run_health_check_server,
)

__all__ = [
    "Authenticator",
    "AuthenticationMethod",
    "ReplayProtection",
    "ReplayProtectionConfig",
    "ReplayCheckResult",
    "PolicyCache",
    "PolicyCacheConfig",
    "CachedPolicy",
    "CacheStats",
    "GatewayProxy",
    "GatewayConfig",
    # Authority enforcement
    "AuthorityGatewayProxy",
    "require_authority",
    "AuthorityMiddleware",
    "AuthorityAdapter",
    "OpenAIAdapter",
    "AnthropicAdapter",
    "Request",
    "Response",
    # Health endpoints
    "HealthEndpoints",
    "create_flask_health_endpoint",
    "create_fastapi_health_endpoint",
    "HealthCheckWSGIApp",
    "run_health_check_server",
]
