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


class AssembleBriefingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scenario: dict[str, Any]
    finance_data: dict[str, Any]
    finance_brief: dict[str, Any]
    ops_data: dict[str, Any]
    ops_brief: dict[str, Any]
    mode_label: str = "mock"


def _validated_payload(model: type[BaseModel], tool_args: dict[str, Any]) -> BaseModel:
    payload = dict(tool_args)
    payload.pop("principal_id", None)
    payload.pop("mandate_id", None)
    return model.model_validate(payload)


def finance_governed_handler(principal_id: str, mandate_id: str, **tool_args: Any) -> dict[str, Any]:
    """CARACAL_MARKER: AUTH_BOUNDARY.

    Local runtime logic handler for finance analysis.
    """
    request = _validated_payload(FinanceHandlerRequest, tool_args)
    scenario = request.scenario

    snapshot = finance_snapshot(scenario)
    pending = pending_invoices(scenario)
    risk_flags = finance_risk_flags(
        scenario,
        overrun_threshold_percent=request.overrun_threshold_percent,
    )

    return {
        "principal_id": principal_id,
        "mandate_id": mandate_id,
        "department_snapshot": snapshot,
        "pending_invoices": pending,
        "risk_flags": risk_flags,
        "mock": request.mock,
    }


def ops_governed_handler(principal_id: str, mandate_id: str, **tool_args: Any) -> dict[str, Any]:
    """CARACAL_MARKER: AUTH_BOUNDARY.

    Local runtime logic handler for operations analysis.
    """
    request = _validated_payload(OpsHandlerRequest, tool_args)
    scenario = request.scenario

    return {
        "principal_id": principal_id,
        "mandate_id": mandate_id,
        "service_summary": ops_service_summary(scenario),
        "recent_incidents": recent_incidents(scenario, incident_hours=request.incident_hours),
        "vendor_sla_breaches": vendor_sla_breaches(scenario),
        "mock": request.mock,
    }


def orchestrator_governed_handler(principal_id: str, mandate_id: str, **tool_args: Any) -> dict[str, Any]:
    """CARACAL_MARKER: AUTH_BOUNDARY.

    Local runtime logic handler for orchestrator synthesis.
    """
    request = _validated_payload(OrchestratorHandlerRequest, tool_args)
    outcomes = business_outcomes(request.scenario)
    actions = [
        str(action.get("summary"))
        for action in outcomes.get("priority_actions", [])
        if isinstance(action, dict) and action.get("summary")
    ]

    return {
        "principal_id": principal_id,
        "mandate_id": mandate_id,
        "summary": format_mock_summary(outcomes, governed=True),
        "recommended_actions": actions,
        "business_outcomes": outcomes,
        "mock": request.mock,
    }


def assemble_governed_briefing(principal_id: str, mandate_id: str, **tool_args: Any) -> dict[str, Any]:
    """CARACAL_MARKER: AUTH_BOUNDARY.

    Local runtime logic handler for governed orchestration assembly.
    """
    request = _validated_payload(AssembleBriefingRequest, tool_args)
    outcomes = business_outcomes(request.scenario)
    actions = [
        str(action.get("summary"))
        for action in outcomes.get("priority_actions", [])
        if isinstance(action, dict) and action.get("summary")
    ]

    finance_summary = str(request.finance_brief.get("summary_text") or "").strip()
    ops_summary = str(request.ops_brief.get("summary_text") or "").strip()
    mode_label = str(request.mode_label or "mock").strip().lower()
    governed_summary = format_mock_summary(
        outcomes,
        governed=True,
        revocation_denied=False,
    )

    return {
        "principal_id": principal_id,
        "mandate_id": mandate_id,
        "summary": governed_summary,
        "recommended_actions": actions,
        "business_outcomes": outcomes,
        "mode_label": mode_label,
        "panels": {
            "finance": {
                "summary": finance_summary,
                "snapshot": request.finance_data,
            },
            "ops": {
                "summary": ops_summary,
                "snapshot": request.ops_data,
            },
        },
    }
