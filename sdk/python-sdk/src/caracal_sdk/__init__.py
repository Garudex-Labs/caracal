"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal SDK — public API surface.

Quick start::

    from caracal_sdk import CaracalClient
    client = CaracalClient(api_key="sk_test_123")

Advanced::

    from caracal_sdk import CaracalBuilder
    client = CaracalBuilder().set_api_key("sk_prod").use(MyExtension()).build()
"""

from caracal_sdk._compat import get_version

__version__ = get_version()

# -- Core API (primary) -------------------------------------------------

from caracal_sdk.client import CaracalClient, CaracalBuilder, SDKConfigurationError
from caracal_sdk.authority_client import AuthorityClient
from caracal_sdk.context import ContextManager, ScopeContext
from caracal_sdk.hooks import HookRegistry, SDKRequest as _SDKRequest, SDKResponse as _SDKResponse
from caracal_sdk.extensions import CaracalExtension
from caracal_sdk.agents import AgentOperations
from caracal_sdk.mandates import MandateOperations
from caracal_sdk.delegation import DelegationOperations
from caracal_sdk.ledger import LedgerOperations
from caracal_sdk.tools import ToolOperations
from caracal_sdk.gateway import GatewayAdapter, GatewayAdapterError, build_gateway_adapter
import caracal_sdk.management as management
import caracal_sdk.migration as migration
import caracal_sdk.ais as ais
from caracal_sdk.adapters import (
    BaseAdapter,
    HttpAdapter,
    MockAdapter,
    WebSocketAdapter,
)



__all__ = [
    "__version__",
    # client
    "CaracalClient",
    "CaracalBuilder",
    "AuthorityClient",
    "AsyncAuthorityClient",
    "SDKConfigurationError",
    # context
    "ContextManager",
    "ScopeContext",
    # operations
    "AgentOperations",
    "MandateOperations",
    "DelegationOperations",
    "LedgerOperations",
    "ToolOperations",
    # infra
    "HookRegistry",
    "CaracalExtension",
    "BaseAdapter",
    "HttpAdapter",
    "MockAdapter",
    "WebSocketAdapter",
    # gateway
    "GatewayAdapter",
    "GatewayAdapterError",
    "build_gateway_adapter",
    # grouped surfaces
    "management",
    "migration",
    "ais",
]


def __getattr__(name: str):
    if name == "AsyncAuthorityClient":
        from caracal_sdk.async_authority_client import AsyncAuthorityClient

        return AsyncAuthorityClient
    raise AttributeError(f"module 'caracal_sdk' has no attribute {name!r}")
