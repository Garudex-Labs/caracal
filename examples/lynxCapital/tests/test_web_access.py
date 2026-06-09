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
    assert "Connect Lynx Capital to Caracal" in body
    assert "progress-strip" in body
    assert 'id="automation-open"' in body
    assert 'id="automation-popup"' in body
    assert 'data-setup-tab="caracal" aria-selected="true"' in body
    assert 'data-setup-tab="providers" aria-selected="false"' in body
    assert 'data-setup-tab="validation" aria-selected="false"' in body
    assert 'data-setup-tab="launch" aria-selected="false"' in body
    assert 'data-setup-tab="automate"' not in body
    assert 'data-setup-panel="automate"' not in body
    assert 'data-setup-panel="caracal" aria-labelledby="caracal-heading"' in body
    assert 'data-setup-panel="providers" aria-labelledby="providers-heading" hidden' in body
    assert 'data-setup-panel="validation" aria-labelledby="validation-heading" hidden' in body
    assert 'data-setup-panel="launch" aria-labelledby="launch-heading" hidden' in body
    assert "function showSetupSection(name)" in body
    # Automation is a popup action, not a setup section
    assert "Automate Setup" in body
    assert "Automate setup" in body
    assert "Go to Caracal Console &gt; Zones &gt; New" in body
    assert "<b>name</b> = <code>\"Lynx Capital\"</code>" in body
    assert "Enable <b>dynamic clients</b> (required for per-tenant DCR apps)." in body
    assert "Go to Control &gt; control key create" in body
    assert "<b>name</b> = <code>\"Lynx Capital Bootstrap\"</code>" in body
    assert "<b>max token TTL</b> = <code>300</code>" in body
    assert "<b>expires in days</b> = <code>30</code>" in body
    assert "control:identity-provider:write" in body
    assert "control:resource:write" in body
    assert "CARACAL_ZONE_ID" in body
    assert "CONTROL_CLIENT_ID" in body
    assert "CONTROL_CLIENT_SECRET" in body
    assert "Add to examples/lynxCapital/.env" in body
    assert "The scripts load <code>.env</code> automatically." in body
    assert "python scripts/provision.py" in body
    assert "python scripts/teardown.py" in body
    # Caracal configuration: zone, managed platform app, policy library, per-tenant DCR
    assert "Caracal configuration" in body
    assert "field-name" in body
    assert "field-value" in body
    assert "Create the zone" in body
    assert '<dt class="field-name">Name</dt>' in body
    assert '<dd class="field-value">&#34;Lynx Capital&#34;</dd>' in body
    assert '<dt class="field-name">Dynamic clients</dt>' in body
    assert '<dd class="field-value">[x] enabled (required for per-tenant DCR apps)</dd>' in body
    assert "Create the managed platform application" in body
    assert "Go to Applications &gt; New in the &#34;Lynx Capital&#34; zone" in body
    assert '<dt class="field-name">Registration method</dt>' in body
    assert '<dd class="field-value">managed</dd>' in body
    assert '<dd class="field-value">&#34;lynx-platform&#34;</dd>' in body
    assert "Import the policy library and activate the policy set" in body
    assert '<dd class="field-value">examples/lynxCapital/policies</dd>' in body
    assert '<dd class="field-value">&#34;lynx-multitenant&#34;</dd>' in body
    assert "Register a DCR application per tenant" in body
    assert '<dd class="field-value">tenant-aurora, tenant-borealis</dd>' in body
    assert '<dd class="field-value">dcr</dd>' in body
    # The single-app / single-baseline-policy anti-pattern must be gone
    assert "Lynx Capital baseline" not in body
    assert "[ ] leave unchecked" not in body
    assert "CARACAL_ZONE_ID=&lt;placeholder-zone-id&gt;" in body
    assert "CARACAL_APPLICATION_ID=&lt;placeholder-managed-application-id&gt;" in body
    assert "CARACAL_APP_CLIENT_SECRET=&lt;placeholder-application-secret&gt;" in body
    assert 'CONTROL_CLIENT_ID="&lt;placeholder-control-client-id&gt;"' in body
    assert 'CONTROL_CLIENT_SECRET="&lt;placeholder-control-client-secret&gt;"' in body
    assert 'export CARACAL_ZONE_ID="<placeholder-zone-id>"' not in body
    assert "Add these values to <code>examples/lynxCapital/.env</code>" in body
    # Providers: manual mapping to Caracal resources
    assert "Providers" in body
    assert "resource://halcyon-bank" in body
    assert "oauth2_authorization_code" in body
    assert "Open provider console" in body
    assert "Create credentials" in body
    assert "Provider docs" in body
    assert "/__lab/credentials" in body
    assert "/__lab/clients" in body
    assert "/__lab/resources" in body
    assert "Halcyon Bank" in body
    assert "Quetzal Payouts" in body
    assert "Junction Procurement" in body
    # Validation: user-facing checks only, no infra health
    assert "Required identifiers" in body
    assert "Application access" in body
    assert "Caracal mapping" in body
    assert "Provider setup" in body
    assert "Run Validation" in body
    assert "Launch Demo" in body
    assert "Open Workspace" in body
    assert "Start First Workflow" in body
    # No infra/service health surfaced to the end user
    assert "Environment Readiness" not in body
    assert "healthy" not in body
    assert "CONTROL_URL" not in body
    assert "STS_URL" not in body
    assert "CONTROL_AUDIENCE" not in body
    assert "caracal-control" not in body
    assert "http://127.0.0.1:8087" not in body
    assert "http://127.0.0.1:8080" not in body
    assert "http://localhost:9090" not in body
    assert "Service endpoints" not in body
    assert "CARACAL_STS_URL=http://localhost:8080" not in body
    # No legacy infra/startup commands
    assert "python -m _mock.providerlab.seedenv" not in body
    assert "docker compose -f _mock/docker-compose.yml up -d --build --wait" not in body
    assert "uv run uvicorn app.main:app --reload --port 8000" not in body
    assert "Start provider network" not in body
    assert "Launch Lynx Capital" not in body
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


def test_provision_scripts_exist_and_build_multitenant_plan():
    import sys
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent
    scripts_dir = root / "scripts"
    assert (scripts_dir / "provision.py").exists()
    assert (scripts_dir / "teardown.py").exists()
    assert (scripts_dir / "control_client.py").exists()
    assert (scripts_dir / "reference.py").exists()

    sys.path.insert(0, str(scripts_dir))
    sys.path.insert(0, str(root))
    try:
        import control_client
        from app import tenancy
    finally:
        sys.path.remove(str(scripts_dir))

    model = tenancy.load_model()
    managed = tenancy.managed_app_command(model)
    assert managed["subcommand"] == "create"
    assert managed["flags"]["name"] == "lynx-platform"

    dcr_apps = [tenancy.dcr_app_command(t)["flags"]["name"] for t in model.tenants]
    assert dcr_apps == ["tenant-aurora", "tenant-borealis"]

    policies = tenancy.policy_commands(model)
    assert policies[0]["flags"]["name"] == "00-base"
    assert all("package caracal.authz" in c["flags"]["content"] for c in policies)

    grants = tenancy.grant_specs(model)
    assert {g["tenant_id"] for g in grants} == {"aurora", "borealis"}

    import pytest

    with pytest.raises(control_client.ControlError):
        control_client.config_from_env({})
    config = control_client.config_from_env({
        "CONTROL_CLIENT_ID": "<placeholder-control-client-id>",
        "CONTROL_CLIENT_SECRET": "<placeholder-control-client-secret>",
    })
    assert config.scopes == control_client.SCOPES
    assert "control:app:write" in control_client.SCOPES
    assert "control:policy-set:write" in control_client.SCOPES
