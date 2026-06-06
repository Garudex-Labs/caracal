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
