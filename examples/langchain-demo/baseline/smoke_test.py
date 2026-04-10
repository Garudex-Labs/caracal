"""Minimal smoke test for the baseline LangChain swarm demo."""

from __future__ import annotations

from .scenario import load_scenario
from .workflow import run_mock_workflow


def run_smoke_test() -> None:
    scenario = load_scenario()
    result = run_mock_workflow(scenario)

    assert result["mode"] == "mock"
    assert isinstance(result.get("timeline"), list)
    assert len(result["timeline"]) >= 6
    summary = result.get("tool_invocation_summary") or {}
    assert summary.get("total", 0) >= 6
    assert isinstance(summary.get("by_tool"), dict)
    assert isinstance(result.get("final_summary"), str)
    assert result["final_summary"].strip()


def main() -> int:
    run_smoke_test()
    print("Baseline smoke test passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
