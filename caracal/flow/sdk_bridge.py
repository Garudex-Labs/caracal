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
    - Registered tool invocation via MCP service
    - Context switching between workspaces

    Usage in Flow::

        from caracal.flow.sdk_bridge import SDKBridge

        bridge = SDKBridge(api_key="sk_test_123")
        ctx = bridge.checkout(workspace_id="ws_default")
        result = await bridge.call_tool(
            tool_id="provider:demo:resource:jobs:action:run",
            mandate_id="<mandate-id>",
        )
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
    ) -> None:
        resolved_base_url = base_url or os.environ.get(
            "CARACAL_API_URL",
            f"http://localhost:{os.environ.get('CARACAL_API_PORT', '8080')}",
        )
        resolved_api_key = api_key or os.environ.get("CARACAL_API_KEY")
        self._client = CaracalClient(
            api_key=resolved_api_key,
            base_url=resolved_base_url,
        )
        self._scope: Optional[ScopeContext] = None

        logger.info("SDKBridge initialized")

    @property
    def context(self) -> ContextManager:
        """Access the context manager for scope switching."""
        return self._client.context

    def checkout(
        self,
        workspace_id: Optional[str] = None,
    ) -> ScopeContext:
        """Activate a workspace scope for the TUI session."""
        self._scope = self._client.context.checkout(
            workspace_id=workspace_id,
        )
        logger.info(f"TUI scope changed: ws={workspace_id}")
        return self._scope

    @property
    def current_scope(self) -> Optional[ScopeContext]:
        """Currently active scope, if any."""
        return self._scope

    async def call_tool(
        self,
        tool_id: str,
        mandate_id: str,
        tool_args: Optional[dict] = None,
        metadata: Optional[dict] = None,
        correlation_id: Optional[str] = None,
    ):
        """Call a registered MCP tool through the canonical SDK tool API."""
        scope = self._scope or self._get_default_scope()
        return await scope.tools.call(
            tool_id=tool_id,
            mandate_id=mandate_id,
            tool_args=tool_args,
            metadata=metadata,
            correlation_id=correlation_id,
        )

    # -- Internal -----------------------------------------------------------

    def _get_default_scope(self) -> ScopeContext:
        """Fall back to default (unscoped) context."""
        return self._client._default_scope

    def close(self) -> None:
        """Release resources."""
        self._client.close()
        logger.info("SDKBridge closed")
