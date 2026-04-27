"""Unit tests for SDK explicit tool-call operations."""

from __future__ import annotations

import pytest

from caracal_sdk._compat import SDKConfigurationError
from caracal_sdk.adapters.base import BaseAdapter, SDKRequest, SDKResponse
from caracal_sdk.context import ScopeContext
from caracal_sdk.hooks import HookRegistry


class _CaptureAdapter(BaseAdapter):
    def __init__(self, response_body=None):
        self.sent_requests: list[SDKRequest] = []
        self._response_body = response_body if response_body is not None else {"ok": True}

    async def send(self, request: SDKRequest) -> SDKResponse:
        self.sent_requests.append(request)
        return SDKResponse(status_code=200, body=self._response_body)

    def close(self) -> None:
        return None

    @property
    def is_connected(self) -> bool:
        return True


@pytest.mark.unit
@pytest.mark.asyncio
async def test_scope_tools_call_uses_canonical_payload_and_scope_headers() -> None:
    adapter = _CaptureAdapter(response_body={"success": True})
    scope = ScopeContext(
        adapter=adapter,
        hooks=HookRegistry(),
        workspace_id="workspace-123",
    )

    result = await scope.tools.call(
        tool_id="provider:endframe:resource:deployments",
        tool_args={"payload": "ok"},
        metadata={"trace_id": "trace-sdk"},
        correlation_id="corr-123",
    )

    assert result == {"success": True}
    assert len(adapter.sent_requests) == 1

    req = adapter.sent_requests[0]
    assert req.method == "POST"
    assert req.path == "/mcp/tool/call"
    assert req.headers["X-Caracal-Workspace-ID"] == "workspace-123"
    assert req.body == {
        "tool_id": "provider:endframe:resource:deployments",
        "tool_args": {"payload": "ok"},
        "metadata": {
            "trace_id": "trace-sdk",
            "correlation_id": "corr-123",
        },
    }


@pytest.mark.unit
@pytest.mark.asyncio
async def test_scope_tools_call_forbids_identity_and_mandate_payload_fields() -> None:
    adapter = _CaptureAdapter()
    scope = ScopeContext(adapter=adapter, hooks=HookRegistry())

    with pytest.raises(SDKConfigurationError, match="Caller identity fields"):
        await scope.tools.call(
            tool_id="provider:endframe:resource:deployments",
            metadata={"principal_id": "forbidden"},
        )

    with pytest.raises(SDKConfigurationError, match="Caller identity fields"):
        await scope.tools.call(
            tool_id="provider:endframe:resource:deployments",
            tool_args={"principal_id": "forbidden"},
        )

    with pytest.raises(SDKConfigurationError, match="Caller identity fields"):
        await scope.tools.call(
            tool_id="provider:endframe:resource:deployments",
            metadata={"mandate_id": "forbidden"},
        )

    with pytest.raises(SDKConfigurationError, match="Caller identity fields"):
        await scope.tools.call(
            tool_id="provider:endframe:resource:deployments",
            metadata={"policy_id": "forbidden"},
        )

    with pytest.raises(SDKConfigurationError, match="Caller identity fields"):
        await scope.tools.call(
            tool_id="provider:endframe:resource:deployments",
            tool_args={"resolved_mandate_id": "forbidden"},
        )

    with pytest.raises(SDKConfigurationError, match="Caller identity fields"):
        await scope.tools.call(
            tool_id="provider:endframe:resource:deployments",
            tool_args={"policy_id": "forbidden"},
        )


@pytest.mark.unit
@pytest.mark.asyncio
async def test_scope_tools_call_rejects_non_correlation_metadata_keys() -> None:
    adapter = _CaptureAdapter()
    scope = ScopeContext(adapter=adapter, hooks=HookRegistry())

    with pytest.raises(SDKConfigurationError, match="correlation keys only"):
        await scope.tools.call(
            tool_id="provider:endframe:resource:deployments",
            metadata={"source": "sdk"},
        )


@pytest.mark.unit
@pytest.mark.asyncio
async def test_tool_call_transport_parity_across_adapters() -> None:
    direct_adapter = _CaptureAdapter(response_body={"success": True, "mode": "direct"})
    gateway_adapter = _CaptureAdapter(response_body={"success": True, "mode": "gateway"})

    direct_scope = ScopeContext(adapter=direct_adapter, hooks=HookRegistry(), workspace_id="workspace-1")
    gateway_scope = ScopeContext(adapter=gateway_adapter, hooks=HookRegistry(), workspace_id="workspace-1")

    direct_result = await direct_scope.tools.call(
        tool_id="provider:endframe:resource:deployments",
        tool_args={"payload": "ok"},
    )
    gateway_result = await gateway_scope.tools.call(
        tool_id="provider:endframe:resource:deployments",
        tool_args={"payload": "ok"},
    )

    assert direct_result["success"] is True
    assert gateway_result["success"] is True
    assert direct_adapter.sent_requests[0].body == gateway_adapter.sent_requests[0].body
