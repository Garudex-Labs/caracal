"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for Lynx Capital web access gates and onboarding context.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app


def test_landing_is_lightweight_with_guided_onboarding():
    with TestClient(app) as client:
        response = client.get("/")
    assert response.status_code == 200
    body = response.text
    assert "Serious finance operations, safely simulated." in body
    assert "Continue Setup" in body
    assert "View Overview" in body
    assert 'href="/overview/about"' in body
    assert "Operating model" in body
    assert "Operational coverage" in body
    assert "operation-line" in body
    assert "data-operation-detail" in body
    assert "Vendor Operations" in body
    assert "3-page overview" in body
    assert "width: min(1360px" in body
    assert "@media (max-width: 1080px)" in body
    assert "@media (max-width: 760px)" in body
    assert "modal-backdrop" not in body
    assert "wizard-card" not in body
    assert "metric-row" not in body
    assert "value-card" not in body
    assert "coverage-item" not in body
    assert "rgba(" not in body
    assert "gradient(" not in body
    assert "box-shadow" not in body
    assert "Halcyon Bank" not in body
    assert "Provider ecosystem" not in body


def test_overview_pages_are_route_based_and_consistent():
    pages = [
        ("/overview/about", "About Lynx Capital", "/overview/architecture", "disabled-btn"),
        ("/overview/architecture", "Architecture &amp; Providers", "/overview/notice", "/overview/about"),
        ("/overview/notice", "Demo Environment Notice", "Proceed to Setup", "/overview/architecture"),
    ]
    with TestClient(app) as client:
        for path, title, next_marker, previous_marker in pages:
            response = client.get(path)
            assert response.status_code == 200
            body = response.text
            assert title in body
            assert next_marker in body
            assert previous_marker in body
            assert "overview-shell" in body
            assert "modal-backdrop" not in body
            assert "background: #111827" not in body
            assert "gradient(" not in body
            assert "box-shadow" not in body


def test_notice_page_requires_acknowledgement_before_setup():
    with TestClient(app) as client:
        notice = client.get("/overview/notice")
        assert notice.status_code == 200
        body = notice.text
        assert 'id="overview-ack"' in body
        assert 'id="proceed-setup"' in body
        assert "I understand that this is a demonstration environment" in body

        blocked = client.get("/setup", follow_redirects=False)
        assert blocked.status_code == 303
        assert blocked.headers["location"] == "/overview/about"

        client.post("/api/session/accept")
        allowed = client.get("/setup", follow_redirects=False)
        assert allowed.status_code == 200


def test_protected_pages_redirect_without_acceptance_even_if_setup_cookie_exists():
    with TestClient(app) as client:
        client.cookies.set("lynx_setup", "1")
        for path in ("/setup", "/demo", "/prompts", "/logs"):
            response = client.get(path, follow_redirects=False)
            assert response.status_code == 303
            assert response.headers["location"] == "/overview/about"


def test_setup_completion_requires_terms_acceptance():
    with TestClient(app) as client:
        blocked = client.post("/api/session/setup-complete")
        assert blocked.status_code == 403

        client.post("/api/session/accept")
        allowed = client.post("/api/session/setup-complete")
        assert allowed.status_code == 200
        assert allowed.json() == {"setup": True}


def test_setup_requires_final_overview_acknowledgement():
    with TestClient(app) as client:
        blocked = client.get("/setup", follow_redirects=False)
        assert blocked.status_code == 303
        assert blocked.headers["location"] == "/overview/about"

        client.post("/api/session/accept")
        allowed = client.get("/setup", follow_redirects=False)
        assert allowed.status_code == 200


def test_setup_page_is_guided_and_provider_backed():
    with TestClient(app) as client:
        client.post("/api/session/accept")
        response = client.get("/setup")
    assert response.status_code == 200
    body = response.text
    assert "<h1>Setup</h1>" in body
    assert "Confirm the environment, configure Caracal, review provider credentials" in body
    assert "progress-strip" in body
    assert 'data-setup-tab="environment" aria-selected="true"' in body
    assert 'data-setup-tab="caracal" aria-selected="false"' in body
    assert 'data-setup-tab="providers" aria-selected="false"' in body
    assert 'data-setup-tab="validation" aria-selected="false"' in body
    assert 'data-setup-tab="launch" aria-selected="false"' in body
    assert 'data-setup-panel="environment"' in body
    assert 'data-setup-panel="caracal" aria-labelledby="caracal-heading" hidden' in body
    assert 'data-setup-panel="providers" aria-labelledby="providers-heading" hidden' in body
    assert 'data-setup-panel="validation" aria-labelledby="validation-heading" hidden' in body
    assert 'data-setup-panel="launch" aria-labelledby="launch-heading" hidden' in body
    assert "function showSetupSection(name)" in body
    assert "Environment Readiness" in body
    assert "Live health for the Caracal services Lynx needs before setup continues." in body
    assert "/5 healthy" in body
    assert "http://localhost:3000" in body
    assert "http://localhost:8080" in body
    assert "http://localhost:8081" in body
    assert "http://localhost:9090" in body
    assert "http://localhost:4000" in body
    assert "Caracal Configuration" in body
    assert "Provider Credentials" in body
    assert "Validation" in body
    assert "Ready to Launch" in body
    assert "Run Validation" in body
    assert "Launch Demo" in body
    assert "Open Workspace" in body
    assert "Start First Workflow" in body
    assert "CARACAL_ZONE_ID=zone_lynxcapital" in body
    assert "CARACAL_APP_CLIENT_SECRET=&lt;application-secret&gt;" in body
    assert "CARACAL_STS_URL=http://localhost:8080" in body
    assert "CARACAL_RESOURCES=meridian-pay=http://127.0.0.1:9401,halcyon-bank=http://127.0.0.1:9400" in body
    assert "Caracal identity" in body
    assert "Application auth" in body
    assert "Service endpoints" in body
    assert "Resource bindings" in body
    assert "Provider access" in body
    assert "Halcyon Bank" in body
    assert "Quetzal Payouts" in body
    assert "Junction Procurement" in body
    assert "Credentials needed" in body
    assert "Open dashboard" in body
    assert "Create credentials" in body
    assert "Read provider docs" in body
    assert "/__lab/credentials" in body
    assert "/__lab/clients" in body
    assert "/__lab/resources" in body
    assert "python -m _mock.providerlab.seedenv" not in body
    assert "docker compose -f _mock/docker-compose.yml up -d --build --wait" not in body
    assert "uv run uvicorn app.main:app --reload --port 8000" not in body
    assert "Start provider network" not in body
    assert "Launch Lynx Capital" not in body
    assert ".panel {" not in body
    assert "Validate configuration" not in body
    assert "gradient(" not in body
    assert "box-shadow" not in body


def test_demo_prompts_and_logs_require_setup_after_acceptance():
    with TestClient(app) as client:
        client.post("/api/session/accept")
        for path in ("/demo", "/prompts", "/logs"):
            response = client.get(path, follow_redirects=False)
            assert response.status_code == 303
            assert response.headers["location"] == "/setup"


def test_demo_workspace_is_end_user_focused():
    with TestClient(app) as client:
        client.cookies.set("lynx_accepted", "1")
        client.cookies.set("lynx_setup", "1")
        response = client.get("/demo")
    assert response.status_code == 200
    body = response.text
    assert "What would you like the team to handle?" in body
    assert "welcome-task" in body
    assert "Run the Vendor Lifecycle workflow" in body
    assert "Agent workload" in body
    assert "Plan of work" in body
    assert "Live activity" in body
    assert "Workflow map" in body
    assert "Activity history" in body
    assert "Orchestration graph" not in body
    assert "Memory pressure" not in body
    assert "Runtime counters" not in body
    assert "Execution timeline" not in body
