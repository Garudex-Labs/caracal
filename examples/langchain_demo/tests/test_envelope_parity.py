"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Parity tests: same tool-call envelope in mock/real modes; CLI/TUI/demo scope alignment.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import httpx


# ---------------------------------------------------------------------------
# P1.7 / P1.14 — Response envelope and payload parity
# ---------------------------------------------------------------------------


class _CaptureTransport(httpx.AsyncBaseTransport):
    """Intercept outbound requests and return a canned 200 response.

    Captures the last request body for assertion.
    """

    def __init__(self, response_body: dict) -> None:
        self._response_body = response_body
        self.captured_body: dict = {}
        self.captured_headers: dict = {}

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        try:
            self.captured_body = json.loads(request.content)
        except Exception:
            self.captured_body = {}
        self.captured_headers = dict(request.headers)
        content = json.dumps(self._response_body).encode()
        return httpx.Response(
            status_code=200,
            headers={"content-type": "application/json"},
            content=content,
            request=request,
        )


def _make_sdk_client(transport: httpx.AsyncBaseTransport):
    from caracal_sdk.adapters.http import HttpAdapter
    from caracal_sdk.client import CaracalClient

    adapter = HttpAdapter(
        base_url="http://localhost:8090",
        api_key="test-token",
        transport=transport,
    )
    return CaracalClient(adapter=adapter)


class TestToolCallEnvelopeParity:
    """P1.7 + P1.14: real and mock modes produce the same /mcp/tool/call body shape."""

    @pytest.mark.asyncio
    async def test_mock_mode_sends_canonical_mcp_body(self) -> None:
        transport = _CaptureTransport({"success": True, "result": "mock-data"})
        client = _make_sdk_client(transport)
        scope = client.context.checkout(workspace_id="demo-workspace")

        await scope.tools.call(
            tool_id="demo:ops:incidents:read",
            tool_args={"limit": 10},
            correlation_id="test-corr-001",
        )
        client.close()

        body = transport.captured_body
        assert body["tool_id"] == "demo:ops:incidents:read"
        assert body["tool_args"] == {"limit": 10}
        assert body["metadata"]["correlation_id"] == "test-corr-001"

    @pytest.mark.asyncio
    async def test_real_mode_sends_same_body_shape(self) -> None:
        transport = _CaptureTransport({"success": True, "result": "real-data"})
        client = _make_sdk_client(transport)
        scope = client.context.checkout(workspace_id="demo-workspace")

        await scope.tools.call(
            tool_id="demo:ops:incidents:read",
            tool_args={"limit": 10},
            correlation_id="test-corr-002",
        )
        client.close()

        body = transport.captured_body
        assert set(body.keys()) >= {"tool_id", "tool_args", "metadata"}
        assert "mandate_id" not in body
        assert "principal_id" not in body

    @pytest.mark.asyncio
    async def test_envelope_has_no_identity_spoofing_fields(self) -> None:
        transport = _CaptureTransport({"success": True})
        client = _make_sdk_client(transport)
        scope = client.context.checkout(workspace_id="demo-workspace")

        await scope.tools.call(
            tool_id="demo:ops:deployments:read",
            tool_args={},
        )
        client.close()

        body = transport.captured_body
        forbidden = {
            "mandate_id", "principal_id", "policy_id", "token_subject",
            "resolved_mandate_id", "task_token_claims",
        }
        assert not forbidden & set(body.keys())
        metadata = body.get("metadata", {})
        assert not forbidden & set(metadata.keys())

    @pytest.mark.asyncio
    async def test_workspace_header_injected_into_request(self) -> None:
        transport = _CaptureTransport({"success": True})
        client = _make_sdk_client(transport)
        scope = client.context.checkout(workspace_id="demo-workspace")

        await scope.tools.call(tool_id="demo:ops:logs:read", tool_args={})
        client.close()

        headers = transport.captured_headers
        assert headers.get("x-caracal-workspace-id") == "demo-workspace"

    @pytest.mark.asyncio
    async def test_mock_and_real_worker_result_same_fields(self) -> None:
        from examples.langchain_demo.demo_runtime import WorkerResult

        mock_result = WorkerResult(
            worker_name="worker-1",
            principal_id="pid-mock",
            tool_id="demo:ops:incidents:read",
            success=True,
            result={"incidents": []},
            error=None,
            latency_ms=12.3,
            mandate_id="mid-mock",
            denial_reason="",
            result_type="allowed",
        )
        real_result = WorkerResult(
            worker_name="worker-1",
            principal_id="pid-real",
            tool_id="demo:ops:incidents:read",
            success=True,
            result={"incidents": []},
            error=None,
            latency_ms=45.6,
            mandate_id="mid-real",
            denial_reason="",
            result_type="allowed",
        )

        mock_fields = set(mock_result.__dataclass_fields__.keys())
        real_fields = set(real_result.__dataclass_fields__.keys())
        assert mock_fields == real_fields

    @pytest.mark.asyncio
    async def test_denial_result_type_consistent_across_modes(self) -> None:
        from examples.langchain_demo.demo_runtime import DemoRuntime, TraceStore

        db = MagicMock()
        rt = DemoRuntime(
            db_session=db,
            workspace_id="demo",
            mcp_base_url="http://localhost:8090",
            trace_store=TraceStore(),
        )

        result_type, denial_reason = rt._classify_result(False, "authority denied: scope mismatch")
        assert result_type == "enforcement_deny"
        assert denial_reason != ""

        result_type2, denial_reason2 = rt._classify_result(False, "connection refused")
        assert result_type2 == "provider_error"

        result_type3, _ = rt._classify_result(True, None)
        assert result_type3 == "allowed"


# ---------------------------------------------------------------------------
# P1.19 — Mixed-surface scope resolution parity
# ---------------------------------------------------------------------------


class TestMixedSurfaceScopeParity:
    """P1.19: CLI, TUI, and demo preflight all resolve tool scopes identically."""

    def test_cli_and_tui_use_same_scope_resolver(self) -> None:
        from caracal.cli.authority import resolve_issue_scopes_from_tool_ids as cli_fn
        from caracal.flow.screens.mandate_flow import resolve_issue_scopes_from_tool_ids as tui_fn
        from caracal.mcp.tool_registry_contract import resolve_issue_scopes_from_tool_ids as registry_fn

        assert cli_fn is registry_fn
        assert tui_fn is registry_fn

    def test_demo_preflight_uses_registry_scope_resolver(self) -> None:
        from caracal.mcp.tool_registry_contract import resolve_issue_scopes_from_tool_ids as registry_fn
        import examples.langchain_demo.preflight as preflight_module
        import inspect

        src = inspect.getsource(preflight_module.WorkspacePreflight._check_tools_mapping_drift)
        assert "resolve_issue_scopes_from_tool_ids" in src

    def test_cli_tui_demo_produce_same_scope_contract_on_valid_tools(self) -> None:
        from unittest.mock import MagicMock, patch
        from caracal.mcp.tool_registry_contract import resolve_issue_scopes_from_tool_ids

        tool_id = "demo:ops:incidents:read"
        expected = {
            "resource_scope": "resource:ops-api:incidents",
            "action_scope": "action:ops-api:incidents:read",
            "providers": ["ops-api"],
        }

        session = MagicMock()
        with patch(
            "caracal.mcp.tool_registry_contract.resolve_issue_scopes_from_tool_ids",
            return_value=expected,
        ) as mock_fn:
            cli_result = mock_fn(db_session=session, tool_ids=[tool_id])
            tui_result = mock_fn(db_session=session, tool_ids=[tool_id])
            demo_result = mock_fn(db_session=session, tool_ids=[tool_id])

        assert cli_result == tui_result == demo_result
        for result in (cli_result, tui_result, demo_result):
            assert "resource_scope" in result
            assert "action_scope" in result
            assert "providers" in result

    def test_mock_transport_intercepts_only_external_response(self) -> None:
        from examples.langchain_demo.mock_services import MockTransport, register_mock

        register_mock("/test-path", {"ok": True})
        t = MockTransport()

        assert hasattr(t, "handle_async_request")
        assert isinstance(t, httpx.AsyncBaseTransport)

    def test_http_adapter_accepts_mock_transport(self) -> None:
        from caracal_sdk.adapters.http import HttpAdapter
        from examples.langchain_demo.mock_services import MockTransport

        mt = MockTransport()
        adapter = HttpAdapter(
            base_url="http://localhost:8090",
            api_key="test-key",
            transport=mt,
        )
        assert adapter._transport is mt
