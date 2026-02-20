"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for SDK Agent Operations.
"""

import pytest

from caracal.sdk.adapters.base import SDKResponse
from caracal.sdk.adapters.mock import MockAdapter
from caracal.sdk.hooks import HookRegistry
from caracal.sdk.context import ScopeContext
from caracal.sdk.agents import AgentOperations


@pytest.fixture
def scoped_setup():
    adapter = MockAdapter(responses={
        ("GET", "/agents"): SDKResponse(status_code=200, body=[{"id": "a1"}], elapsed_ms=1.0),
        ("GET", "/agents/a1"): SDKResponse(status_code=200, body={"id": "a1", "name": "test"}, elapsed_ms=1.0),
        ("POST", "/agents"): SDKResponse(status_code=201, body={"id": "a2", "name": "new"}, elapsed_ms=2.0),
        ("PATCH", "/agents/a1"): SDKResponse(status_code=200, body={"id": "a1", "name": "updated"}, elapsed_ms=1.0),
        ("DELETE", "/agents/a1"): SDKResponse(status_code=204, body=None, elapsed_ms=0.5),
        ("POST", "/agents/a1/children"): SDKResponse(status_code=201, body={"id": "child1"}, elapsed_ms=1.5),
    })
    hooks = HookRegistry()
    ctx = ScopeContext(
        adapter=adapter, hooks=hooks,
        organization_id="org_1", workspace_id="ws_1",
    )
    return ctx, adapter, hooks


class TestAgentOperations:
    @pytest.mark.asyncio
    async def test_list(self, scoped_setup):
        ctx, adapter, _ = scoped_setup
        result = await ctx.agents.list()
        assert result == [{"id": "a1"}]
        sent = adapter.sent_requests
        assert len(sent) == 1
        assert sent[0].method == "GET"
        assert sent[0].path == "/agents"
        assert sent[0].headers["X-Caracal-Org-ID"] == "org_1"
        assert sent[0].headers["X-Caracal-Workspace-ID"] == "ws_1"

    @pytest.mark.asyncio
    async def test_get(self, scoped_setup):
        ctx, adapter, _ = scoped_setup
        result = await ctx.agents.get("a1")
        assert result["name"] == "test"

    @pytest.mark.asyncio
    async def test_create(self, scoped_setup):
        ctx, adapter, _ = scoped_setup
        result = await ctx.agents.create(name="new", owner="bob")
        assert result["id"] == "a2"
        sent = adapter.sent_requests
        assert sent[0].method == "POST"
        assert sent[0].body["name"] == "new"
        assert sent[0].body["owner"] == "bob"

    @pytest.mark.asyncio
    async def test_update(self, scoped_setup):
        ctx, _, _ = scoped_setup
        result = await ctx.agents.update("a1", name="updated")
        assert result["name"] == "updated"

    @pytest.mark.asyncio
    async def test_delete(self, scoped_setup):
        ctx, adapter, _ = scoped_setup
        await ctx.agents.delete("a1")
        assert adapter.sent_requests[0].method == "DELETE"

    @pytest.mark.asyncio
    async def test_create_child(self, scoped_setup):
        ctx, adapter, _ = scoped_setup
        result = await ctx.agents.create_child(
            parent_agent_id="a1", child_name="child", child_owner="alice",
        )
        assert result["id"] == "child1"
        assert adapter.sent_requests[0].path == "/agents/a1/children"

    @pytest.mark.asyncio
    async def test_hooks_fire_in_order(self, scoped_setup):
        ctx, _, hooks = scoped_setup
        order = []
        hooks.on_before_request(lambda r, s: (order.append("before"), r)[1])
        hooks.on_after_response(lambda r, s: order.append("after"))
        await ctx.agents.list()
        assert order == ["before", "after"]
