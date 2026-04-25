"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tool wrappers for every agent-callable service action; each emits full event pairs.
"""
from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from app.events import types as ev
from app.events.bus import bus
from app.services.registry import call as _svc

if TYPE_CHECKING:
    from caracal_sdk.context import ScopeContext

# caracal-integration: module-level enforcement scope; set at app startup
_enforcement_scope: "ScopeContext | None" = None
_event_loop: asyncio.AbstractEventLoop | None = None


def init_enforcement(scope: "ScopeContext", loop: asyncio.AbstractEventLoop) -> None:
    global _enforcement_scope, _event_loop
    _enforcement_scope = scope
    _event_loop = loop


# Maps (service_id, action) → MCP resource label for tool_id construction.
_RESOURCE: dict[tuple[str, str], str] = {
    ("mercury-bank",     "get_account_balance"): "account",
    ("mercury-bank",     "submit_payment"):       "payment",
    ("wise-payouts",     "get_quote"):            "quote",
    ("wise-payouts",     "submit_payout"):        "payout",
    ("stripe-treasury",  "get_financial_account"):"account",
    ("stripe-treasury",  "create_outbound_payment"):"payment",
    ("netsuite",         "get_vendor_record"):    "vendor",
    ("netsuite",         "match_invoice"):        "invoice",
    ("netsuite",         "get_payment_status"):   "payment",
    ("sap-erp",          "get_vendor_record"):    "vendor",
    ("sap-erp",          "match_invoice"):        "invoice",
    ("quickbooks",       "get_vendor"):           "vendor",
    ("quickbooks",       "match_bill"):           "bill",
    ("compliance-nexus", "check_vendor"):         "vendor",
    ("compliance-nexus", "check_transaction"):    "transaction",
    ("ocr-vision",       "extract_invoice"):      "document",
    ("vendor-portal",    "get_vendor_profile"):   "profile",
    ("tax-rules",        "get_withholding_rate"): "rate",
    ("tax-rules",        "validate_tax_id"):      "taxid",
    ("fx-rates",         "get_rate"):             "rate",
}


def _tool_id(service_id: str, action: str) -> str:
    resource = _RESOURCE.get((service_id, action), action.split("_")[0])
    return f"provider:{service_id}:resource:{resource}:action:{action}"


def _enforce(run_id: str, agent_id: str, service_id: str, action: str, args: dict) -> None:
    # caracal-integration: route every external tool call through Caracal policy enforcement
    if _enforcement_scope is None or _event_loop is None:
        return
    tid = _tool_id(service_id, action)
    try:
        future = asyncio.run_coroutine_threadsafe(
            _enforcement_scope.tools.call(
                tool_id=tid,
                tool_args=args,
                metadata={"correlation_id": run_id},
            ),
            _event_loop,
        )
        result = future.result(timeout=8)
        if isinstance(result, dict):
            if result.get("success") is False:
                reason = result.get("error") or "Caracal denied"
                bus.publish(ev.caracal_enforce(run_id, agent_id, tid, "deny", reason))
                raise PermissionError(f"Caracal denied {tid}: {reason}")
            if "detail" in result and "success" not in result:
                reason = result.get("detail") or "Caracal denied"
                bus.publish(ev.caracal_enforce(run_id, agent_id, tid, "deny", reason))
                raise PermissionError(f"Caracal denied {tid}: {reason}")
        bus.publish(ev.caracal_enforce(run_id, agent_id, tid, "allow"))
    except PermissionError:
        raise
    except Exception as exc:
        reason = str(exc)
        bus.publish(ev.caracal_enforce(run_id, agent_id, tid, "deny", reason))
        raise PermissionError(f"Caracal denied {tid}: {reason}") from exc


def _invoke(
    run_id: str,
    agent_id: str,
    tool_name: str,
    service_id: str,
    action: str,
    args: dict[str, Any],
) -> dict[str, Any]:
    bus.publish(ev.tool_call(run_id, agent_id, tool_name, args))
    _enforce(run_id, agent_id, service_id, action, args)
    bus.publish(ev.service_call(run_id, agent_id, service_id, action, args))
    result = _svc(service_id, action, args)
    bus.publish(ev.service_result(run_id, agent_id, service_id, action, result))
    bus.publish(ev.tool_result(run_id, agent_id, tool_name, result))
    return result


# -- invoice-intake tools --

def extract_invoice(run_id: str, agent_id: str, invoice_id: str, document_ref: str) -> dict:
    return _invoke(run_id, agent_id, "extract_invoice", "ocr-vision", "extract_invoice",
                   {"invoice_id": invoice_id, "document_ref": document_ref})


def get_vendor_profile(run_id: str, agent_id: str, vendor_id: str) -> dict:
    return _invoke(run_id, agent_id, "get_vendor_profile", "vendor-portal", "get_vendor_profile",
                   {"vendor_id": vendor_id})


def get_fx_rate(run_id: str, agent_id: str, from_currency: str, to_currency: str) -> dict:
    return _invoke(run_id, agent_id, "get_fx_rate", "fx-rates", "get_rate",
                   {"from_currency": from_currency, "to_currency": to_currency})


# -- ledger-match tools --

def netsuite_match_invoice(run_id: str, agent_id: str, vendor_id: str, invoice_id: str, amount: float, currency: str) -> dict:
    return _invoke(run_id, agent_id, "netsuite_match_invoice", "netsuite", "match_invoice",
                   {"vendor_id": vendor_id, "invoice_id": invoice_id, "amount": amount, "currency": currency})


def netsuite_get_vendor_record(run_id: str, agent_id: str, vendor_id: str) -> dict:
    return _invoke(run_id, agent_id, "netsuite_get_vendor_record", "netsuite", "get_vendor_record",
                   {"vendor_id": vendor_id})


def sap_match_invoice(run_id: str, agent_id: str, vendor_id: str, invoice_id: str, amount: float, currency: str) -> dict:
    return _invoke(run_id, agent_id, "sap_match_invoice", "sap-erp", "match_invoice",
                   {"vendor_id": vendor_id, "invoice_id": invoice_id, "amount": amount, "currency": currency})


def sap_get_vendor_record(run_id: str, agent_id: str, vendor_id: str) -> dict:
    return _invoke(run_id, agent_id, "sap_get_vendor_record", "sap-erp", "get_vendor_record",
                   {"vendor_id": vendor_id})


def quickbooks_match_bill(run_id: str, agent_id: str, vendor_id: str, invoice_id: str, amount: float, currency: str) -> dict:
    return _invoke(run_id, agent_id, "quickbooks_match_bill", "quickbooks", "match_bill",
                   {"vendor_id": vendor_id, "invoice_id": invoice_id, "amount": amount, "currency": currency})


def quickbooks_get_vendor(run_id: str, agent_id: str, vendor_id: str) -> dict:
    return _invoke(run_id, agent_id, "quickbooks_get_vendor", "quickbooks", "get_vendor",
                   {"vendor_id": vendor_id})


# -- policy-check tools --

def check_vendor(run_id: str, agent_id: str, vendor_id: str) -> dict:
    return _invoke(run_id, agent_id, "check_vendor", "compliance-nexus", "check_vendor",
                   {"vendor_id": vendor_id})


def check_transaction(run_id: str, agent_id: str, vendor_id: str, amount: float, currency: str, rail: str) -> dict:
    return _invoke(run_id, agent_id, "check_transaction", "compliance-nexus", "check_transaction",
                   {"vendor_id": vendor_id, "amount": amount, "currency": currency, "rail": rail})


def get_withholding_rate(run_id: str, agent_id: str, region: str, currency: str) -> dict:
    return _invoke(run_id, agent_id, "get_withholding_rate", "tax-rules", "get_withholding_rate",
                   {"region": region, "currency": currency})


def validate_tax_id(run_id: str, agent_id: str, vendor_id: str) -> dict:
    return _invoke(run_id, agent_id, "validate_tax_id", "tax-rules", "validate_tax_id",
                   {"vendor_id": vendor_id})


# -- route-optimization tools --

def get_account_balance(run_id: str, agent_id: str, vendor_id: str) -> dict:
    return _invoke(run_id, agent_id, "get_account_balance", "mercury-bank", "get_account_balance",
                   {"vendor_id": vendor_id})


def get_quote(run_id: str, agent_id: str, from_currency: str, to_currency: str, amount: float) -> dict:
    return _invoke(run_id, agent_id, "get_quote", "wise-payouts", "get_quote",
                   {"from_currency": from_currency, "to_currency": to_currency, "amount": amount})


# -- payment-execution tools --

def submit_payment(run_id: str, agent_id: str, vendor_id: str, amount: float, currency: str, rail: str, reference: str) -> dict:
    return _invoke(run_id, agent_id, "submit_payment", "mercury-bank", "submit_payment",
                   {"vendor_id": vendor_id, "amount": amount, "currency": currency, "rail": rail, "reference": reference})


def submit_payout(run_id: str, agent_id: str, vendor_id: str, amount: float, currency: str, rail: str, reference: str) -> dict:
    return _invoke(run_id, agent_id, "submit_payout", "wise-payouts", "submit_payout",
                   {"vendor_id": vendor_id, "amount": amount, "currency": currency, "rail": rail, "reference": reference})


def create_outbound_payment(run_id: str, agent_id: str, vendor_id: str, amount: float, currency: str, rail: str, reference: str) -> dict:
    return _invoke(run_id, agent_id, "create_outbound_payment", "stripe-treasury", "create_outbound_payment",
                   {"vendor_id": vendor_id, "amount": amount, "currency": currency, "rail": rail, "reference": reference})


# -- audit tools --

def get_contract_terms(run_id: str, agent_id: str, vendor_id: str) -> dict:
    return _invoke(run_id, agent_id, "get_contract_terms", "vendor-portal", "get_contract_terms",
                   {"vendor_id": vendor_id})


def get_payment_status(run_id: str, agent_id: str, vendor_id: str) -> dict:
    return _invoke(run_id, agent_id, "get_payment_status", "netsuite", "get_payment_status",
                   {"vendor_id": vendor_id})


# Registry mapping tool name -> function for dispatch by the orchestration layer.
TOOLS: dict[str, Callable] = {
    "extract_invoice": extract_invoice,
    "get_vendor_profile": get_vendor_profile,
    "get_fx_rate": get_fx_rate,
    "netsuite_match_invoice": netsuite_match_invoice,
    "netsuite_get_vendor_record": netsuite_get_vendor_record,
    "sap_match_invoice": sap_match_invoice,
    "sap_get_vendor_record": sap_get_vendor_record,
    "quickbooks_match_bill": quickbooks_match_bill,
    "quickbooks_get_vendor": quickbooks_get_vendor,
    "check_vendor": check_vendor,
    "check_transaction": check_transaction,
    "get_withholding_rate": get_withholding_rate,
    "validate_tax_id": validate_tax_id,
    "get_account_balance": get_account_balance,
    "get_quote": get_quote,
    "submit_payment": submit_payment,
    "submit_payout": submit_payout,
    "create_outbound_payment": create_outbound_payment,
    "get_contract_terms": get_contract_terms,
    "get_payment_status": get_payment_status,
}
