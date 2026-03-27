"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

TUI ↔ SDK Bridge.

Connects Caracal Flow (TUI) to the redesigned SDK client.
Replaces direct core imports with SDK-mediated operations.
"""

from __future__ import annotations

import os
from typing import Optional

from caracal.logging_config import get_logger
from caracal_sdk.client import CaracalClient
from caracal_sdk.context import ContextManager, ScopeContext

logger = get_logger(__name__)


class SDKBridge:
    """Bridge between Caracal Flow TUI and the SDK client.

    Manages an SDK client instance and exposes a simplified interface
    for TUI operations:
    - Agent listing and creation
    - Mandate management
    - Context switching between workspaces
    - Ledger queries

    Usage in Flow::

        from caracal.flow.sdk_bridge import SDKBridge

        bridge = SDKBridge(api_key="sk_test_123")
        ctx = bridge.checkout(workspace_id="ws_default")
        agents = await bridge.list_agents()
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        config_path: Optional[str] = None,
    ) -> None:
        if config_path:
            # Legacy mode — backward compat with existing TUI config
            self._client = CaracalClient(config_path=config_path)
            self._scope: Optional[ScopeContext] = None
        else:
            resolved_base_url = base_url or os.environ.get("CARACAL_API_URL", "http://localhost:8000")
            self._client = CaracalClient(
                api_key=api_key,
                base_url=resolved_base_url,
            )
            self._scope = None

        logger.info("SDKBridge initialized")

    @property
    def context(self) -> ContextManager:
        """Access the context manager for scope switching."""
        return self._client.context

    def checkout(
        self,
        organization_id: Optional[str] = None,
        workspace_id: Optional[str] = None,
        project_id: Optional[str] = None,
    ) -> ScopeContext:
        """Activate a workspace scope for the TUI session."""
        self._scope = self._client.context.checkout(
            organization_id=organization_id,
            workspace_id=workspace_id,
            project_id=project_id,
        )
        logger.info(f"TUI scope changed: ws={workspace_id}")
        return self._scope

    @property
    def current_scope(self) -> Optional[ScopeContext]:
        """Currently active scope, if any."""
        return self._scope

    # -- Agent operations (convenience wrappers) ----------------------------

    async def list_agents(self, limit: int = 100):
        """List agents in the current scope."""
        scope = self._scope or self._get_default_scope()
        return await scope.agents.list(limit=limit)

    async def create_principal(self, name: str, owner: str, metadata=None):
        """Create an agent in the current scope."""
        scope = self._scope or self._get_default_scope()
        return await scope.agents.create(name=name, owner=owner, metadata=metadata)

    # -- Mandate operations (convenience wrappers) --------------------------

    async def create_mandate(
        self,
        principal_id: str,
        allowed_operations: list,
        expires_in: int = 3600,
    ):
        """Create a mandate in the current scope."""
        scope = self._scope or self._get_default_scope()
        return await scope.mandates.create(
            principal_id=principal_id,
            allowed_operations=allowed_operations,
            expires_in=expires_in,
        )

    async def validate_mandate(
        self,
        mandate_id: str,
        requested_action: str,
        requested_resource: str,
    ):
        """Validate a mandate in the current scope."""
        scope = self._scope or self._get_default_scope()
        return await scope.mandates.validate(
            mandate_id=mandate_id,
            requested_action=requested_action,
            requested_resource=requested_resource,
        )

    # -- Ledger operations (convenience wrappers) ---------------------------

    async def query_ledger(self, principal_id: Optional[str] = None, limit: int = 100):
        """Query the ledger in the current scope."""
        scope = self._scope or self._get_default_scope()
        return await scope.ledger.query(principal_id=principal_id, limit=limit)

    # -- Internal -----------------------------------------------------------

    def _get_default_scope(self) -> ScopeContext:
        """Fall back to default (unscoped) context."""
        return self._client._default_scope

    def close(self) -> None:
        """Release resources."""
        self._client.close()
        logger.info("SDKBridge closed")
