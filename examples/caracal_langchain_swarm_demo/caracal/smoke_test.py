"""Smoke test for Caracal governed mock workflow."""

from __future__ import annotations

from ..baseline.scenario import load_scenario
from .workflow import run_mock_governed_workflow


def run_smoke_test() -> None:
    scenario = load_scenario()
    result = run_mock_governed_workflow(scenario)

    assert result["mode"] == "mock-governed"
    assert isinstance(result.get("timeline"), list)
    assert len(result["timeline"]) >= 4
    assert isinstance(result.get("final_summary"), str)
    assert result["final_summary"].strip()

    delegation = result.get("delegation") or {}
    assert delegation.get("verified") is True
    assert isinstance(delegation.get("edges"), list)
    assert len(delegation["edges"]) >= 3

    revocation = result.get("revocation") or {}
    assert revocation.get("executed") is True
    assert revocation.get("denial_captured") is True

    authority_evidence = result.get("authority_evidence")
    assert isinstance(authority_evidence, list)
    assert authority_evidence


if __name__ == "__main__":
    run_smoke_test()
    print("Governed mock smoke test passed")
