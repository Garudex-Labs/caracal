"""Shared scenario analysis helpers used by baseline and governed demo tracks."""

from __future__ import annotations

from typing import Any


def _dict_list(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [entry for entry in value if isinstance(entry, dict)]


def finance_snapshot(scenario: dict[str, Any]) -> list[dict[str, Any]]:
    spend = scenario.get("department_spend", {})
    budgets = scenario.get("department_budgets", {})
    rows: list[dict[str, Any]] = []

    for department, spent in spend.items():
        budget = float(budgets.get(department, 0.0))
        delta = float(spent) - budget
        rows.append(
            {
                "department": department,
                "spent": float(spent),
                "budget": budget,
                "delta": delta,
                "status": "over" if delta > 0 else "within",
            }
        )

    return rows


def pending_invoices(scenario: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        invoice
        for invoice in _dict_list(scenario.get("invoices"))
        if invoice.get("status") != "reconciled"
    ]


def finance_risk_flags(
    scenario: dict[str, Any],
    *,
    overrun_threshold_percent: float,
) -> list[dict[str, Any]]:
    spend = scenario.get("department_spend", {})
    budgets = scenario.get("department_budgets", {})
    findings: list[dict[str, Any]] = []

    for department, spent in spend.items():
        budget = float(budgets.get(department, 0.0))
        if budget <= 0:
            continue
        overrun_percent = ((float(spent) - budget) / budget) * 100.0
        if overrun_percent <= overrun_threshold_percent:
            continue

        findings.append(
            {
                "department": department,
                "overrun_percent": round(overrun_percent, 2),
                "risk": "high" if overrun_percent > overrun_threshold_percent * 2 else "medium",
            }
        )

    return findings


def ops_service_summary(scenario: dict[str, Any]) -> list[dict[str, Any]]:
    return _dict_list(scenario.get("services"))


def recent_incidents(scenario: dict[str, Any], *, incident_hours: int) -> list[dict[str, Any]]:
    incidents: list[dict[str, Any]] = []
    for incident in _dict_list(scenario.get("incidents")):
        hours_ago = int(incident.get("hours_ago", 10**9))
        if hours_ago <= incident_hours:
            incidents.append(incident)
    return incidents


def vendor_sla_breaches(scenario: dict[str, Any]) -> list[dict[str, Any]]:
    breaches: list[dict[str, Any]] = []
    for vendor in _dict_list(scenario.get("vendors")):
        target = float(vendor.get("sla_target", 0.0))
        actual = float(vendor.get("sla_actual", 0.0))
        if actual < target:
            breaches.append(
                {
                    "vendor": vendor.get("name", "unknown"),
                    "sla_target": target,
                    "sla_actual": actual,
                }
            )
    return breaches


def business_outcomes(
    scenario: dict[str, Any],
    *,
    overrun_threshold_percent: float = 3.0,
    incident_hours: int = 24,
) -> dict[str, Any]:
    budget_risks = finance_risk_flags(
        scenario,
        overrun_threshold_percent=overrun_threshold_percent,
    )
    pending = pending_invoices(scenario)
    services = ops_service_summary(scenario)
    incidents = recent_incidents(scenario, incident_hours=incident_hours)
    breaches = vendor_sla_breaches(scenario)

    actions: list[dict[str, str]] = []
    if budget_risks:
        actions.append(
            {
                "action_id": "mitigate_budget_overrun",
                "owner": "finance",
                "summary": "Apply spend controls to over-budget departments.",
            }
        )
    if pending:
        actions.append(
            {
                "action_id": "reconcile_pending_invoices",
                "owner": "finance",
                "summary": "Reconcile pending invoices and approvals.",
            }
        )
    if breaches:
        actions.append(
            {
                "action_id": "remediate_vendor_sla_breach",
                "owner": "ops",
                "summary": "Open a corrective action with vendors below SLA.",
            }
        )
    degraded_services = [
        service.get("name", "unknown")
        for service in services
        if service.get("status") == "degraded"
    ]
    if degraded_services or incidents:
        actions.append(
            {
                "action_id": "stabilize_degraded_services",
                "owner": "ops",
                "summary": "Stabilize degraded services and monitor current incidents.",
            }
        )
    if not actions:
        actions.append(
            {
                "action_id": "maintain_monitoring",
                "owner": "orchestrator",
                "summary": "Maintain the current plan and continue monitoring.",
            }
        )

    return {
        "company": scenario.get("company"),
        "currency": scenario.get("currency"),
        "over_budget_departments": budget_risks,
        "pending_invoice_ids": [str(invoice.get("id")) for invoice in pending if invoice.get("id")],
        "degraded_services": degraded_services,
        "recent_incident_ids": [str(incident.get("id")) for incident in incidents if incident.get("id")],
        "vendor_sla_breaches": [str(breach.get("vendor")) for breach in breaches if breach.get("vendor")],
        "priority_actions": actions,
    }


def format_mock_summary(
    outcomes: dict[str, Any],
    *,
    governed: bool = False,
    revocation_denied: bool = False,
) -> str:
    prefix = "Governed orchestrator summary" if governed else "Mock orchestrator summary"
    fragments: list[str] = []

    departments = [item["department"] for item in outcomes.get("over_budget_departments", []) if item.get("department")]
    if departments:
        fragments.append(
            "prioritize "
            + ", ".join(departments)
            + " budget overrun mitigation"
        )

    pending_invoice_ids = outcomes.get("pending_invoice_ids", [])
    if pending_invoice_ids:
        fragments.append("clear pending invoices (" + ", ".join(pending_invoice_ids) + ")")

    vendor_names = outcomes.get("vendor_sla_breaches", [])
    if vendor_names:
        fragments.append(
            "open a corrective action for " + ", ".join(vendor_names) + " SLA underperformance"
        )

    degraded_services = outcomes.get("degraded_services", [])
    if degraded_services:
        fragments.append(
            "monitor and stabilize " + ", ".join(degraded_services) + " service degradation"
        )

    if not fragments:
        fragments.append("maintain the current operating plan")

    summary = prefix + ": " + ", and ".join(fragments) + "."
    if governed and revocation_denied:
        summary += " Revocation check: subsequent finance call denied as expected."
    return summary
