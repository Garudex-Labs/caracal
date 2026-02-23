"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SDK Context & Scope Management.

Implements the Organization → Workspace → Project → Agent scope hierarchy.
All resource operations (agents, mandates, delegation, ledger) execute
within an explicit scope context.
"""

from __future__ import annotations

import warnings
from typing import TYPE_CHECKING, Any, Dict, Optional

from caracal.logging_config import get_logger
from caracal.sdk.adapters.base import BaseAdapter
from caracal.sdk.hooks import HookRegistry, ScopeRef, StateSnapshot

if TYPE_CHECKING:
    from caracal.sdk.agents import AgentOperations
    from caracal.sdk.delegation import DelegationOperations
    from caracal.sdk.ledger import LedgerOperations
    from caracal.sdk.mandates import MandateOperations

logger = get_logger(__name__)


class ScopeContext:
    """Scoped execution context bound to an Org/Workspace/Project.

    All resource operations obtained from this context automatically
    include the correct scope headers on outbound requests.

    Args:
        adapter: Transport adapter to send requests.
        hooks: Lifecycle hook registry.
        organization_id: Active organization (optional).
        workspace_id: Active workspace (optional).
        project_id: Active project (optional).
    """

    def __init__(
        self,
        adapter: BaseAdapter,
        hooks: HookRegistry,
        organization_id: Optional[str] = None,
        workspace_id: Optional[str] = None,
        project_id: Optional[str] = None,
    ) -> None:
        self._adapter = adapter
        self._hooks = hooks
        self.organization_id = organization_id
        self.workspace_id = workspace_id
        self.project_id = project_id

        # Lazy singletons
        self._agents: Optional[AgentOperations] = None
        self._mandates: Optional[MandateOperations] = None
        self._delegation: Optional[DelegationOperations] = None
        self._ledger: Optional[LedgerOperations] = None

    # -- Scope headers (injected into every request) -----------------------

    def scope_headers(self) -> Dict[str, str]:
        """Return HTTP headers encoding the current scope."""
        headers: Dict[str, str] = {}
        if self.organization_id:
            headers["X-Caracal-Org-ID"] = self.organization_id
        if self.workspace_id:
            headers["X-Caracal-Workspace-ID"] = self.workspace_id
        if self.project_id:
            headers["X-Caracal-Project-ID"] = self.project_id
        return headers

    def to_scope_ref(self) -> ScopeRef:
        """Return a lightweight ScopeRef for hook callbacks."""
        return ScopeRef(
            organization_id=self.organization_id,
            workspace_id=self.workspace_id,
            project_id=self.project_id,
        )

    # -- Resource operation accessors (lazy) --------------------------------

    @property
    def agents(self) -> AgentOperations:
        if self._agents is None:
            from caracal.sdk.agents import AgentOperations
            self._agents = AgentOperations(scope=self)
        return self._agents

    @property
    def mandates(self) -> MandateOperations:
        if self._mandates is None:
            from caracal.sdk.mandates import MandateOperations
            self._mandates = MandateOperations(scope=self)
        return self._mandates

    @property
    def delegation(self) -> DelegationOperations:
        if self._delegation is None:
            from caracal.sdk.delegation import DelegationOperations
            self._delegation = DelegationOperations(scope=self)
        return self._delegation

    @property
    def ledger(self) -> LedgerOperations:
        if self._ledger is None:
            from caracal.sdk.ledger import LedgerOperations
            self._ledger = LedgerOperations(scope=self)
        return self._ledger


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
        organization_id: Optional[str] = None,
        workspace_id: Optional[str] = None,
        project_id: Optional[str] = None,
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
            organization_id=organization_id,
            workspace_id=workspace_id,
            project_id=project_id,
        )
        new_ref = new_ctx.to_scope_ref()

        self._current = new_ctx
        self._hooks.fire_context_switch(old_ref, new_ref)

        state = StateSnapshot(
            organization_id=organization_id,
            workspace_id=workspace_id,
            project_id=project_id,
        )
        self._hooks.fire_state_change(state)

        logger.info(
            f"Scope checked out: org={organization_id} "
            f"ws={workspace_id} proj={project_id}"
        )
        return new_ctx



