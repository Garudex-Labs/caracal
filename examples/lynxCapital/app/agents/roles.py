"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Agent role registry for the Lynx Capital swarm, one entry per Caracal-governed role.
"""
from __future__ import annotations

from dataclasses import dataclass

ORCHESTRATOR_EMITS = (
    "agent_spawn", "delegation", "agent_start", "agent_end", "agent_terminate",
)
WORKER_EMITS = (
    "agent_start", "agent_end", "agent_terminate",
    "tool_call", "tool_result", "service_call", "service_result",
)


@dataclass(frozen=True)
class RoleDef:
    name: str
    scope_template: str
    allowed_tools: tuple[str, ...]
    emits: tuple[str, ...]


ROLES: dict[str, RoleDef] = {
    "finance-control": RoleDef(
        name="finance-control",
        scope_template="global",
        allowed_tools=(),
        emits=("run_start", "run_end", *ORCHESTRATOR_EMITS),
    ),
    "regional-orchestrator": RoleDef(
        name="regional-orchestrator",
        scope_template="region:{region}",
        allowed_tools=(),
        emits=ORCHESTRATOR_EMITS,
    ),
    "workflow-orchestrator": RoleDef(
        name="workflow-orchestrator",
        scope_template="workflow:{workflow_id}",
        allowed_tools=(),
        emits=ORCHESTRATOR_EMITS,
    ),
    "invoice-intake": RoleDef(
        name="invoice-intake",
        scope_template="extract:{invoice_id}",
        allowed_tools=("extract_invoice",),
        emits=WORKER_EMITS,
    ),
    "ledger-match": RoleDef(
        name="ledger-match",
        scope_template="match:{invoice_id}",
        allowed_tools=("match_invoice",),
        emits=WORKER_EMITS,
    ),
    "policy-check": RoleDef(
        name="policy-check",
        scope_template="compliance:{vendor_id}",
        allowed_tools=("check_vendor",),
        emits=WORKER_EMITS,
    ),
    "route-optimization": RoleDef(
        name="route-optimization",
        scope_template="route:{subject}",
        allowed_tools=("get_fx_rate", "get_withholding_rate", "get_market_snapshot", "get_reference_rate"),
        emits=WORKER_EMITS,
    ),
    "payment-execution": RoleDef(
        name="payment-execution",
        scope_template="payment:{reference}",
        allowed_tools=("submit_payment",),
        emits=WORKER_EMITS,
    ),
    "audit": RoleDef(
        name="audit",
        scope_template="audit:{subject}",
        allowed_tools=(),
        emits=(*WORKER_EMITS, "audit_record"),
    ),
    "exception": RoleDef(
        name="exception",
        scope_template="exception:{vendor_id}",
        allowed_tools=("check_vendor",),
        emits=WORKER_EMITS,
    ),
    "partner-integration": RoleDef(
        name="partner-integration",
        scope_template="partner:{provider_id}:{operation}",
        allowed_tools=("partner_operation",),
        emits=WORKER_EMITS,
    ),
    "vendor-lifecycle": RoleDef(
        name="vendor-lifecycle",
        scope_template="vendor:{subject}",
        allowed_tools=(
            "kyb_screen_vendor", "register_vendor", "refresh_vendor_compliance",
            "get_contract_terms", "get_vendor_onboarding_status", "advance_vendor_onboarding",
            "verify_vendor_banking",
            "get_budget", "create_requisition", "approve_requisition", "reject_requisition",
            "get_approval_chain", "create_purchase_order", "receive_purchase_order",
            "procurement_list_suppliers",
            "get_supplier_contact", "get_supplier_account", "list_supplier_contacts",
            "list_supplier_deals", "advance_supplier_deal", "log_supplier_activity",
            "add_supplier_note",
        ),
        emits=WORKER_EMITS,
    ),
    "treasury": RoleDef(
        name="treasury",
        scope_template="treasury:{subject}",
        allowed_tools=(
            "get_cash_position", "get_treasury_summary", "forecast_liquidity",
            "get_fx_exposure", "place_fx_hedge", "transfer_funds",
        ),
        emits=WORKER_EMITS,
    ),
    "close": RoleDef(
        name="close",
        scope_template="close:{subject}",
        allowed_tools=(
            "post_journal_entry", "list_ledger_accounts", "reconcile_account",
            "compute_accrual", "get_trial_balance", "close_period",
        ),
        emits=WORKER_EMITS,
    ),
    "compliance": RoleDef(
        name="compliance",
        scope_template="compliance:{subject}",
        allowed_tools=(
            "aml_monitor_transaction", "sanctions_screen_batch", "prepare_regulatory_filing",
            "submit_regulatory_filing", "attest_control", "resolve_approver_chain",
            "list_approver_groups", "check_user_access",
        ),
        emits=WORKER_EMITS,
    ),
    "receivables": RoleDef(
        name="receivables",
        scope_template="ar:{subject}",
        allowed_tools=(
            "issue_customer_invoice", "send_dunning_notice", "run_dunning_cycle",
            "apply_customer_payment", "record_customer_payment", "get_ar_aging",
            "get_ar_summary", "get_customer_account", "list_customer_invoices",
            "write_off_invoice", "open_collection_case", "track_message_delivery",
        ),
        emits=WORKER_EMITS,
    ),
    "payments": RoleDef(
        name="payments",
        scope_template="notify:{reference}",
        allowed_tools=("send_remittance_advice", "send_payment_confirmation"),
        emits=WORKER_EMITS,
    ),
}


def get_role(name: str) -> RoleDef:
    if name not in ROLES:
        raise KeyError(f"Unknown role: {name!r}")
    return ROLES[name]
