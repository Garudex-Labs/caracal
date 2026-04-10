"""Runtime bridge handlers for Caracal local logic tool execution."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from ..scenario_analysis import (
    business_outcomes,
    finance_risk_flags,
    finance_snapshot,
    format_mock_summary,
    ops_service_summary,
    pending_invoices,
    recent_incidents,
    vendor_sla_breaches,
)


class FinanceHandlerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scenario: dict[str, Any]
    overrun_threshold_percent: float = Field(default=3.0)
    mock: bool = True


class OpsHandlerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scenario: dict[str, Any]
    incident_hours: int = Field(default=24, ge=1)
    mock: bool = True


class OrchestratorHandlerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scenario: dict[str, Any]
    finance_report: dict[str, Any]
    ops_report: dict[str, Any]
    mock: bool = True


def finance_governed_handler(tool_args: dict[str, Any]) -> dict[str, Any]:
    """CARACAL_MARKER: AUTH_BOUNDARY.

    Local runtime logic handler for finance analysis.
    """
    request = FinanceHandlerRequest.model_validate(tool_args)
    scenario = request.scenario

    snapshot = finance_snapshot(scenario)
    pending = pending_invoices(scenario)
    risk_flags = finance_risk_flags(
        scenario,
        overrun_threshold_percent=request.overrun_threshold_percent,
    )

    return {
        "department_snapshot": snapshot,
        "pending_invoices": pending,
        "risk_flags": risk_flags,
        "mock": request.mock,
    }


def ops_governed_handler(tool_args: dict[str, Any]) -> dict[str, Any]:
    """CARACAL_MARKER: AUTH_BOUNDARY.

    Local runtime logic handler for operations analysis.
    """
    request = OpsHandlerRequest.model_validate(tool_args)
    scenario = request.scenario

    return {
        "service_summary": ops_service_summary(scenario),
        "recent_incidents": recent_incidents(scenario, incident_hours=request.incident_hours),
        "vendor_sla_breaches": vendor_sla_breaches(scenario),
        "mock": request.mock,
    }


def orchestrator_governed_handler(tool_args: dict[str, Any]) -> dict[str, Any]:
    """CARACAL_MARKER: AUTH_BOUNDARY.

    Local runtime logic handler for orchestrator synthesis.
    """
    request = OrchestratorHandlerRequest.model_validate(tool_args)
    outcomes = business_outcomes(request.scenario)
    actions = [
        str(action.get("summary"))
        for action in outcomes.get("priority_actions", [])
        if isinstance(action, dict) and action.get("summary")
    ]

    return {
        "summary": format_mock_summary(outcomes, governed=True),
        "recommended_actions": actions,
        "business_outcomes": outcomes,
        "mock": request.mock,
    }
