"""Smoke test for the FastAPI demo app module."""

from __future__ import annotations

from .app import create_app
from .baseline.scenario import load_scenario
from .caracal.workflow import GovernedRunConfig
from .demo_runtime import run_demo_workflow


def run_smoke_test() -> None:
    app = create_app()
    assert app.title == "Caracal Demo App"

    result = run_demo_workflow(
        load_scenario(),
        GovernedRunConfig(
            mode="mock",
            provider_strategy="mixed",
            include_revocation_check=True,
        ),
    )
    assert result["mode"] == "caracal-demo-mock"
    assert result["acceptance"]["passed"] is True
    assert result["revocation"]["denial_captured"] is True


def main() -> int:
    run_smoke_test()
    print("App smoke test passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
