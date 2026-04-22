"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Agent role definitions for all nine layers of the Lynx Capital swarm.
"""
from __future__ import annotations

from dataclasses import dataclass


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
        emits=("run_start", "run_end", "agent_spawn", "delegation", "agent_start", "agent_end", "agent_terminate"),
    ),
    "regional-orchestrator": RoleDef(
        name="regional-orchestrator",
        scope_template="region:{region}",
        allowed_tools=(),
        emits=("agent_spawn", "delegation", "agent_start", "agent_end", "agent_terminate"),
    ),
    "invoice-intake": RoleDef(
        name="invoice-intake",
        scope_template="invoice-batch:{region}",
        allowed_tools=("extract_invoice", "get_vendor_profile", "get_fx_rate"),
        emits=("agent_start", "agent_end", "agent_terminate", "tool_call", "tool_result", "service_call", "service_result"),
    ),
    "ledger-match": RoleDef(
        name="ledger-match",
        scope_template="ledger-batch:{region}",
        allowed_tools=(
            "netsuite_match_invoice", "netsuite_get_vendor_record",
            "sap_match_invoice", "sap_get_vendor_record",
            "quickbooks_match_bill", "quickbooks_get_vendor",
        ),
        emits=("agent_start", "agent_end", "agent_terminate", "tool_call", "tool_result", "service_call", "service_result"),
    ),
    "policy-check": RoleDef(
        name="policy-check",
        scope_template="policy-batch:{region}",
        allowed_tools=("check_vendor", "check_transaction", "get_withholding_rate", "validate_tax_id"),
        emits=("agent_start", "agent_end", "agent_terminate", "tool_call", "tool_result", "service_call", "service_result"),
    ),
    "route-optimization": RoleDef(
        name="route-optimization",
        scope_template="route-batch:{region}",
        allowed_tools=("get_fx_rate", "get_account_balance", "get_quote"),
        emits=("agent_start", "agent_end", "agent_terminate", "tool_call", "tool_result", "service_call", "service_result"),
    ),
    "payment-execution": RoleDef(
        name="payment-execution",
        scope_template="payment:{vendor_id}:{invoice_id}",
        allowed_tools=("submit_payment", "submit_payout", "create_outbound_payment"),
        emits=("agent_start", "agent_end", "agent_terminate", "tool_call", "tool_result", "service_call", "service_result"),
    ),
    "audit": RoleDef(
        name="audit",
        scope_template="audit:{region}",
        allowed_tools=("get_contract_terms", "get_payment_status"),
        emits=("agent_start", "agent_end", "agent_terminate", "tool_call", "tool_result", "service_call", "service_result", "audit_record"),
    ),
    "exception": RoleDef(
        name="exception",
        scope_template="exception:{vendor_id}",
        allowed_tools=("check_vendor", "get_vendor_profile"),
        emits=("agent_start", "agent_end", "agent_terminate", "tool_call", "tool_result", "service_call", "service_result"),
    ),
}


def get_role(name: str) -> RoleDef:
    if name not in ROLES:
        raise KeyError(f"Unknown role: {name!r}")
    return ROLES[name]
