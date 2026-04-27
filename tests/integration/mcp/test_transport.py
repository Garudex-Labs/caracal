"""Integration tests for SDK tool-call transport parity across adapters."""

from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI, Request

from caracal_sdk.adapters.http import HttpAdapter
from caracal_sdk.context import ScopeContext
from caracal_sdk.gateway import GatewayAdapter, GatewayFeatureFlags
from caracal_sdk.hooks import HookRegistry


@pytest.mark.integration
@pytest.mark.asyncio
async def test_sdk_tool_call_http_and_gateway_adapters_return_identical_shape(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app = FastAPI()

    @app.post("/mcp/tool/call")
    async def _tool_call(request: Request):
        payload = await request.json()
        return {
            "success": True,
            "echo": payload,
            "shape": sorted(payload.keys()),
        }

    real_async_client = httpx.AsyncClient

    class _InProcessAsyncClient:
        def __init__(self, *args, **kwargs):
            del args
            base_url = kwargs.pop("base_url", None) or "http://testserver"
            headers = kwargs.pop("headers", None)
            timeout = kwargs.pop("timeout", None)
            follow_redirects = kwargs.pop("follow_redirects", False)
            self._inner = real_async_client(
                base_url=base_url,
                headers=headers,
                timeout=timeout,
                follow_redirects=follow_redirects,
                transport=httpx.ASGITransport(app=app),
            )

        async def request(self, *args, **kwargs):
            return await self._inner.request(*args, **kwargs)

        async def post(self, *args, **kwargs):
            return await self._inner.post(*args, **kwargs)

        async def aclose(self):
            await self._inner.aclose()

        @property
        def is_closed(self) -> bool:
            return self._inner.is_closed

    monkeypatch.setattr(httpx, "AsyncClient", _InProcessAsyncClient)

    direct_scope = ScopeContext(
        adapter=HttpAdapter(base_url="http://direct.local"),
        hooks=HookRegistry(),
        workspace_id="workspace-123",
    )

    gateway_scope = ScopeContext(
        adapter=GatewayAdapter(
            feature_flags=GatewayFeatureFlags(
                gateway_enabled=True,
                gateway_endpoint="http://gateway.local",
                gateway_api_key="gateway-test-key",
                deployment_type="managed",
                fail_closed=True,
            ),
            gateway_endpoint="http://gateway.local",
            gateway_api_key="gateway-test-key",
        ),
        hooks=HookRegistry(),
        workspace_id="workspace-123",
    )

    payload_kwargs = {
        "tool_id": "provider:endframe:resource:deployments",
        "tool_args": {"payload": "ok"},
        "metadata": {"trace_id": "integration-test"},
    }

    direct_response = await direct_scope.tools.call(**payload_kwargs)
    gateway_response = await gateway_scope.tools.call(**payload_kwargs)

    assert direct_response == gateway_response
    assert direct_response["success"] is True
    assert direct_response["shape"] == ["metadata", "tool_args", "tool_id"]
    assert direct_response["echo"] == {
        "tool_id": "provider:endframe:resource:deployments",
        "tool_args": {"payload": "ok"},
        "metadata": {"trace_id": "integration-test"},
    }

    direct_scope._adapter.close()
    gateway_scope._adapter.close()
