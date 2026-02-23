"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal SDK Client & Builder.

Provides two entry points to initialize the SDK:
    - ``CaracalClient(api_key=...)`` — quick start with sensible defaults
    - ``CaracalBuilder().set_api_key(...).use(...).build()`` — advanced config

"""

from __future__ import annotations

import warnings
from typing import Any, List, Optional

from caracal.logging_config import get_logger
from caracal.sdk.adapters.base import BaseAdapter
from caracal.sdk.adapters.http import HttpAdapter
from caracal.sdk.context import ContextManager, ScopeContext
from caracal.sdk.extensions import CaracalExtension
from caracal.sdk.hooks import HookRegistry
from caracal.exceptions import SDKConfigurationError

logger = get_logger(__name__)




# ---------------------------------------------------------------------------
# CaracalClient
# ---------------------------------------------------------------------------

class CaracalClient:
    """SDK client for Caracal Core.

    Quick start::

        client = CaracalClient(api_key="sk_test_123")
        agents = await client.agents.list()

    Workspace-scoped::

        ctx = client.context.checkout(organization_id="org_1", workspace_id="ws_1")
        await ctx.mandates.create(agent_id="a1", allowed_operations=["read"], expires_in=3600)

    Args:
        api_key: API key for authentication.
        base_url: Root URL of the Caracal API. Defaults to ``http://localhost:8000``.
        adapter: Optional custom transport adapter (overrides base_url/api_key based default).

    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: str = "http://localhost:8000",
        adapter: Optional[BaseAdapter] = None,
    ) -> None:
        # -- Core Initialization -------------------------------------------

        if api_key is None and adapter is None:
            raise SDKConfigurationError(
                "CaracalClient requires either api_key or a custom adapter."
            )

        self._hooks = HookRegistry()
        self._adapter = adapter or HttpAdapter(
            base_url=base_url,
            api_key=api_key,
        )
        self._context_manager = ContextManager(
            adapter=self._adapter, hooks=self._hooks
        )

        # Default scope (no org/workspace filter)
        self._default_scope = ScopeContext(
            adapter=self._adapter, hooks=self._hooks
        )

        self._extensions: List[CaracalExtension] = []
        logger.info("CaracalClient initialized")

    # -- Extension registration --------------------------------------------

    def use(self, extension: CaracalExtension) -> CaracalClient:
        """Register an extension plugin.

        Args:
            extension: Extension implementing :class:`CaracalExtension`.

        Returns:
            ``self`` for method chaining.
        """

        extension.install(self._hooks)
        self._extensions.append(extension)
        logger.info(f"Extension installed: {extension.name} v{extension.version}")
        return self

    # -- Resource accessors (default scope) --------------------------------

    @property
    def context(self) -> ContextManager:
        """Context manager for scope checkout."""
        return self._context_manager

    @property
    def agents(self):
        """Agent operations in the default (unscoped) context."""
        return self._default_scope.agents

    @property
    def mandates(self):
        """Mandate operations in the default (unscoped) context."""
        return self._default_scope.mandates

    @property
    def delegation(self):
        """Delegation operations in the default (unscoped) context."""
        return self._default_scope.delegation

    @property
    def ledger(self):
        """Ledger operations in the default (unscoped) context."""
        return self._default_scope.ledger

    # -- Lifecycle ---------------------------------------------------------

    def close(self) -> None:
        """Release all resources."""
        if self._adapter:
            self._adapter.close()
            logger.info("CaracalClient closed")



# ---------------------------------------------------------------------------
# CaracalBuilder (advanced initialization)
# ---------------------------------------------------------------------------

class CaracalBuilder:
    """Fluent builder for advanced CaracalClient configuration.

    Example::

        client = (
            CaracalBuilder()
            .set_api_key("sk_prod_123")
            .set_base_url("https://api.caracal.io")
            .set_transport(WebSocketAdapter(url="wss://..."))
            .use(ComplianceExtension(standard="soc2"))
            .build()
        )
    """

    def __init__(self) -> None:
        self._api_key: Optional[str] = None
        self._base_url: str = "http://localhost:8000"
        self._adapter: Optional[BaseAdapter] = None
        self._extensions: List[CaracalExtension] = []

    def set_api_key(self, key: str) -> CaracalBuilder:
        """Set the API key."""
        self._api_key = key
        return self

    def set_base_url(self, url: str) -> CaracalBuilder:
        """Set the Caracal API base URL."""
        self._base_url = url
        return self

    def set_transport(self, adapter: BaseAdapter) -> CaracalBuilder:
        """Override the default HTTP adapter with a custom transport."""
        self._adapter = adapter
        return self

    def use(self, extension: CaracalExtension) -> CaracalBuilder:
        """Queue an extension for installation after build."""
        self._extensions.append(extension)
        return self

    def build(self) -> CaracalClient:
        """Construct the CaracalClient and install all queued extensions.

        Raises:
            SDKConfigurationError: If api_key is missing and no adapter provided.
        """
        if self._api_key is None and self._adapter is None:
            raise SDKConfigurationError(
                "CaracalBuilder.build() requires either set_api_key() or set_transport()."
            )

        client = CaracalClient(
            api_key=self._api_key,
            base_url=self._base_url,
            adapter=self._adapter,
        )

        for ext in self._extensions:
            client.use(ext)

        # Fire initialize hooks after all extensions are installed
        client._hooks.fire_initialize()

        logger.info(
            f"CaracalBuilder: built client with {len(self._extensions)} extension(s)"
        )
        return client
