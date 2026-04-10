"""Tool implementations for the baseline (non-Caracal) swarm."""

from __future__ import annotations

import json
from typing import Any, Dict, List

from langchain.tools import tool

from ..scenario_analysis import (
    finance_risk_flags,
    finance_snapshot,
    ops_service_summary,
    pending_invoices,
    recent_incidents,
    vendor_sla_breaches,
)

_SCENARIO: Dict[str, Any] = {}


def set_scenario_context(scenario: Dict[str, Any]) -> None:
    global _SCENARIO
    _SCENARIO = dict(scenario)


def _get_list(key: str) -> List[Dict[str, Any]]:
    value = _SCENARIO.get(key, [])
    if isinstance(value, list):
        return [entry for entry in value if isinstance(entry, dict)]
    return []


@tool
def get_finance_snapshot() -> str:
    """Return spend vs budget snapshot by department."""
    return json.dumps(finance_snapshot(_SCENARIO), indent=2)


@tool
def list_unreconciled_invoices() -> str:
    """Return unreconciled invoices for finance review."""
    return json.dumps(pending_invoices(_SCENARIO), indent=2)


@tool
def assess_budget_risk(overrun_threshold_percent: float = 3.0) -> str:
    """Assess budget risk using spend and budget totals."""
    findings = finance_risk_flags(
        _SCENARIO,
        overrun_threshold_percent=float(overrun_threshold_percent),
    )

    if not findings:
        return "No departments are over the configured risk threshold."

    return json.dumps(findings, indent=2)


@tool
def get_ops_snapshot() -> str:
    """Return service health status for ops review."""
    return json.dumps(ops_service_summary(_SCENARIO), indent=2)


@tool
def summarize_recent_incidents(hours: int = 24) -> str:
    """Summarize incidents that occurred in the last N hours."""
    incidents = recent_incidents(_SCENARIO, incident_hours=max(int(hours), 1))
    return json.dumps(incidents, indent=2)


@tool
def check_vendor_sla_breaches() -> str:
    """Return vendors that are below SLA target."""
    breaches = vendor_sla_breaches(_SCENARIO)

    if not breaches:
        return "No vendor SLA breaches detected."

    return json.dumps(breaches, indent=2)
