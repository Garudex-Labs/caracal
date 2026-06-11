"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Offline tests exercising the Caracal SDK seam, the per-agent runner, and the governed
partner dispatch without a running control plane.
"""
from __future__ import annotations

import asyncio

import pytest

from app import caracal, tenancy
from app.agents.runner import AgentRunner, create_runner, get_runner
from app.services import partners


def test_disabled_without_env(monkeypatch):
    monkeypatch.setattr(tenancy, "load_provisioned", lambda: {})
    assert caracal.enabled() is False
    assert caracal.application_credentials("operations") == (False, False)
    with pytest.raises(RuntimeError):
        caracal.runtime("operations")
    assert caracal.runtimes() == {}


def test_enabled_requires_zone_and_operations_credentials(monkeypatch):
    monkeypatch.setenv("CARACAL_ZONE_ID", "zone_demo")
    assert caracal.enabled() is False
    monkeypatch.setenv("LYNX_CARACAL_OPERATIONS_APPLICATION_ID", "app_ops")
    assert caracal.enabled() is False
    monkeypatch.setenv("LYNX_CARACAL_OPERATIONS_CLIENT_SECRET", "secret")
    assert caracal.enabled() is True
    assert caracal.application_credentials("operations") == (True, True)


def test_startup_fails_closed_when_a_boundary_is_unconfigured(monkeypatch):
    monkeypatch.setenv("CARACAL_ZONE_ID", "zone_demo")
    monkeypatch.setenv("LYNX_CARACAL_OPERATIONS_APPLICATION_ID", "app_ops")
    monkeypatch.setenv("LYNX_CARACAL_OPERATIONS_CLIENT_SECRET", "secret")
    with pytest.raises(RuntimeError, match="LYNX_CARACAL_"):
        caracal.startup()


def test_startup_builds_one_runtime_per_application(monkeypatch):
    monkeypatch.setenv("CARACAL_ZONE_ID", "zone_demo")
    model = tenancy.load_model()
    for app in model.applications:
        key = app.id.upper().replace("-", "_")
        monkeypatch.setenv(f"LYNX_CARACAL_{key}_APPLICATION_ID", f"app_{app.id}")
        monkeypatch.setenv(f"LYNX_CARACAL_{key}_CLIENT_SECRET", f"secret_{app.id}")
    caracal.startup()
    try:
        runtimes = caracal.runtimes()
        assert set(runtimes) == {app.id for app in model.applications}
        for app in model.applications:
            runtime = caracal.runtime(app.id)
            assert runtime.application_id == f"app_{app.id}"
            assert runtime.views == [r.identifier for r in model.application_resources(app.id)]
            assert type(runtime.client).__name__ == "Caracal"
    finally:
        asyncio.run(caracal.aclose())
    with pytest.raises(RuntimeError):
        caracal.runtime("operations")


def test_worker_grant_is_minimal():
    grant = caracal.worker_grant(["meridian:payout"], ["resource://payments-meridian"])
    assert grant.mode == "narrow"
    assert grant.scopes == ("meridian:payout",)
    assert grant.constraints.resources == ["resource://payments-meridian"]
    assert grant.constraints.max_hops == 1
    assert grant.constraints.ttl_seconds == caracal.WORKER_TTL_SECONDS
    assert grant.ttl_seconds == caracal.WORKER_TTL_SECONDS


class _StubClient:
    def __init__(self):
        self.calls: list[tuple] = []

    def mint_mandate(self, resource_id, scopes, *, ctx=None, ttl_seconds=None):
        self.calls.append((resource_id, tuple(scopes), ctx, ttl_seconds))
        return f"mandate-{len(self.calls)}"


class _StubRuntime:
    key = "payments"

    def __init__(self):
        self.client = _StubClient()


class _StubCtx:
    agent_session_id = "agent_1"
    delegation_edge_id = "edge_1"


def test_worker_authority_scopes_and_mandate_delegation():
    runtime = _StubRuntime()
    ctx = _StubCtx()
    authority = caracal.WorkerAuthority(runtime, ctx, "payment-execution", ["meridian:payout"])
    assert authority.application == "payments"
    assert authority.agent_session_id == "agent_1"
    assert authority.allows("meridian:payout")
    assert not authority.allows("meridian:charge")
    token = authority.mandate("resource://payments-meridian", ["meridian:payout"])
    assert token == "mandate-1"
    assert runtime.client.calls == [
        ("resource://payments-meridian", ("meridian:payout",), ctx, caracal.MANDATE_TTL_SECONDS)
    ]


def test_runner_local_spawn_tracks_identity_without_caracal():
    runner = create_runner("run-local")
    assert get_runner("run-local") is runner
    fc = runner.spawn("finance-control", "run", parent=None, layer="orchestrator")
    worker = runner.spawn("payment-execution", "payments.us", parent=fc, layer="worker", region="US")
    assert worker.authority is None
    assert worker.parent_id == fc.id
    assert runner.handle(worker.id) is worker
    worker.terminate()
    assert worker.status == "completed"
    with pytest.raises(RuntimeError):
        worker.terminate()


def test_runner_rejects_unknown_role():
    from app.core.workers import WorkerPool

    runner = AgentRunner("run-roles")
    parent = runner.spawn("regional-orchestrator", "region.us", parent=None, layer="orchestrator", region="US")
    pool = WorkerPool("run-roles", runner, parent)
    with pytest.raises(ValueError):
        pool.acquire("no-such-role", "scope")


def test_customer_identity_propagates_through_spawn():
    from app.core.workers import WorkerPool
    from app.events.bus import bus

    runner = AgentRunner("run-cust")
    parent = runner.spawn("workflow-orchestrator", "wf.ar", parent=None, layer="orchestrator")
    pool = WorkerPool("run-cust", runner, parent)
    worker = pool.acquire("receivables", "ar-dun:cust-204", customer_id="cust-204")
    assert worker.customer_id == "cust-204"
    spawn_events = [
        e for e in bus.history("run-cust")
        if e.kind == "agent_spawn" and e.payload["agent_id"] == worker.id
    ]
    assert spawn_events and spawn_events[0].payload["customer_id"] == "cust-204"

    assert tenancy.agent_labels("receivables", "cust-204") == [
        "receivables", "lynx-swarm", "customer:cust-204",
    ]
    metadata = tenancy.agent_metadata("run-cust", worker.id, "ar-dun:cust-204", customer_id="cust-204")
    assert metadata["customer_id"] == "cust-204"
    assert tenancy.agent_labels("receivables") == ["receivables", "lynx-swarm"]
    assert "customer_id" not in tenancy.agent_metadata("run-cust", worker.id, "ar-summary")

    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as client:
        body = client.get("/api/logs/recent", params={"customerId": "cust-204"}).json()
    assert body["events"]
    assert all(e["payload"].get("customer_id") == "cust-204" for e in body["events"])


def test_partner_call_fails_closed_without_caracal_or_simulation(monkeypatch):
    monkeypatch.delenv("LYNX_SIMULATION", raising=False)
    with pytest.raises(partners.PartnerError, match="fails closed|simulation mode is off"):
        partners.call("meridian-pay", "get_balance", {})


def test_partner_call_requires_authority_when_caracal_enabled(monkeypatch):
    monkeypatch.setenv("CARACAL_ZONE_ID", "zone_demo")
    monkeypatch.setenv("LYNX_CARACAL_OPERATIONS_APPLICATION_ID", "app_ops")
    monkeypatch.setenv("LYNX_CARACAL_OPERATIONS_CLIENT_SECRET", "secret")
    with pytest.raises(partners.PartnerError, match="no agent authority"):
        partners.call("meridian-pay", "get_balance", {})


def test_gateway_dispatch_routes_scope_view_and_path(monkeypatch):
    monkeypatch.setenv("CARACAL_ZONE_ID", "zone_demo")
    monkeypatch.setenv("LYNX_CARACAL_OPERATIONS_APPLICATION_ID", "app_ops")
    monkeypatch.setenv("LYNX_CARACAL_OPERATIONS_CLIENT_SECRET", "secret")

    calls: list[tuple] = []

    class _Response:
        status_code = 200
        is_success = True

        def json(self):
            return {"data": {"ok": True}}

    class _Authority:
        application = "payments"
        role = "payment-execution"

        def allows(self, scope):
            return scope == "meridian:payout"

        def gateway_post(self, view, path, payload, scopes, *, timeout_s=8.0):
            calls.append((view, path, payload, scopes))
            return _Response()

    result = partners.call("meridian-pay", "create_payout", {"amount": 100}, authority=_Authority())
    assert result["status"] == 200 and result["data"] == {"ok": True}
    assert calls == [("resource://payments-meridian", "/api/create_payout",
                      {"amount": 100}, ["meridian:payout"])]

    with pytest.raises(partners.PartnerError, match="lacks scope"):
        partners.call("meridian-pay", "list_charges", {}, authority=_Authority())


def test_gateway_dispatch_fails_closed_outside_the_application_views(monkeypatch):
    monkeypatch.setenv("CARACAL_ZONE_ID", "zone_demo")
    monkeypatch.setenv("LYNX_CARACAL_OPERATIONS_APPLICATION_ID", "app_ops")
    monkeypatch.setenv("LYNX_CARACAL_OPERATIONS_CLIENT_SECRET", "secret")

    class _Authority:
        application = "audit"
        role = "audit"

        def allows(self, scope):
            return True

        def gateway_post(self, *args, **kwargs):
            raise AssertionError("must not reach the gateway")

    with pytest.raises(partners.PartnerError, match="has no view"):
        partners.call("meridian-pay", "create_payout", {}, authority=_Authority())
