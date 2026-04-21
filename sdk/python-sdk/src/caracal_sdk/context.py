"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SDK Context & Scope Management.

Runtime SDK operations are tools-first and execute within an explicit
workspace scope context.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Dict, Optional

from caracal_sdk._compat import get_logger
from caracal_sdk.adapters.base import BaseAdapter
from caracal_sdk.hooks import HookRegistry, ScopeRef, StateSnapshot

if TYPE_CHECKING:
    from caracal_sdk.tools import ToolOperations

logger = get_logger(__name__)


class ScopeContext:
    """Scoped execution context bound to a workspace.

    All resource operations obtained from this context automatically
    include the correct scope headers on outbound requests.

    Args:
        adapter: Transport adapter to send requests.
        hooks: Lifecycle hook registry.
        workspace_id: Active workspace (optional).
    """

    def __init__(
        self,
        adapter: BaseAdapter,
        hooks: HookRegistry,
        workspace_id: Optional[str] = None,
    ) -> None:
        self._adapter = adapter
        self._hooks = hooks
        self.workspace_id = workspace_id

        # Lazy singletons
        self._tools: Optional[ToolOperations] = None

    # -- Scope headers (injected into every request) -----------------------

    def scope_headers(self) -> Dict[str, str]:
        """Return HTTP headers encoding the current scope."""
        headers: Dict[str, str] = {}
        if self.workspace_id:
            headers["X-Caracal-Workspace-ID"] = self.workspace_id
        return headers

    def to_scope_ref(self) -> ScopeRef:
        """Return a lightweight ScopeRef for hook callbacks."""
        return ScopeRef(
            workspace_id=self.workspace_id,
        )

    # -- Resource operation accessors (lazy) --------------------------------

    @property
    def tools(self) -> ToolOperations:
        if self._tools is None:
            from caracal_sdk.tools import ToolOperations

            self._tools = ToolOperations(scope=self)
        return self._tools


class ContextManager:
    """Manages scope checkout and context switching.

    Args:
        adapter: Transport adapter shared across all contexts.
        hooks: Lifecycle hook registry.
    """

    def __init__(self, adapter: BaseAdapter, hooks: HookRegistry) -> None:
        self._adapter = adapter
        self._hooks = hooks
        self._current: Optional[ScopeContext] = None

    @property
    def current(self) -> Optional[ScopeContext]:
        """Currently active scope context, or ``None``."""
        return self._current

    def checkout(
        self,
        workspace_id: Optional[str] = None,
    ) -> ScopeContext:
        """Activate a new scope context.

        Fires ``on_context_switch`` so extensions can react.

        Returns:
            A new :class:`ScopeContext` bound to the given scope.
        """
        old_ref = self._current.to_scope_ref() if self._current else None

        new_ctx = ScopeContext(
            adapter=self._adapter,
            hooks=self._hooks,
            workspace_id=workspace_id,
        )
        new_ref = new_ctx.to_scope_ref()

        self._current = new_ctx
        self._hooks.fire_context_switch(old_ref, new_ref)

        state = StateSnapshot(
            workspace_id=workspace_id,
        )
        self._hooks.fire_state_change(state)

        logger.info(f"Scope checked out: ws={workspace_id}")
        return new_ctx



