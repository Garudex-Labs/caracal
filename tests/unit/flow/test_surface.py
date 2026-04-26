"""Unit tests for tools-first SDK surfaces in hard-cut runtime mode."""

from __future__ import annotations

import pytest

from caracal_sdk.adapters.base import BaseAdapter, SDKRequest, SDKResponse
from caracal_sdk.client import CaracalClient
from caracal_sdk.context import ScopeContext
from caracal_sdk.hooks import HookRegistry


class _NoopAdapter(BaseAdapter):
    async def send(self, request: SDKRequest) -> SDKResponse:
        return SDKResponse(status_code=200, body={"request": request.path})

    def close(self) -> None:
        return None

    @property
    def is_connected(self) -> bool:
        return True


@pytest.mark.unit
def test_scope_context_exposes_tools_only() -> None:
    scope = ScopeContext(adapter=_NoopAdapter(), hooks=HookRegistry())

    tools = scope.tools
    assert tools is not None
    assert not hasattr(scope, "principals")
    assert not hasattr(scope, "mandates")
    assert not hasattr(scope, "delegation")
    assert not hasattr(scope, "ledger")


@pytest.mark.unit
def test_client_exposes_tools_only() -> None:
    client = CaracalClient(adapter=_NoopAdapter())

    tools = client.tools
    assert tools is not None
    assert not hasattr(client, "principals")
    assert not hasattr(client, "mandates")
    assert not hasattr(client, "delegation")
    assert not hasattr(client, "ledger")
    client.close()


@pytest.mark.unit
@pytest.mark.asyncio
async def test_tools_surface_sends_mcp_tool_call_request() -> None:
    scope = ScopeContext(adapter=_NoopAdapter(), hooks=HookRegistry())
    payload = await scope.tools.call(
        tool_id="tool.demo",
        tool_args={"x": 1},
    )

    assert payload["request"] == "/mcp/tool/call"
