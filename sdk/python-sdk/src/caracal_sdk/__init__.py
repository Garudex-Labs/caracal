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

import caracal_sdk.ais as ais
from caracal_sdk.adapters import (
    BaseAdapter,
    HttpAdapter,
    MockAdapter,
    WebSocketAdapter,
)
from caracal_sdk.client import CaracalBuilder, CaracalClient, SDKConfigurationError
from caracal_sdk.context import ContextManager, ScopeContext
from caracal_sdk.extensions import CaracalExtension
from caracal_sdk.gateway import GatewayAdapter, GatewayAdapterError, build_gateway_adapter
from caracal_sdk.hooks import HookRegistry
from caracal_sdk.tools import ToolOperations

__all__ = [
    "__version__",
    # client
    "CaracalClient",
    "CaracalBuilder",
    "SDKConfigurationError",
    # context
    "ContextManager",
    "ScopeContext",
    # operations
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
    "ais",
]
