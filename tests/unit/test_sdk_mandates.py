"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for SDK Mandate & Delegation Operations.
"""

import pytest

from caracal.sdk.adapters.base import SDKResponse
from caracal.sdk.adapters.mock import MockAdapter
from caracal.sdk.hooks import HookRegistry
from caracal.sdk.context import ScopeContext


@pytest.fixture
def scoped_setup():
    adapter = MockAdapter(responses={
        ("POST", "/mandates"): SDKResponse(status_code=201, body={"id": "m1", "status": "active"}, elapsed_ms=1.0),
        ("POST", "/mandates/m1/validate"): SDKResponse(status_code=200, body={"valid": True}, elapsed_ms=0.5),
        ("POST", "/mandates/m1/revoke"): SDKResponse(status_code=200, body={"revoked": True}, elapsed_ms=0.5),
        ("GET", "/mandates/m1"): SDKResponse(status_code=200, body={"id": "m1"}, elapsed_ms=0.5),
        ("GET", "/mandates"): SDKResponse(status_code=200, body=[{"id": "m1"}], elapsed_ms=0.5),
        ("POST", "/delegations"): SDKResponse(status_code=201, body={"id": "d1"}, elapsed_ms=1.0),
        ("POST", "/delegations/token"): SDKResponse(status_code=200, body={"token": "jwt..."}, elapsed_ms=0.5),
        ("GET", "/delegations/chain/a1"): SDKResponse(status_code=200, body=[{"level": 0}], elapsed_ms=0.5),
    })
    hooks = HookRegistry()
    ctx = ScopeContext(
        adapter=adapter, hooks=hooks,
        organization_id="org_1", workspace_id="ws_1",
    )
    return ctx, adapter, hooks


class TestMandateOperations:
    @pytest.mark.asyncio
    async def test_create(self, scoped_setup):
        ctx, adapter, _ = scoped_setup
        result = await ctx.mandates.create(
            agent_id="a1", allowed_operations=["read", "write"], expires_in=3600,
        )
        assert result["id"] == "m1"
        sent = adapter.sent_requests[0]
        assert sent.method == "POST"
        assert sent.path == "/mandates"
        assert sent.body["agent_id"] == "a1"
        assert sent.body["allowed_operations"] == ["read", "write"]
        assert sent.headers["X-Caracal-Org-ID"] == "org_1"

    @pytest.mark.asyncio
    async def test_validate(self, scoped_setup):
        ctx, adapter, _ = scoped_setup
        result = await ctx.mandates.validate(
            mandate_id="m1", requested_action="read", requested_resource="data",
        )
        assert result["valid"] is True
        assert adapter.sent_requests[0].path == "/mandates/m1/validate"

    @pytest.mark.asyncio
    async def test_revoke(self, scoped_setup):
        ctx, _, _ = scoped_setup
        result = await ctx.mandates.revoke(
            mandate_id="m1", revoker_id="admin", reason="expired",
        )
        assert result["revoked"] is True

    @pytest.mark.asyncio
    async def test_get(self, scoped_setup):
        ctx, _, _ = scoped_setup
        result = await ctx.mandates.get("m1")
        assert result["id"] == "m1"

    @pytest.mark.asyncio
    async def test_list(self, scoped_setup):
        ctx, _, _ = scoped_setup
        result = await ctx.mandates.list()
        assert len(result) == 1


class TestDelegationOperations:
    @pytest.mark.asyncio
    async def test_create(self, scoped_setup):
        ctx, adapter, _ = scoped_setup
        result = await ctx.delegation.create(
            parent_mandate_id="m1",
            child_subject_id="child_1",
            resource_scope=["data.*"],
            action_scope=["read"],
            validity_seconds=1800,
        )
        assert result["id"] == "d1"
        sent = adapter.sent_requests[0]
        assert sent.body["parent_mandate_id"] == "m1"
        assert sent.body["resource_scope"] == ["data.*"]

    @pytest.mark.asyncio
    async def test_get_token(self, scoped_setup):
        ctx, _, _ = scoped_setup
        result = await ctx.delegation.get_token(
            parent_agent_id="parent_1", child_agent_id="child_1",
        )
        assert result["token"] == "jwt..."

    @pytest.mark.asyncio
    async def test_get_chain(self, scoped_setup):
        ctx, _, _ = scoped_setup
        result = await ctx.delegation.get_chain("a1")
        assert len(result) == 1
