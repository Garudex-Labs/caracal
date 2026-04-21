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


# ---------------------------------------------------------------------------
# Provider misconfiguration (R1)
# ---------------------------------------------------------------------------

class TestProviderMisconfiguration:
    def test_preflight_reports_missing_provider(self):
        from examples.langchain_demo.preflight import WorkspacePreflight

        session = MagicMock()
        session.query.return_value.filter_by.return_value.first.return_value = None
        session.query.return_value.filter.return_value.first.return_value = None
        session.query.return_value.filter.return_value.filter.return_value.first.return_value = None

        pf = WorkspacePreflight(session, "demo-workspace")
        checks = pf.run()
        names = [c.name for c in checks]
        assert "provider_ops_api" in names
        provider = next(c for c in checks if c.name == "provider_ops_api")
        assert provider.passed is False

    def test_preflight_reports_missing_tools(self):
        from examples.langchain_demo.preflight import WorkspacePreflight

        session = MagicMock()
        session.query.return_value.filter_by.return_value.first.return_value = None
        session.query.return_value.filter.return_value.count.return_value = 0
        session.query.return_value.filter.return_value.all.return_value = []
        session.query.return_value.filter.return_value.first.return_value = None
        session.query.return_value.filter.return_value.filter.return_value.first.return_value = None

        pf = WorkspacePreflight(session, "demo-workspace")
        checks = pf.run()
        names = [c.name for c in checks]
        # Each tool has its own check named "tool_<tool_id>"
        tool_checks = [n for n in names if n.startswith("tool_") and not n == "tool_mapping_drift"]
        assert len(tool_checks) > 0
        for tc in tool_checks:
            check = next(c for c in checks if c.name == tc)
            assert check.passed is False

    def test_preflight_check_names_are_complete(self):
        from examples.langchain_demo.preflight import WorkspacePreflight

        session = MagicMock()
        session.query.return_value.filter_by.return_value.first.return_value = None
        session.query.return_value.filter.return_value.first.return_value = None
        session.query.return_value.filter.return_value.count.return_value = 0
        session.query.return_value.filter.return_value.all.return_value = []

        pf = WorkspacePreflight(session, "demo-workspace")
        checks = pf.run()
        names = {c.name for c in checks}
        # Workspace check uses name "workspace_active"
        assert "workspace_active" in names
        # Provider check uses name "provider_ops_api"
        assert "provider_ops_api" in names
        # Per-principal-kind checks for static required principals
        for kind in ("human", "orchestrator", "service"):
            assert f"principal_{kind}" in names, f"Missing check: principal_{kind}"
        # Worker readiness check (plural — checks count of registered workers)
        assert "principal_workers" in names, "Missing check: principal_workers"
        # Standard aggregate checks
        for expected in ("policies", "mandates"):
            assert expected in names, f"Missing check: {expected}"


# ---------------------------------------------------------------------------
# /caracal route visibility (R1)
# ---------------------------------------------------------------------------

class TestCaracalVisibility:
    def _app_src(self) -> str:
        import pathlib
        return (pathlib.Path(__file__).parent.parent / "app.py").read_text()

    def test_caracal_html_has_required_sections(self):
        src = self._app_src()
        for section in ("Preflight", "Principals", "Tools", "Mandates", "Authority Ledger", "Traces"):
            assert section in src, f"Missing section in _CARACAL_HTML: {section}"

    def test_caracal_html_has_api_endpoints(self):
        src = self._app_src()
        for endpoint in ("/api/preflight", "/api/principals", "/api/tools", "/api/mandates",
                         "/api/authority_ledger", "/api/traces"):
            assert endpoint in src, f"Missing endpoint reference: {endpoint}"

    def test_customer_html_has_worker_grid_and_run_endpoint(self):
        src = self._app_src()
        assert "renderWorkers" in src or "worker" in src.lower()
        assert "/api/run" in src


# ---------------------------------------------------------------------------
# Worker fan-out configuration (R1a)
# ---------------------------------------------------------------------------

class TestWorkerFanOutConfig:
    def test_all_worker_config_lists_same_length(self):
        from examples.langchain_demo.demo_runtime import (
            _WORKER_ACTION_SCOPES,
            _WORKER_LABELS,
            _WORKER_RESOURCE_SCOPES,
            _WORKER_TOOLS,
        )

        assert len(_WORKER_LABELS) == len(_WORKER_TOOLS)
        assert len(_WORKER_TOOLS) == len(_WORKER_RESOURCE_SCOPES)
        assert len(_WORKER_RESOURCE_SCOPES) == len(_WORKER_ACTION_SCOPES)

    def test_worker_labels_are_distinct(self):
        from examples.langchain_demo.demo_runtime import _WORKER_LABELS

        assert len(set(_WORKER_LABELS)) == len(_WORKER_LABELS)

    def test_first_three_workers_are_not_denial(self):
        from examples.langchain_demo.demo_runtime import _WORKER_LABELS

        for label in _WORKER_LABELS[:3]:
            assert "denial" not in label

    def test_fourth_worker_causes_scope_mismatch(self):
        from examples.langchain_demo.demo_runtime import (
            _WORKER_ACTION_SCOPES,
            _WORKER_TOOLS,
        )

        tool = _WORKER_TOOLS[3]
        action = _WORKER_ACTION_SCOPES[3]
        tool_resource = tool.split(":")[-2] if ":" in tool else ""
        action_resource = action.split(":")[-2] if ":" in action else ""
        assert tool_resource != action_resource, (
            "denial-demo worker should have tool and action scope mismatch"
        )


# ---------------------------------------------------------------------------
# Run result aggregation (R1a)
# ---------------------------------------------------------------------------

class TestRunResultAggregation:
    def test_worker_result_has_required_fields(self):
        from examples.langchain_demo.demo_runtime import WorkerResult

        wr = WorkerResult(
            worker_name="test-worker",
            principal_id="pid",
            tool_id="demo:ops:incidents:read",
            success=True,
            result={"data": 1},
            error=None,
            latency_ms=10.0,
        )
        assert wr.result_type == "allowed"
        assert wr.denial_reason == ""
        assert wr.lifecycle_events == []

    def test_worker_result_denial_fields(self):
        from examples.langchain_demo.demo_runtime import WorkerResult

        wr = WorkerResult(
            worker_name="denial-demo",
            principal_id="pid",
            tool_id="demo:ops:deployments:read",
            success=False,
            result=None,
            error="authority denied",
            latency_ms=5.0,
            result_type="enforcement_deny",
            denial_reason="authority denied",
        )
        assert wr.result_type == "enforcement_deny"
        assert wr.denial_reason == "authority denied"

    def test_run_result_workers_list(self):
        from examples.langchain_demo.demo_runtime import RunResult, WorkerResult

        w = WorkerResult(
            worker_name="w", principal_id="p", tool_id="t",
            success=True, result={}, error=None, latency_ms=1.0,
        )
        rr = RunResult(
            run_id="run1",
            workspace_id="ws",
            mode="mock",
            orchestrator_principal_id="orch",
            workers=[w],
            recommendation={},
            trace_events=[],
        )
        assert len(rr.workers) == 1
        assert rr.workers[0].worker_name == "w"


# ---------------------------------------------------------------------------
# Enforcement regression: P0.14 provider credential checks (mock-based)
# ---------------------------------------------------------------------------

class TestProviderContractChecks:
    """P0.14: provider check verifies resource/action contracts and credential refs."""

    def _pf(self, row):
        from unittest.mock import MagicMock
        from examples.langchain_demo.preflight import WorkspacePreflight

        session = MagicMock()
        session.query.return_value.filter_by.return_value.first.return_value = row
        return WorkspacePreflight(session, "demo-workspace")

    def test_fails_when_auth_scheme_needs_credential_ref(self):
        from unittest.mock import MagicMock

        row = MagicMock()
        row.enabled = True
        row.resources = ["incidents"]
        row.actions = ["read"]
        row.auth_scheme = "oauth2_client_credentials"
        row.credential_ref = None
        row.provider_definition = "ops-api"
        result = self._pf(row)._check_provider()
        assert result.passed is False
        assert "credential" in result.detail.lower()

    def test_passes_with_resource_action_contracts_no_auth(self):
        from unittest.mock import MagicMock

        row = MagicMock()
        row.enabled = True
        row.resources = ["incidents", "deployments"]
        row.actions = ["read", "write"]
        row.auth_scheme = "api_key"
        row.credential_ref = None
        row.provider_definition = "ops-api"
        result = self._pf(row)._check_provider()
        assert result.passed is True
        assert "resources=2" in result.detail

    def test_fails_when_resource_action_contracts_empty(self):
        from unittest.mock import MagicMock

        row = MagicMock()
        row.enabled = True
        row.resources = []
        row.actions = []
        row.auth_scheme = "none"
        row.credential_ref = None
        row.provider_definition = "custom"
        result = self._pf(row)._check_provider()
        assert result.passed is False
        assert "resource" in result.detail.lower() or "contract" in result.detail.lower()

    def test_passes_with_gateway_only_auth_when_credential_ref_set(self):
        from unittest.mock import MagicMock

        row = MagicMock()
        row.enabled = True
        row.resources = ["incidents"]
        row.actions = ["read"]
        row.auth_scheme = "service_account"
        row.credential_ref = "ops-api-cred-ref"
        row.provider_definition = "ops-api"
        result = self._pf(row)._check_provider()
        assert result.passed is True
