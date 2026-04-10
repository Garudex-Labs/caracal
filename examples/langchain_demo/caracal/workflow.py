"""Governed workflow runner for the Caracal track."""

from __future__ import annotations

import json

from ..demo_runtime import DemoRunConfig, run_demo_workflow

GovernedRunConfig = DemoRunConfig


def run_mock_governed_workflow(scenario: dict[str, Any]) -> dict[str, Any]:
    return run_demo_workflow(scenario, DemoRunConfig(mode="mock"))


def run_governed_workflow(
    scenario: dict[str, Any],
    config: GovernedRunConfig,
) -> dict[str, Any]:
    return run_demo_workflow(scenario, config)


def write_output(path: str, payload: dict[str, Any]) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
