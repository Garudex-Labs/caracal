"""Shared expected-output loading and acceptance checks for the demo."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .scenario_analysis import business_outcomes


def default_expected_outcomes_path() -> Path:
    return Path(__file__).resolve().parent / "fixtures" / "expected_outcomes.json"


def load_expected_outcomes(path: str | Path | None = None) -> dict[str, Any]:
    resolved = Path(path) if path else default_expected_outcomes_path()
    return json.loads(resolved.read_text(encoding="utf-8"))


def _sorted_strings(values: list[Any]) -> list[str]:
    return sorted(str(value) for value in values if str(value).strip())


def evaluate_business_outcomes(
    observed: dict[str, Any],
    expected: dict[str, Any],
) -> dict[str, Any]:
    observed_departments = [
        str(entry.get("department"))
        for entry in observed.get("over_budget_departments", [])
        if isinstance(entry, dict) and entry.get("department")
    ]
    checks = [
        {
            "name": "company",
            "passed": str(observed.get("company")) == str(expected.get("company")),
            "expected": expected.get("company"),
            "observed": observed.get("company"),
        },
        {
            "name": "over_budget_departments",
            "passed": _sorted_strings(observed_departments)
            == _sorted_strings(expected.get("over_budget_departments", [])),
            "expected": _sorted_strings(expected.get("over_budget_departments", [])),
            "observed": _sorted_strings(observed_departments),
        },
        {
            "name": "pending_invoice_ids",
            "passed": _sorted_strings(observed.get("pending_invoice_ids", []))
            == _sorted_strings(expected.get("pending_invoice_ids", [])),
            "expected": _sorted_strings(expected.get("pending_invoice_ids", [])),
            "observed": _sorted_strings(observed.get("pending_invoice_ids", [])),
        },
        {
            "name": "degraded_services",
            "passed": _sorted_strings(observed.get("degraded_services", []))
            == _sorted_strings(expected.get("degraded_services", [])),
            "expected": _sorted_strings(expected.get("degraded_services", [])),
            "observed": _sorted_strings(observed.get("degraded_services", [])),
        },
        {
            "name": "recent_incident_ids",
            "passed": _sorted_strings(observed.get("recent_incident_ids", []))
            == _sorted_strings(expected.get("recent_incident_ids", [])),
            "expected": _sorted_strings(expected.get("recent_incident_ids", [])),
            "observed": _sorted_strings(observed.get("recent_incident_ids", [])),
        },
        {
            "name": "vendor_sla_breaches",
            "passed": _sorted_strings(observed.get("vendor_sla_breaches", []))
            == _sorted_strings(expected.get("vendor_sla_breaches", [])),
            "expected": _sorted_strings(expected.get("vendor_sla_breaches", [])),
            "observed": _sorted_strings(observed.get("vendor_sla_breaches", [])),
        },
        {
            "name": "priority_action_ids",
            "passed": _sorted_strings(
                [
                    action.get("action_id")
                    for action in observed.get("priority_actions", [])
                    if isinstance(action, dict)
                ]
            )
            == _sorted_strings(expected.get("priority_action_ids", [])),
            "expected": _sorted_strings(expected.get("priority_action_ids", [])),
            "observed": _sorted_strings(
                [
                    action.get("action_id")
                    for action in observed.get("priority_actions", [])
                    if isinstance(action, dict)
                ]
            ),
        },
    ]
    return {
        "passed": all(check["passed"] for check in checks),
        "checks": checks,
    }


def attach_acceptance(
    payload: dict[str, Any],
    scenario: dict[str, Any],
    *,
    expected_path: str | Path | None = None,
) -> dict[str, Any]:
    expected = load_expected_outcomes(expected_path)
    observed = payload.get("business_outcomes")
    if not isinstance(observed, dict):
        observed = business_outcomes(scenario)
        payload["business_outcomes"] = observed

    payload["acceptance"] = evaluate_business_outcomes(observed, expected)
    return payload
