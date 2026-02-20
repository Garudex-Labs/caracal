"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for SDK Context & Scope Management.
"""

import warnings
import pytest

from caracal.sdk.adapters.mock import MockAdapter
from caracal.sdk.hooks import HookRegistry
from caracal.sdk.context import ScopeContext, ContextManager, BudgetCheckContext


@pytest.fixture
def adapter():
    return MockAdapter()


@pytest.fixture
def hooks():
    return HookRegistry()


class TestScopeContext:
    def test_scope_headers_all_set(self, adapter, hooks):
        ctx = ScopeContext(
            adapter=adapter, hooks=hooks,
            organization_id="org_1", workspace_id="ws_1", project_id="proj_1",
        )
        headers = ctx.scope_headers()
        assert headers == {
            "X-Caracal-Org-ID": "org_1",
            "X-Caracal-Workspace-ID": "ws_1",
            "X-Caracal-Project-ID": "proj_1",
        }

    def test_scope_headers_partial(self, adapter, hooks):
        ctx = ScopeContext(adapter=adapter, hooks=hooks, organization_id="org_1")
        headers = ctx.scope_headers()
        assert headers == {"X-Caracal-Org-ID": "org_1"}

    def test_scope_headers_empty(self, adapter, hooks):
        ctx = ScopeContext(adapter=adapter, hooks=hooks)
        assert ctx.scope_headers() == {}

    def test_to_scope_ref(self, adapter, hooks):
        ctx = ScopeContext(
            adapter=adapter, hooks=hooks,
            organization_id="org_1", workspace_id="ws_1",
        )
        ref = ctx.to_scope_ref()
        assert ref.organization_id == "org_1"
        assert ref.workspace_id == "ws_1"
        assert ref.project_id is None

    def test_lazy_agents(self, adapter, hooks):
        ctx = ScopeContext(adapter=adapter, hooks=hooks)
        agents = ctx.agents
        assert agents is not None
        # Should return the same instance
        assert ctx.agents is agents

    def test_lazy_mandates(self, adapter, hooks):
        ctx = ScopeContext(adapter=adapter, hooks=hooks)
        assert ctx.mandates is not None

    def test_lazy_delegation(self, adapter, hooks):
        ctx = ScopeContext(adapter=adapter, hooks=hooks)
        assert ctx.delegation is not None

    def test_lazy_ledger(self, adapter, hooks):
        ctx = ScopeContext(adapter=adapter, hooks=hooks)
        assert ctx.ledger is not None


class TestContextManager:
    def test_checkout_returns_scope(self, adapter, hooks):
        mgr = ContextManager(adapter=adapter, hooks=hooks)
        ctx = mgr.checkout(organization_id="org_x", workspace_id="ws_y")
        assert ctx.organization_id == "org_x"
        assert ctx.workspace_id == "ws_y"

    def test_checkout_updates_current(self, adapter, hooks):
        mgr = ContextManager(adapter=adapter, hooks=hooks)
        assert mgr.current is None
        ctx = mgr.checkout(workspace_id="ws_1")
        assert mgr.current is ctx

    def test_checkout_fires_context_switch(self, adapter, hooks):
        switches = []
        hooks.on_context_switch(lambda f, t: switches.append((f, t)))

        mgr = ContextManager(adapter=adapter, hooks=hooks)
        mgr.checkout(workspace_id="ws_1")

        assert len(switches) == 1
        assert switches[0][0] is None  # from is None (first checkout)
        assert switches[0][1].workspace_id == "ws_1"

    def test_checkout_fires_state_change(self, adapter, hooks):
        states = []
        hooks.on_state_change(lambda s: states.append(s))

        mgr = ContextManager(adapter=adapter, hooks=hooks)
        mgr.checkout(organization_id="org_1")

        assert len(states) == 1
        assert states[0].organization_id == "org_1"

    def test_multiple_checkouts(self, adapter, hooks):
        switches = []
        hooks.on_context_switch(lambda f, t: switches.append((f, t)))

        mgr = ContextManager(adapter=adapter, hooks=hooks)
        mgr.checkout(workspace_id="ws_1")
        mgr.checkout(workspace_id="ws_2")

        assert len(switches) == 2
        assert switches[1][0].workspace_id == "ws_1"
        assert switches[1][1].workspace_id == "ws_2"


class TestBudgetCheckContextDeprecation:
    def test_deprecation_warning(self):
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            BudgetCheckContext()
            assert len(w) == 1
            assert issubclass(w[0].category, DeprecationWarning)
            assert "deprecated" in str(w[0].message).lower()
