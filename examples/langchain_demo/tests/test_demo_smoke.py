"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Smoke tests verifying end-to-end demo correctness without full infrastructure.
"""

from __future__ import annotations

import asyncio
import dataclasses
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest

from examples.langchain_demo.mock_services import MockTransport, build_mock_transport, register_mock
from examples.langchain_demo.trace_store import TraceEvent, TraceStore, now_iso


# ---------------------------------------------------------------------------
# TraceStore unit tests
# ---------------------------------------------------------------------------

class TestTraceStore:
    def test_record_and_recent(self):
        store = TraceStore(maxsize=100)
        evt = TraceEvent(
            timestamp=now_iso(),
            run_id="run1",
            correlation_id=uuid4().hex,
            workspace="ws1",
            principal_id="p1",
            principal_kind="worker",
            tool_id="demo:ops:incidents:read",
            result_type="allowed",
            mode="mock",
        )
        store.record(evt)
        recent = store.recent(10)
        assert len(recent) == 1
        assert recent[0].run_id == "run1"

    def test_get_by_run(self):
        store = TraceStore()
        for i in range(3):
            store.record(TraceEvent(
                timestamp=now_iso(),
                run_id="runA",
                correlation_id=uuid4().hex,
                workspace="ws",
                principal_id=f"p{i}",
                principal_kind="worker",
                tool_id="t",
                result_type="allowed",
                mode="mock",
            ))
        store.record(TraceEvent(
            timestamp=now_iso(),
            run_id="runB",
            correlation_id=uuid4().hex,
            workspace="ws",
            principal_id="p_other",
            principal_kind="orchestrator",
            tool_id="t",
            result_type="allowed",
            mode="mock",
        ))
        assert len(store.get_by_run("runA")) == 3
        assert len(store.get_by_run("runB")) == 1

    def test_run_ids(self):
        store = TraceStore()
        for rid in ["r1", "r2", "r2", "r3"]:
            store.record(TraceEvent(
                timestamp=now_iso(),
                run_id=rid,
                correlation_id=uuid4().hex,
                workspace="ws",
                principal_id="p",
                principal_kind="worker",
                tool_id="t",
                result_type="allowed",
                mode="mock",
            ))
        ids = store.run_ids()
        assert set(ids) == {"r1", "r2", "r3"}

    def test_maxsize_enforced(self):
        store = TraceStore(maxsize=5)
        for i in range(10):
            store.record(TraceEvent(
                timestamp=now_iso(),
                run_id="r",
                correlation_id=uuid4().hex,
                workspace="ws",
                principal_id=f"p{i}",
                principal_kind="worker",
                tool_id="t",
                result_type="allowed",
                mode="mock",
            ))
        assert len(store.recent(100)) == 5

    def test_clear(self):
        store = TraceStore()
        store.record(TraceEvent(
            timestamp=now_iso(),
            run_id="r",
            correlation_id=uuid4().hex,
            workspace="ws",
            principal_id="p",
            principal_kind="worker",
            tool_id="t",
            result_type="allowed",
            mode="mock",
        ))
        store.clear()
        assert store.recent() == []


# ---------------------------------------------------------------------------
# MockTransport unit tests
# ---------------------------------------------------------------------------

class TestMockTransport:
    def test_registered_path_matched(self):
        transport = MockTransport(registry={"/incidents": {"body": {"open_count": 2}, "status": 200}})
        import httpx

        async def _call():
            req = httpx.Request("GET", "http://fake/incidents")
            return await transport.handle_async_request(req)

        resp = asyncio.run(_call())
        assert resp.status_code == 200
        import json
        body = json.loads(resp.content)
        assert body["open_count"] == 2

    def test_prefix_matching(self):
        transport = MockTransport(registry={"/deployments": {"body": {"status": "stable"}, "status": 200}})
        import httpx

        async def _call():
            req = httpx.Request("GET", "http://fake/deployments/current")
            return await transport.handle_async_request(req)

        resp = asyncio.run(_call())
        assert resp.status_code == 200

    def test_unknown_path_returns_default(self):
        transport = MockTransport(registry={})
        import httpx

        async def _call():
            req = httpx.Request("GET", "http://fake/unknown/path")
            return await transport.handle_async_request(req)

        resp = asyncio.run(_call())
        assert resp.status_code == 200
        import json
        body = json.loads(resp.content)
        assert body["mock"] is True

    def test_build_mock_transport_returns_transport(self):
        t = build_mock_transport()
        assert isinstance(t, MockTransport)


# ---------------------------------------------------------------------------
# Handler unit tests (mock mode)
# ---------------------------------------------------------------------------

class TestHandlers:
    def setup_method(self):
        import os
        os.environ["CARACAL_DEMO_MODE"] = "mock"

    def test_read_incident_mock(self):
        from examples.langchain_demo.handlers import read_incident

        result = asyncio.run(read_incident(principal_id="p-test", service="demo-api"))
        assert "incidents" in result
        assert result["principal_id"] == "p-test"
        assert isinstance(result["incidents"], list)
        assert len(result["incidents"]) > 0

    def test_read_deployment_mock(self):
        from examples.langchain_demo.handlers import read_deployment

        result = asyncio.run(read_deployment(principal_id="p-test"))
        assert "current_version" in result
        assert result["principal_id"] == "p-test"

    def test_read_logs_mock(self):
        from examples.langchain_demo.handlers import read_logs

        result = asyncio.run(read_logs(principal_id="p-test", lines=5))
        assert "logs" in result
        assert result["principal_id"] == "p-test"

    def test_submit_recommendation_mock(self):
        from examples.langchain_demo.handlers import submit_recommendation

        result = asyncio.run(submit_recommendation(
            principal_id="p-orch",
            summary="Test summary",
            findings={"tool1": {"k": "v"}},
            run_id="abc123",
        ))
        assert result["accepted"] is True
        assert result["principal_id"] == "p-orch"

    def test_handler_accepts_extra_kwargs(self):
        """Handlers must accept **_ to be safe with extra tool_args."""
        from examples.langchain_demo.handlers import read_incident

        result = asyncio.run(read_incident(principal_id="p", service="svc", unknown_param="x"))
        assert "incidents" in result


# ---------------------------------------------------------------------------
# WorkspacePreflight unit tests (with mocked DB)
# ---------------------------------------------------------------------------

class TestWorkspacePreflight:
    def _build_preflight(self, session=None):
        from examples.langchain_demo.preflight import WorkspacePreflight

        session = session or MagicMock()
        pf = WorkspacePreflight(session, "test-workspace")
        return pf

    def test_summary_has_required_keys(self):
        pf = self._build_preflight()
        pf._check_workspace = lambda: MagicMock(passed=True, name="workspace", detail="ok", cli_fix=None, tui_screen=None)  # type: ignore
        with patch.object(pf, "run", return_value=[]):
            summary = pf.summary()
        assert "workspace" in summary
        assert "checks" in summary
        assert "passed" in summary

    def test_passed_false_when_checks_fail(self):
        from examples.langchain_demo.preflight import CheckResult, WorkspacePreflight

        session = MagicMock()
        pf = WorkspacePreflight(session, "ws")
        # All DB queries return nothing → checks fail
        session.query.return_value.filter.return_value.first.return_value = None
        session.query.return_value.filter_by.return_value.first.return_value = None
        session.query.return_value.filter.return_value.filter.return_value.first.return_value = None

        checks = pf.run()
        assert isinstance(checks, list)
        assert not pf.passed()

    def test_summary_structure(self):
        from examples.langchain_demo.preflight import CheckResult, WorkspacePreflight

        session = MagicMock()
        pf = WorkspacePreflight(session, "ws")
        session.query.return_value.filter.return_value.first.return_value = None
        session.query.return_value.filter_by.return_value.first.return_value = None

        summary = pf.summary()
        assert isinstance(summary["checks"], list)
        for check in summary["checks"]:
            assert "name" in check
            assert "passed" in check
            assert "detail" in check


# ---------------------------------------------------------------------------
# DemoRuntime unit tests (orchestrator not found path)
# ---------------------------------------------------------------------------

class TestDemoRuntimeNoOrchestrator:
    def test_returns_error_when_no_orchestrator(self):
        import os
        os.environ["CARACAL_DEMO_MODE"] = "mock"

        from examples.langchain_demo.demo_runtime import DemoRuntime, RunConfig

        session = MagicMock()
        session.query.return_value.filter_by.return_value.first.return_value = None

        with (
            patch("examples.langchain_demo.demo_runtime._generate_keypair", return_value=(b"fake_priv", b"fake_pub")),
            patch("examples.langchain_demo.demo_runtime._build_session_manager", return_value=MagicMock()),
        ):
            runtime = DemoRuntime(
                db_session=session,
                workspace_id="ws",
                mcp_base_url="http://localhost:9999",
                trace_store=TraceStore(),
            )
            result = asyncio.run(runtime.execute(RunConfig(mode="mock", workspace_id="ws")))
        assert result.error is not None
        assert "orchestrator" in result.error.lower()
        assert result.run_id != ""


# ---------------------------------------------------------------------------
# _classify_result unit tests
# ---------------------------------------------------------------------------

class TestResultTypeClassification:
    def _make_runtime(self):
        import os
        os.environ["CARACAL_DEMO_MODE"] = "mock"

        from examples.langchain_demo.demo_runtime import DemoRuntime

        session = MagicMock()
        with (
            patch("examples.langchain_demo.demo_runtime._generate_keypair", return_value=(b"pk", b"pub")),
            patch("examples.langchain_demo.demo_runtime._build_session_manager", return_value=MagicMock()),
        ):
            return DemoRuntime(
                db_session=session,
                workspace_id="ws",
                mcp_base_url="http://localhost:9999",
                trace_store=TraceStore(),
            )

    def test_success_returns_allowed(self):
        rt = self._make_runtime()
        result_type, reason = rt._classify_result(True, None)
        assert result_type == "allowed"
        assert reason == ""

    def test_authority_denied_returns_enforcement_deny(self):
        rt = self._make_runtime()
        result_type, reason = rt._classify_result(False, "authority denied: scope mismatch")
        assert result_type == "enforcement_deny"
        assert "denied" in reason.lower()

    def test_denied_keyword_returns_enforcement_deny(self):
        rt = self._make_runtime()
        result_type, reason = rt._classify_result(False, "Request denied by evaluator")
        assert result_type == "enforcement_deny"

    def test_generic_error_returns_provider_error(self):
        rt = self._make_runtime()
        result_type, reason = rt._classify_result(False, "Connection refused")
        assert result_type == "provider_error"
        assert reason == "Connection refused"

    def test_none_error_returns_provider_error(self):
        rt = self._make_runtime()
        result_type, reason = rt._classify_result(False, None)
        assert result_type == "provider_error"


# ---------------------------------------------------------------------------
# Denial worker constant verification
# ---------------------------------------------------------------------------

class TestDenialWorkerConstants:
    def test_fourth_worker_is_denial_demo(self):
        from examples.langchain_demo.demo_runtime import (
            _WORKER_ACTION_SCOPES,
            _WORKER_LABELS,
            _WORKER_RESOURCE_SCOPES,
            _WORKER_TOOLS,
        )

        assert len(_WORKER_TOOLS) == 4
        assert len(_WORKER_LABELS) == 4
        assert len(_WORKER_RESOURCE_SCOPES) == 4
        assert len(_WORKER_ACTION_SCOPES) == 4
        assert _WORKER_LABELS[3] == "denial-demo"

    def test_denial_worker_scope_mismatch(self):
        from examples.langchain_demo.demo_runtime import (
            _WORKER_ACTION_SCOPES,
            _WORKER_RESOURCE_SCOPES,
            _WORKER_TOOLS,
        )

        tool = _WORKER_TOOLS[3]
        resource = _WORKER_RESOURCE_SCOPES[3]
        action = _WORKER_ACTION_SCOPES[3]
        assert "deployments" in tool
        assert "incidents" in resource or "incidents" in action


# ---------------------------------------------------------------------------
# Preflight enforcement tests (mocked DB)
# ---------------------------------------------------------------------------

class TestPreflightEnforcement:
    def test_passed_returns_false_without_workspace(self):
        from examples.langchain_demo.preflight import WorkspacePreflight

        session = MagicMock()
        session.query.return_value.filter_by.return_value.first.return_value = None
        session.query.return_value.filter.return_value.first.return_value = None
        session.query.return_value.filter.return_value.filter.return_value.first.return_value = None

        pf = WorkspacePreflight(session, "nonexistent-workspace")
        assert pf.passed() is False

    def test_summary_all_checks_have_required_fields(self):
        from examples.langchain_demo.preflight import WorkspacePreflight

        session = MagicMock()
        session.query.return_value.filter_by.return_value.first.return_value = None
        session.query.return_value.filter.return_value.first.return_value = None

        pf = WorkspacePreflight(session, "ws")
        summary = pf.summary()

        for check in summary["checks"]:
            assert "name" in check
            assert "passed" in check
            assert "detail" in check
            assert isinstance(check["passed"], bool)

    def test_passed_is_conjunction_of_checks(self):
        from examples.langchain_demo.preflight import CheckResult, WorkspacePreflight

        session = MagicMock()
        pf = WorkspacePreflight(session, "ws")
        passing = [CheckResult(name="c1", passed=True, detail="ok")]
        with patch.object(pf, "run", return_value=passing):
            assert pf.passed() is True
        failing = [CheckResult(name="c1", passed=False, detail="fail")]
        with patch.object(pf, "run", return_value=failing):
            assert pf.passed() is False
