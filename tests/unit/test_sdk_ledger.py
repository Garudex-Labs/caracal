"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for SDK Ledger Query Interface.
"""

import pytest

from caracal.sdk.adapters.base import SDKResponse
from caracal.sdk.adapters.mock import MockAdapter
from caracal.sdk.hooks import HookRegistry
from caracal.sdk.context import ScopeContext


@pytest.fixture
def scoped_setup():
    adapter = MockAdapter(responses={
        ("GET", "/ledger/events"): SDKResponse(
            status_code=200,
            body={"events": [{"id": "e1", "type": "mandate_issued"}], "total": 1},
            elapsed_ms=2.0,
        ),
        ("GET", "/ledger/entries/e1"): SDKResponse(
            status_code=200, body={"id": "e1", "type": "mandate_issued"}, elapsed_ms=0.5,
        ),
        ("GET", "/ledger/chain/m1"): SDKResponse(
            status_code=200, body=[{"entry_id": "e1"}, {"entry_id": "e2"}], elapsed_ms=1.0,
        ),
        ("GET", "/ledger/verify/e1"): SDKResponse(
            status_code=200, body={"valid": True, "hash": "abc..."}, elapsed_ms=0.5,
        ),
    })
    hooks = HookRegistry()
    ctx = ScopeContext(
        adapter=adapter, hooks=hooks,
        organization_id="org_1",
    )
    return ctx, adapter, hooks


class TestLedgerOperations:
    @pytest.mark.asyncio
    async def test_query(self, scoped_setup):
        ctx, adapter, _ = scoped_setup
        result = await ctx.ledger.query(principal_id="p1", limit=50)
        assert result["total"] == 1
        sent = adapter.sent_requests[0]
        assert sent.method == "GET"
        assert sent.path == "/ledger/events"
        assert sent.headers["X-Caracal-Org-ID"] == "org_1"
        assert sent.params["principal_id"] == "p1"
        assert sent.params["limit"] == 50

    @pytest.mark.asyncio
    async def test_get_entry(self, scoped_setup):
        ctx, _, _ = scoped_setup
        result = await ctx.ledger.get_entry("e1")
        assert result["type"] == "mandate_issued"

    @pytest.mark.asyncio
    async def test_get_chain(self, scoped_setup):
        ctx, _, _ = scoped_setup
        result = await ctx.ledger.get_chain("m1")
        assert len(result) == 2

    @pytest.mark.asyncio
    async def test_verify_integrity(self, scoped_setup):
        ctx, _, _ = scoped_setup
        result = await ctx.ledger.verify_integrity("e1")
        assert result["valid"] is True

    @pytest.mark.asyncio
    async def test_hooks_fire_in_order(self, scoped_setup):
        ctx, _, hooks = scoped_setup
        order = []
        hooks.on_before_request(lambda r, s: (order.append("before"), r)[1])
        hooks.on_after_response(lambda r, s: order.append("after"))
        await ctx.ledger.get_entry("e1")
        assert order == ["before", "after"]
