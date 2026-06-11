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
        (
            "/overview/about",
            "About Lynx Capital",
            "/overview/architecture",
            "disabled-btn",
        ),
        (
            "/overview/architecture",
            "Architecture &amp; Providers",
            "/overview/notice",
            "/overview/about",
        ),
        (
            "/overview/notice",
            "Demo Environment Notice",
            "Proceed to Setup",
            "/overview/architecture",
        ),
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
        body = allowed.text
        assert "Setup" in body
        assert "Connect Lynx Capital to Caracal" in body


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
        body = allowed.text
        assert "Setup" in body
        assert "Connect Lynx Capital to Caracal" in body


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
    assert (
        'data-setup-panel="providers" aria-labelledby="providers-heading" hidden'
        in body
    )
    assert (
        'data-setup-panel="validation" aria-labelledby="validation-heading" hidden'
        in body
    )
    assert 'data-setup-panel="launch" aria-labelledby="launch-heading" hidden' in body
    assert "function showSetupSection(name)" in body
    # Automation is a popup action, not a setup section
    assert "Automate Setup" in body
    assert "Automate setup" in body
    assert "Go to Caracal Console &gt; Zones &gt; New" in body
    assert '<b>name</b> = <code>"Lynx Capital"</code>' in body
    assert "One zone backs the whole platform." in body
    assert "Go to Control &gt; control key create" in body
    assert '<b>name</b> = <code>"Lynx Capital Bootstrap"</code>' in body
    assert "<b>max token TTL</b> = <code>300</code>" in body
    assert "<b>expires in days</b> = <code>30</code>" in body
    assert "control:identity-provider:write" in body
    assert "control:resource:write" in body
    assert "CONTROL_CLIENT_ID" in body
    assert "CONTROL_CLIENT_SECRET" in body
    assert "Add to examples/lynxCapital/.env.provision" in body
    assert "python scripts/provision.py" in body
    assert "python scripts/teardown.py" in body
    # Caracal configuration: zone, per-boundary applications, providers, views, policy set
    assert "Caracal configuration" in body
    assert "field-name" in body
    assert "field-value" in body
    assert "Create the zone" in body
    assert '<dt class="field-name">Name</dt>' in body
    assert '<dd class="field-value">&#34;Lynx Capital&#34;</dd>' in body
    assert "Create one managed application per permission boundary" in body
    assert '<dt class="field-name">Registration method</dt>' in body
    assert '<dd class="field-value">managed</dd>' in body
    for boundary in (
        "lynx-operations",
        "lynx-intake",
        "lynx-ledger",
        "lynx-compliance",
        "lynx-treasury",
        "lynx-payments",
        "lynx-audit",
    ):
        assert boundary in body
    assert "Register the partner credential providers" in body
    assert "Create the per-application resource views" in body
    assert "Author the policy library and activate the policy set" in body
    assert "Run agents as labeled Caracal sessions" in body
    assert "Grant.narrow" in body
    # The single-app / single-baseline-policy and per-tenant-DCR anti-patterns must be gone
    assert "Lynx Capital baseline" not in body
    assert "[ ] leave unchecked" not in body
    assert "per-tenant DCR" not in body
    assert "tenant-aurora" not in body
    assert "lynx-portfolio" not in body
    assert "pf-mandate" not in body
    assert "CARACAL_APPLICATION_ID" not in body
    assert "CARACAL_RESOURCES" not in body
    assert "LYNX_RESOURCE_" not in body
    # Workload env block: one zone id plus per-boundary application credentials.
    assert "CARACAL_ZONE_ID=&lt;zone-id&gt;" in body
    assert (
        "LYNX_CARACAL_OPERATIONS_APPLICATION_ID=&lt;lynx-operations-application-id&gt;"
        in body
    )
    assert (
        "LYNX_CARACAL_OPERATIONS_CLIENT_SECRET=&lt;lynx-operations-client-secret&gt;"
        in body
    )
    assert "LYNX_CARACAL_AUDIT_APPLICATION_ID=&lt;lynx-audit-application-id&gt;" in body
    assert "OPENAI_API_KEY=sk-..." in body
    assert 'CONTROL_CLIENT_ID="&lt;control-key-client-id&gt;"' in body
    assert 'CONTROL_CLIENT_SECRET="&lt;one-time-control-key-secret&gt;"' in body
    # Providers: registered with Caracal in provider-supported format, with per-app views
    assert "Providers" in body
    assert "provider-table" in body
    assert "provider://halcyon-bank" in body
    assert "provider://meridian-pay" in body
    assert "provider://relay-automation" in body
    assert "resource://audit-meridian" in body
    assert "oauth2_authorization_code" in body
    assert "caracal_mandate" in body
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
    assert 'data-check="identity"' in body
    assert 'data-check="applications"' in body
    assert 'data-check="providers"' in body
    assert 'data-check="resources"' in body
    assert "CARACAL_ZONE_ID is set" in body
    assert "Every application has an id and secret" in body
    assert "All partners registered with Caracal" in body
    assert "Per-application views created and bound" in body
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


def test_demo_prompts_and_logs_are_accessible_after_setup_completion():
    with TestClient(app) as client:
        client.cookies.set("lynx_accepted", "1")
        client.cookies.set("lynx_setup", "1")
        for path in ("/demo", "/prompts", "/logs"):
            response = client.get(path, follow_redirects=False)
            assert response.status_code == 200
            assert response.text.strip()


def test_demo_workspace_is_end_user_focused():
    with TestClient(app) as client:
        client.cookies.set("lynx_accepted", "1")
        client.cookies.set("lynx_setup", "1")
        response = client.get("/demo")
    assert response.status_code == 200
    body = response.text
    assert "What would you like the team to handle?" in body
    assert "welcome-link" in body
    assert "Browse example prompts" in body
    assert "welcome-task" not in body
    assert "Agent workload" in body
    assert "Plan of work" in body
    assert "Live activity" in body
    assert "Workflow map" in body
    assert "Activity history" in body
    assert "Orchestration graph" not in body
    assert "Memory pressure" not in body
    assert "Runtime counters" not in body
    assert "Execution timeline" not in body


def test_provision_scripts_exist_and_build_plan():
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
        sys.path.remove(str(root))
        sys.path.remove(str(scripts_dir))

    import json
    import re

    model = tenancy.load_model()
    stub_env = {
        name: f"https://stub.lynx.test/{name.lower()}"
        for provider in model.providers
        for name in re.findall(r"\$\{([A-Z0-9_]+)", json.dumps(provider.config))
    }
    providers = tenancy.provider_commands(model, env=stub_env)
    assert {c["flags"]["identifier"] for c in providers} == {
        p.identifier for p in model.providers
    }
    assert "provider://halcyon-bank" in {c["flags"]["identifier"] for c in providers}

    provider_ids = {
        c["flags"]["identifier"]: c["flags"]["identifier"] for c in providers
    }
    application_ids = {a.id: f"app_{a.id}" for a in model.applications}
    resources = tenancy.resource_commands(model, provider_ids, application_ids)
    assert {c["flags"]["identifier"] for c in resources} == {
        r.identifier for r in model.resources
    }
    assert len(resources) == len(model.resources)

    policies = tenancy.policy_commands(model)
    assert policies[0]["flags"]["name"] == "00-base"
    assert all("package caracal.authz" in c["flags"]["content"] for c in policies)

    import pytest

    with pytest.raises(control_client.ControlError):
        control_client.config_from_env({})
    config = control_client.config_from_env(
        {
            "CONTROL_CLIENT_ID": "<control-key-client-id>",
            "CONTROL_CLIENT_SECRET": "<one-time-control-key-secret>",
        }
    )
    assert config.scopes == control_client.SCOPES
    assert "control:resource:write" in control_client.SCOPES
    assert "control:policy-set:write" in control_client.SCOPES
