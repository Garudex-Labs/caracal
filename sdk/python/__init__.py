"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal SDK — public API surface.

Quick start::

    from caracal.sdk import CaracalClient
    client = CaracalClient(api_key="sk_test_123")

Advanced::

    from caracal.sdk import CaracalBuilder
    client = CaracalBuilder().set_api_key("sk_prod").use(MyExtension()).build()
"""

__version__ = "0.2.0"

# -- New v2 API (primary) -------------------------------------------------

from caracal.sdk.client import CaracalClient, CaracalBuilder, SDKConfigurationError
from caracal.sdk.context import ContextManager, ScopeContext, BudgetCheckContext
from caracal.sdk.hooks import HookRegistry, SDKRequest as _SDKRequest, SDKResponse as _SDKResponse
from caracal.sdk.extensions import CaracalExtension
from caracal.sdk.agents import AgentOperations
from caracal.sdk.mandates import MandateOperations
from caracal.sdk.delegation import DelegationOperations
from caracal.sdk.ledger import LedgerOperations
from caracal.sdk.adapters import (
    BaseAdapter,
    HttpAdapter,
    MockAdapter,
    WebSocketAdapter,
)

# -- Legacy v0.1 exports (kept for backward compat) -----------------------

from caracal.sdk.authority_client import AuthorityClient
from caracal.sdk.async_authority_client import AsyncAuthorityClient

__all__ = [
    "__version__",
    # v2 — client
    "CaracalClient",
    "CaracalBuilder",
    "SDKConfigurationError",
    # v2 — context
    "ContextManager",
    "ScopeContext",
    # v2 — operations
    "AgentOperations",
    "MandateOperations",
    "DelegationOperations",
    "LedgerOperations",
    # v2 — infra
    "HookRegistry",
    "CaracalExtension",
    "BaseAdapter",
    "HttpAdapter",
    "MockAdapter",
    "WebSocketAdapter",
    # legacy (deprecated)
    "AuthorityClient",
    "AsyncAuthorityClient",
    "BudgetCheckContext",
]
