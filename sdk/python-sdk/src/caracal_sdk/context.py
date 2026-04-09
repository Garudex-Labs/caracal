"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SDK Context & Scope Management.

Implements the Organization → Workspace → Project scope hierarchy.
All resource operations (principals, mandates, delegation, ledger) execute
within an explicit scope context.
"""

from __future__ import annotations

import warnings
from typing import TYPE_CHECKING, Any, Dict, Optional

from caracal_sdk._compat import get_logger
from caracal_sdk.adapters.base import BaseAdapter
from caracal_sdk.hooks import HookRegistry, ScopeRef, StateSnapshot

if TYPE_CHECKING:
    from caracal_sdk.agents import AgentOperations
    from caracal_sdk.agents import PrincipalOperations
    from caracal_sdk.delegation import DelegationOperations
    from caracal_sdk.ledger import LedgerOperations
    from caracal_sdk.mandates import MandateOperations
    from caracal_sdk.tools import ToolOperations

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
        self._principals: Optional[PrincipalOperations] = None
        self._agents_alias_warned = False
        self._mandates: Optional[MandateOperations] = None
        self._delegation: Optional[DelegationOperations] = None
        self._ledger: Optional[LedgerOperations] = None
        self._tools: Optional[ToolOperations] = None

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
    def principals(self) -> PrincipalOperations:
        if self._principals is None:
            from caracal_sdk.agents import PrincipalOperations

            self._principals = PrincipalOperations(scope=self)
        return self._principals

    @property
    def agents(self) -> AgentOperations:
        if not self._agents_alias_warned:
            warnings.warn(
                "ScopeContext.agents is deprecated; use ScopeContext.principals. "
                "'agents' represent principal identities (for example orchestrator/worker).",
                DeprecationWarning,
                stacklevel=2,
            )
            self._agents_alias_warned = True
        return self.principals

    @property
    def mandates(self) -> MandateOperations:
        if self._mandates is None:
            from caracal_sdk.mandates import MandateOperations
            self._mandates = MandateOperations(scope=self)
        return self._mandates

    @property
    def delegation(self) -> DelegationOperations:
        if self._delegation is None:
            from caracal_sdk.delegation import DelegationOperations
            self._delegation = DelegationOperations(scope=self)
        return self._delegation

    @property
    def ledger(self) -> LedgerOperations:
        if self._ledger is None:
            from caracal_sdk.ledger import LedgerOperations
            self._ledger = LedgerOperations(scope=self)
        return self._ledger

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



