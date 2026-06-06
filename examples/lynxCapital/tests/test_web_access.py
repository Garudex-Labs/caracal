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
    assert "Get Started" in body
    assert "About Lynx Capital" in body
    assert "Architecture & Providers" in body
    assert "Demo Environment Notice" in body
    assert "Proceed to Setup" in body
    assert "I understand that this is a demonstration environment" in body
    assert "width: min(960px" in body
    assert "height: 680px" in body
    assert "height: 464px" in body
    assert "rgba(" not in body
    assert "gradient(" not in body
    assert "box-shadow" not in body
    overview_card_block = body.split(".overview-card {", 1)[1].split("}", 1)[0]
    assert "background:" not in overview_card_block
    assert "border:" not in overview_card_block
    assert "border-radius" not in overview_card_block
    assert "Halcyon Bank" not in body
    assert "Provider ecosystem" not in body


def test_protected_pages_redirect_without_acceptance_even_if_setup_cookie_exists():
    with TestClient(app) as client:
        client.cookies.set("lynx_setup", "1")
        for path in ("/setup", "/demo", "/prompts", "/logs"):
            response = client.get(path, follow_redirects=False)
            assert response.status_code == 303
            assert response.headers["location"] == "/"


def test_setup_completion_requires_terms_acceptance():
    with TestClient(app) as client:
        blocked = client.post("/api/session/setup-complete")
        assert blocked.status_code == 403

        client.post("/api/session/accept")
        allowed = client.post("/api/session/setup-complete")
        assert allowed.status_code == 200
        assert allowed.json() == {"setup": True}


def test_setup_requires_final_onboarding_acknowledgement():
    with TestClient(app) as client:
        blocked = client.get("/setup", follow_redirects=False)
        assert blocked.status_code == 303
        assert blocked.headers["location"] == "/"

        client.post("/api/session/accept")
        allowed = client.get("/setup", follow_redirects=False)
        assert allowed.status_code == 200


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
