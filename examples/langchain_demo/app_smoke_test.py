"""Smoke test for the FastAPI demo app."""

from __future__ import annotations

from fastapi.testclient import TestClient

from .app import create_app


def run_smoke_test() -> None:
    client = TestClient(create_app())

    scenario_response = client.get("/api/scenario")
    assert scenario_response.status_code == 200
    assert scenario_response.json()["company"] == "Northstar Retail"

    run_response = client.post(
        "/api/run",
        json={
            "mode": "mock",
            "provider_strategy": "mixed",
            "include_revocation_check": True,
        },
    )
    assert run_response.status_code == 200
    payload = run_response.json()
    assert payload["mode"] == "caracal-demo-mock"
    assert payload["acceptance"]["passed"] is True
    assert payload["revocation"]["denial_captured"] is True


def main() -> int:
    run_smoke_test()
    print("App smoke test passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
