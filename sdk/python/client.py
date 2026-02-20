"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal SDK Client & Builder.

Provides two entry points to initialize the SDK:
    - ``CaracalClient(api_key=...)`` — quick start with sensible defaults
    - ``CaracalBuilder().set_api_key(...).use(...).build()`` — advanced config

Backward compatibility: Passing ``config_path=`` to ``CaracalClient``
delegates to the legacy v0.1 client with a deprecation warning.
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
# Legacy client (preserved for backward compatibility)
# ---------------------------------------------------------------------------

# Rename the existing v0.1 class so the new CaracalClient owns the name.
# Import is deferred to avoid pulling in heavy deps when they aren't needed.
_LEGACY_CLIENT_LOADED = False
_LegacyCaracalClientClass: Optional[type] = None


def _get_legacy_class() -> type:
    """Lazily import the v0.1 CaracalClient implementation."""
    global _LEGACY_CLIENT_LOADED, _LegacyCaracalClientClass
    if not _LEGACY_CLIENT_LOADED:
        # The original client.py content is preserved in _legacy_client.py
        # For backward compat we inline the legacy initialization logic here.
        _LEGACY_CLIENT_LOADED = True
        try:
            from caracal.config.settings import CaracalConfig, load_config
            from caracal.core.identity import AgentRegistry
            from caracal.core.ledger import LedgerQuery, LedgerWriter
            from caracal.core.metering import MeteringCollector

            class _LegacyClient:
                """Legacy v0.1 CaracalClient (config_path based)."""
                def __init__(self, config_path=None):
                    self.config = load_config(config_path)
                    from caracal.core.delegation import DelegationTokenManager
                    self.agent_registry = AgentRegistry(
                        registry_path=self.config.storage.agent_registry,
                        backup_count=self.config.storage.backup_count,
                        delegation_token_manager=None,
                    )
                    self.delegation_token_manager = DelegationTokenManager(
                        agent_registry=self.agent_registry
                    )
                    self.agent_registry.delegation_token_manager = self.delegation_token_manager
                    self.ledger_writer = LedgerWriter(
                        ledger_path=self.config.storage.ledger,
                        backup_count=self.config.storage.backup_count,
                    )
                    self.ledger_query = LedgerQuery(ledger_path=self.config.storage.ledger)
                    self.metering_collector = MeteringCollector(ledger_writer=self.ledger_writer)

            _LegacyCaracalClientClass = _LegacyClient
        except Exception:
            _LegacyCaracalClientClass = None
    return _LegacyCaracalClientClass  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# New CaracalClient (v2)
# ---------------------------------------------------------------------------

class CaracalClient:
    """SDK client for Caracal Core.

    Quick start::

        client = CaracalClient(api_key="sk_test_123")
        agents = await client.agents.list()

    Workspace-scoped::

        ctx = client.context.checkout(organization_id="org_1", workspace_id="ws_1")
        await ctx.mandates.create(agent_id="a1", allowed_operations=["read"], expires_in=3600)

    **Backward compatibility**: If ``config_path`` is passed instead of
    ``api_key``, the legacy v0.1 client is used with a deprecation warning.

    Args:
        api_key: API key for authentication.
        base_url: Root URL of the Caracal API. Defaults to ``http://localhost:8000``.
        adapter: Optional custom transport adapter (overrides base_url/api_key based default).
        config_path: **Deprecated** — v0.1 config file path.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: str = "http://localhost:8000",
        adapter: Optional[BaseAdapter] = None,
        config_path: Optional[str] = None,
    ) -> None:
        # -- Backward-compat path ------------------------------------------
        if config_path is not None:
            warnings.warn(
                "CaracalClient(config_path=...) is deprecated and will be removed "
                "in v0.4. Use CaracalClient(api_key=...) instead. "
                "See migration guide: https://garudexlabs.com/docs/migration/v0.1-to-v0.2",
                DeprecationWarning,
                stacklevel=2,
            )
            legacy_cls = _get_legacy_class()
            if legacy_cls is None:
                raise SDKConfigurationError(
                    "Legacy CaracalClient requires core storage modules. "
                    "Use CaracalClient(api_key=...) instead."
                )
            self._legacy = legacy_cls(config_path=config_path)
            self._is_legacy = True
            return

        # -- New v2 path ---------------------------------------------------
        self._is_legacy = False
        self._legacy = None

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
        logger.info("CaracalClient initialized (v2)")

    # -- Extension registration --------------------------------------------

    def use(self, extension: CaracalExtension) -> CaracalClient:
        """Register an extension plugin.

        Args:
            extension: Extension implementing :class:`CaracalExtension`.

        Returns:
            ``self`` for method chaining.
        """
        if self._is_legacy:
            raise SDKConfigurationError(
                "Extensions are not supported in legacy mode. "
                "Use CaracalClient(api_key=...) instead."
            )
        extension.install(self._hooks)
        self._extensions.append(extension)
        logger.info(f"Extension installed: {extension.name} v{extension.version}")
        return self

    # -- Resource accessors (default scope) --------------------------------

    @property
    def context(self) -> ContextManager:
        """Context manager for scope checkout."""
        if self._is_legacy:
            raise SDKConfigurationError(
                "Context management is not available in legacy mode."
            )
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
        if not self._is_legacy and self._adapter:
            self._adapter.close()
            logger.info("CaracalClient closed")

    # -- Legacy proxy methods (for backward compat) ------------------------

    def emit_event(self, *args: Any, **kwargs: Any) -> None:
        """**Deprecated** — proxy to legacy client's emit_event."""
        if self._is_legacy and self._legacy:
            return self._legacy.emit_event(*args, **kwargs)
        raise SDKConfigurationError(
            "emit_event() is a legacy method. Use mandates or metering APIs."
        )

    def create_child_agent(self, *args: Any, **kwargs: Any) -> Any:
        """**Deprecated** — proxy to legacy client's create_child_agent."""
        if self._is_legacy and self._legacy:
            return self._legacy.create_child_agent(*args, **kwargs)
        raise SDKConfigurationError(
            "create_child_agent() is a legacy method. Use client.agents.create_child()."
        )

    def get_delegation_token(self, *args: Any, **kwargs: Any) -> Any:
        """**Deprecated** — proxy to legacy client's get_delegation_token."""
        if self._is_legacy and self._legacy:
            return self._legacy.get_delegation_token(*args, **kwargs)
        raise SDKConfigurationError(
            "get_delegation_token() is a legacy method. Use client.delegation.get_token()."
        )


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
