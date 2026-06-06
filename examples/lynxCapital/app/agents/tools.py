"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Agent-callable tool wrappers that map each business action onto a real external provider over the partner integration layer.
"""
from __future__ import annotations

from typing import Callable

from app.events import types as ev
from app.events.bus import bus
from app.services.partners import PartnerPendingCaracal
from app.services.partners import call as _partner

_REGION_CCY = {"US": "USD", "IN": "USD", "DE": "EUR", "SG": "SGD", "BR": "BRL", "GLOBAL": "USD"}
_REGION_TAX = {"US": "US", "IN": "IN", "DE": "DE", "SG": "SG", "BR": "BR", "GLOBAL": "US"}


def _ccy(region: str) -> str:
    return _REGION_CCY.get(region, "USD")


def _run(run_id: str, agent_id: str, tool_name: str, provider_id: str,
         operation: str, payload: dict) -> dict[str, object]:
    """Emit the tool/service event pairs and execute one provider operation."""
    bus.publish(ev.tool_call(run_id, agent_id, tool_name, payload))
    bus.publish(ev.service_call(run_id, agent_id, provider_id, operation, payload))
    try:
        result = _partner(provider_id, operation, payload)
    except PartnerPendingCaracal:
        result = {"provider": provider_id, "operation": operation,
                  "status": "pending_caracal_integration",
                  "message": "provider activates in the Caracal SDK integration phase"}
    bus.publish(ev.service_result(run_id, agent_id, provider_id, operation, result))
    bus.publish(ev.tool_result(run_id, agent_id, tool_name, result))
    return result


# -- invoice-intake tools --

def extract_invoice(run_id: str, agent_id: str, invoice_id: str, document_ref: str) -> dict[str, object]:
    submitted = _run(run_id, agent_id, "extract_invoice", "inkwell-ocr", "submit_document",
                     {"fileName": document_ref, "reference": invoice_id, "model": "invoice"})
    document_id = (submitted.get("data") or {}).get("documentId")
    if not document_id:
        return submitted
    return _run(run_id, agent_id, "extract_invoice", "inkwell-ocr", "get_extraction",
                {"documentId": document_id})


def get_vendor_profile(run_id: str, agent_id: str, vendor_id: str) -> dict[str, object]:
    return _run(run_id, agent_id, "get_vendor_profile", "atlas-vendor", "get_vendor_profile",
                {"vendorId": vendor_id})


def get_fx_rate(run_id: str, agent_id: str, from_currency: str, to_currency: str) -> dict[str, object]:
    return _run(run_id, agent_id, "get_fx_rate", "cordoba-fx", "get_quote",
                {"sell_currency": from_currency, "buy_currency": to_currency,
                 "amount": 1, "fixed_side": "sell"})


# -- ledger-match tools (three accounting back ends) --

def _pick_erp(vendor_id: str) -> str:
    """Deterministically assign a vendor to an accounting back end: SMB vendors
    keep their books in QuickBooks (tallyhall), the rest on NetSuite (ironbark)."""
    return "tallyhall" if sum(ord(c) for c in vendor_id) % 3 == 0 else "ironbark"


def match_invoice(run_id: str, agent_id: str, vendor_id: str, invoice_id: str,
                  amount: float, currency: str, erp: str = "auto") -> dict[str, object]:
    """Match an invoice against the vendor's own ledger, selecting the ERP that
    holds that vendor's books."""
    choice = erp.lower() if erp and erp != "auto" else _pick_erp(vendor_id)
    if choice in ("tallyhall", "quickbooks", "qb"):
        return quickbooks_match_bill(run_id, agent_id, vendor_id, invoice_id, amount, currency)
    return netsuite_match_invoice(run_id, agent_id, vendor_id, invoice_id, amount, currency)


def netsuite_match_invoice(run_id: str, agent_id: str, vendor_id: str, invoice_id: str, amount: float, currency: str) -> dict[str, object]:
    return _run(run_id, agent_id, "netsuite_match_invoice", "ironbark-erp", "match_invoice",
                {"invoiceId": invoice_id, "vendorId": vendor_id, "amount": amount, "currency": currency})


def netsuite_get_vendor_record(run_id: str, agent_id: str, vendor_id: str) -> dict[str, object]:
    return _run(run_id, agent_id, "netsuite_get_vendor_record", "ironbark-erp", "get_vendor",
                {"vendorId": vendor_id})


def sap_match_invoice(run_id: str, agent_id: str, vendor_id: str, invoice_id: str, amount: float, currency: str) -> dict[str, object]:
    return _run(run_id, agent_id, "sap_match_invoice", "ironbark-erp", "match_invoice",
                {"invoiceId": invoice_id, "vendorId": vendor_id, "amount": amount, "currency": currency})


def sap_get_vendor_record(run_id: str, agent_id: str, vendor_id: str) -> dict[str, object]:
    return _run(run_id, agent_id, "sap_get_vendor_record", "ironbark-erp", "get_vendor",
                {"vendorId": vendor_id})


# -- enterprise ERP back-office tools (ironbark-erp) --

def netsuite_create_purchase_order(run_id: str, agent_id: str, vendor_id: str, item: str,
                                   quantity: int, rate: float, department: str = "Operations") -> dict[str, object]:
    return _run(run_id, agent_id, "netsuite_create_purchase_order", "ironbark-erp", "create_purchase_order",
                {"vendorId": vendor_id, "department": department,
                 "lines": [{"item": item, "quantity": quantity, "rate": rate, "account": "6300"}]})


def netsuite_record_vendor_bill(run_id: str, agent_id: str, vendor_id: str, amount: float,
                                currency: str, reference: str,
                                purchase_order_id: str | None = None) -> dict[str, object]:
    payload = {"vendorId": vendor_id, "amount": amount, "currency": currency,
               "referenceNumber": reference}
    if purchase_order_id:
        payload["purchaseOrderId"] = purchase_order_id
    return _run(run_id, agent_id, "netsuite_record_vendor_bill", "ironbark-erp", "create_bill", payload)


def netsuite_list_open_bills(run_id: str, agent_id: str, vendor_id: str | None = None) -> dict[str, object]:
    payload: dict[str, object] = {"status": "open"}
    if vendor_id:
        payload["vendorId"] = vendor_id
    return _run(run_id, agent_id, "netsuite_list_open_bills", "ironbark-erp", "list_bills", payload)


def netsuite_post_journal_entry(run_id: str, agent_id: str, debit_account: str, credit_account: str,
                                amount: float, currency: str, period: str) -> dict[str, object]:
    return _run(run_id, agent_id, "netsuite_post_journal_entry", "ironbark-erp", "post_journal_entry",
                {"postingPeriod": period, "currency": currency,
                 "lines": [{"account": debit_account, "debit": amount},
                           {"account": credit_account, "credit": amount}]})


def netsuite_get_ap_account(run_id: str, agent_id: str) -> dict[str, object]:
    return _run(run_id, agent_id, "netsuite_get_ap_account", "ironbark-erp", "get_account",
                {"accountId": "2000"})


def quickbooks_match_bill(run_id: str, agent_id: str, vendor_id: str, invoice_id: str, amount: float, currency: str) -> dict[str, object]:
    """Record a vendor bill in QuickBooks then match it to its purchase reference."""
    created = _run(run_id, agent_id, "quickbooks_match_bill", "tallyhall-books", "create_bill",
                   {"vendorId": vendor_id, "amount": amount, "currency": currency})
    bill = created.get("data") if isinstance(created, dict) else None
    bill_id = bill.get("Id") if isinstance(bill, dict) else None
    if not bill_id:
        return created
    return _run(run_id, agent_id, "quickbooks_match_bill", "tallyhall-books", "match_bill",
                {"billId": bill_id, "poRef": invoice_id})


def quickbooks_get_vendor(run_id: str, agent_id: str, vendor_id: str) -> dict[str, object]:
    return _run(run_id, agent_id, "quickbooks_get_vendor", "tallyhall-books", "get_vendor",
                {"vendorId": vendor_id})


def quickbooks_pay_bill(run_id: str, agent_id: str, bill_id: str,
                        amount: float | None = None, pay_type: str = "Check") -> dict[str, object]:
    """Settle an open vendor bill in QuickBooks via a BillPayment."""
    payload: dict[str, object] = {"billId": bill_id, "payType": pay_type}
    if amount is not None:
        payload["amount"] = amount
    return _run(run_id, agent_id, "quickbooks_pay_bill", "tallyhall-books", "pay_bill", payload)


def quickbooks_record_expense(run_id: str, agent_id: str, vendor_id: str, amount: float,
                              currency: str, account: str = "6200",
                              payment_type: str = "CreditCard") -> dict[str, object]:
    """Book a cash or card expense against an expense account in QuickBooks."""
    return _run(run_id, agent_id, "quickbooks_record_expense", "tallyhall-books", "create_expense",
                {"vendorId": vendor_id, "amount": amount, "currency": currency,
                 "account": account, "paymentType": payment_type})


def quickbooks_issue_invoice(run_id: str, agent_id: str, customer_id: str, amount: float,
                             currency: str) -> dict[str, object]:
    """Raise a customer invoice in QuickBooks and email it to the customer."""
    created = _run(run_id, agent_id, "quickbooks_issue_invoice", "tallyhall-books", "create_invoice",
                   {"customerId": customer_id, "amount": amount, "currency": currency})
    invoice = created.get("data") if isinstance(created, dict) else None
    invoice_id = invoice.get("Id") if isinstance(invoice, dict) else None
    if not invoice_id:
        return created
    return _run(run_id, agent_id, "quickbooks_issue_invoice", "tallyhall-books", "send_invoice",
                {"invoiceId": invoice_id})


def quickbooks_apply_payment(run_id: str, agent_id: str, invoice_id: str,
                             amount: float | None = None) -> dict[str, object]:
    """Receive a customer payment and apply it to an open QuickBooks invoice."""
    payload: dict[str, object] = {"invoiceId": invoice_id}
    if amount is not None:
        payload["amount"] = amount
    return _run(run_id, agent_id, "quickbooks_apply_payment", "tallyhall-books", "record_payment", payload)


def quickbooks_run_report(run_id: str, agent_id: str, report_type: str = "ProfitAndLoss") -> dict[str, object]:
    """Pull a financial report (P&L, BalanceSheet, AgedPayables, AgedReceivables,
    TrialBalance) from the QuickBooks company file."""
    return _run(run_id, agent_id, "quickbooks_run_report", "tallyhall-books", "get_report",
                {"reportType": report_type})


# -- policy-check tools --

def check_vendor(run_id: str, agent_id: str, vendor_id: str) -> dict[str, object]:
    return _run(run_id, agent_id, "check_vendor", "aegis-screening", "screen_party",
                {"name": vendor_id})


def check_transaction(run_id: str, agent_id: str, vendor_id: str, amount: float, currency: str, rail: str) -> dict[str, object]:
    return _run(run_id, agent_id, "check_transaction", "verafin-monitor", "monitor_transaction",
                {"transactionId": f"{vendor_id}:{rail}", "amount": amount, "currency": currency})


def get_withholding_rate(run_id: str, agent_id: str, region: str, currency: str) -> dict[str, object]:
    country = _REGION_TAX.get(region, "US")
    documentation = "W-9" if country == "US" else "W-8BEN"
    payee = {"country": country, "documentationType": documentation,
             "treatyClaim": country != "US"}
    return _run(run_id, agent_id, "get_withholding_rate", "sabre-tax", "determine_withholding",
                {"paymentType": "services", "currencyCode": currency, "payee": payee})


def validate_tax_id(run_id: str, agent_id: str, vendor_id: str) -> dict[str, object]:
    return _run(run_id, agent_id, "validate_tax_id", "sabre-tax", "validate_tax_id",
                {"taxId": vendor_id, "country": "US"})


# -- route-optimization tools --

def get_account_balance(run_id: str, agent_id: str, vendor_id: str) -> dict[str, object]:
    """Read available cash from the bank of record (Halcyon Bank), summarizing
    enabled operating accounts so routing can size payments against real balances."""
    accounts = _run(run_id, agent_id, "get_account_balance", "halcyon-bank", "list_accounts",
                    {"status": "Enabled"})
    data = accounts.get("data") if isinstance(accounts, dict) else None
    items = data.get("items") if isinstance(data, dict) else None
    if isinstance(items, list):
        balances = [
            {"accountId": a["accountId"], "currency": a["currency"],
             "available": a["balances"]["available"]}
            for a in items if isinstance(a, dict) and "balances" in a
        ]
        accounts["data"] = {"accounts": balances,
                            "totalAvailable": round(sum(b["available"] for b in balances), 2)}
    return accounts


def get_quote(run_id: str, agent_id: str, from_currency: str, to_currency: str, amount: float) -> dict[str, object]:
    return _run(run_id, agent_id, "get_quote", "cordoba-fx", "get_quote",
                {"sell_currency": from_currency, "buy_currency": to_currency,
                 "amount": amount, "fixed_side": "sell"})


def convert_currency(run_id: str, agent_id: str, from_currency: str, to_currency: str, amount: float) -> dict[str, object]:
    """Lock a rate and book an FX conversion, buying `to_currency` with `from_currency`."""
    return _run(run_id, agent_id, "convert_currency", "cordoba-fx", "create_conversion",
                {"sell_currency": from_currency, "buy_currency": to_currency,
                 "amount": amount, "fixed_side": "sell", "term_agreement": True})


def settle_vendor_fx_payment(run_id: str, agent_id: str, vendor_id: str, amount: float,
                             buy_currency: str, sell_currency: str = "USD",
                             bank_country: str = "", account_number: str = "",
                             iban: str = "", bic_swift: str = "",
                             reference: str = "") -> dict[str, object]:
    """Settle a multi-currency vendor invoice end to end: book the conversion that
    sources the vendor's currency, register the vendor's bank beneficiary, then
    release the cross-border payment drawn on that conversion."""
    conversion = _run(run_id, agent_id, "settle_vendor_fx_payment", "cordoba-fx", "create_conversion",
                      {"sell_currency": sell_currency, "buy_currency": buy_currency,
                       "amount": amount, "fixed_side": "buy", "term_agreement": True})
    conv_data = conversion.get("data") if isinstance(conversion, dict) else None
    conversion_id = conv_data.get("id") if isinstance(conv_data, dict) else None
    if not conversion_id:
        return conversion

    beneficiary = _run(run_id, agent_id, "settle_vendor_fx_payment", "cordoba-fx", "create_beneficiary",
                       {"bank_account_holder_name": vendor_id, "bank_country": bank_country or buy_currency[:2],
                        "currency": buy_currency, "account_number": account_number,
                        "iban": iban, "bic_swift": bic_swift,
                        "beneficiary_entity_type": "company"})
    ben_data = beneficiary.get("data") if isinstance(beneficiary, dict) else None
    beneficiary_id = ben_data.get("id") if isinstance(ben_data, dict) else None
    if not beneficiary_id:
        return beneficiary

    return _run(run_id, agent_id, "settle_vendor_fx_payment", "cordoba-fx", "create_payment",
                {"currency": buy_currency, "amount": amount, "beneficiary_id": beneficiary_id,
                 "conversion_id": conversion_id, "reference": reference or vendor_id,
                 "reason": "vendor invoice settlement"})


def get_fx_settlement_status(run_id: str, agent_id: str, payment_id: str) -> dict[str, object]:
    """Track a cross-border vendor payment through to its completed state."""
    return _run(run_id, agent_id, "get_fx_settlement_status", "cordoba-fx", "get_payment",
                {"payment_id": payment_id})


# -- payment-execution tools (distinct rails routed to distinct providers) --

_RAIL_PROVIDER = {
    "WIRE": "quetzal", "SWIFT": "quetzal",
    "ACH": "halcyon", "SEPA": "halcyon", "PAYNOW": "halcyon",
    "PIX": "halcyon", "NEFT": "halcyon", "RTGS": "halcyon",
}


def submit_payment(run_id: str, agent_id: str, vendor_id: str, amount: float, currency: str, rail: str, reference: str) -> dict[str, object]:
    """Route a vendor payment to the provider that serves the requested rail:
    open-banking rails to halcyon-bank, cross-border rails to quetzal-payouts,
    card/default to meridian-pay."""
    target = _RAIL_PROVIDER.get((rail or "").upper(), "meridian")
    if target == "halcyon":
        return create_outbound_payment(run_id, agent_id, vendor_id, amount, currency, rail, reference)
    if target == "quetzal":
        return submit_payout(run_id, agent_id, vendor_id, amount, currency, rail, reference)
    return _run(run_id, agent_id, "submit_payment", "meridian-pay", "create_payout",
                {"amount": amount, "currency": currency, "destination": vendor_id,
                 "statementDescriptor": "MERIDIAN PAYOUT",
                 "metadata": {"vendorId": vendor_id, "reference": reference}})


def submit_payout(run_id: str, agent_id: str, vendor_id: str, amount: float, currency: str, rail: str, reference: str) -> dict[str, object]:
    """Cross-border mass-payout rail: onboard and KYC-verify the recipient, lock an
    FX quote for the corridor, then release the payout funded from the USD balance."""
    rec = _run(run_id, agent_id, "submit_payout", "quetzal-payouts", "create_recipient",
               {"name": vendor_id, "currency": currency, "method": "bank", "type": "business"})
    data = rec.get("data") if isinstance(rec, dict) else None
    recipient_id = data.get("id") if isinstance(data, dict) else None
    if not recipient_id:
        return rec

    _run(run_id, agent_id, "submit_payout", "quetzal-payouts", "verify_recipient",
         {"recipientId": recipient_id})

    quote = _run(run_id, agent_id, "submit_payout", "quetzal-payouts", "get_quote",
                 {"sourceCurrency": "USD", "targetCurrency": currency,
                  "targetAmount": amount, "payoutMethod": "bank_transfer"})
    qdata = quote.get("data") if isinstance(quote, dict) else None
    source_amount = qdata.get("sourceAmount") if isinstance(qdata, dict) else None
    quote_id = qdata.get("quoteId") if isinstance(qdata, dict) else None

    return _run(run_id, agent_id, "submit_payout", "quetzal-payouts", "create_payout",
                {"recipientId": recipient_id, "amount": source_amount or amount,
                 "currency": "USD", "quoteId": quote_id, "purpose": "supplier invoice",
                 "reference": reference or vendor_id})


def get_payout_status(run_id: str, agent_id: str, payout_id: str) -> dict[str, object]:
    """Track a cross-border payout through its delivery lifecycle to settlement."""
    return _run(run_id, agent_id, "get_payout_status", "quetzal-payouts", "get_payout",
                {"payoutId": payout_id})


def create_outbound_payment(run_id: str, agent_id: str, vendor_id: str, amount: float, currency: str, rail: str, reference: str) -> dict[str, object]:
    """Open-banking rail: draw from a currency-matched enabled account and pay the creditor."""
    accounts = _run(run_id, agent_id, "create_outbound_payment", "halcyon-bank", "list_accounts",
                    {"status": "Enabled"})
    data = accounts.get("data") if isinstance(accounts, dict) else None
    items = data.get("items") if isinstance(data, dict) else None
    from_account = vendor_id
    if isinstance(items, list) and items:
        matched = next((a for a in items if a.get("currency") == currency
                        and a.get("accountSubType") == "CurrentAccount"), None)
        from_account = (matched or items[0])["accountId"]
    return _run(run_id, agent_id, "create_outbound_payment", "halcyon-bank", "initiate_payment",
                {"fromAccount": from_account, "amount": amount, "currency": currency,
                 "rail": (rail or "").upper(), "creditor": vendor_id,
                 "reference": reference or vendor_id})


# -- audit tools --

def get_contract_terms(run_id: str, agent_id: str, vendor_id: str) -> dict[str, object]:
    return _run(run_id, agent_id, "get_contract_terms", "atlas-vendor", "get_contract_terms",
                {"contractId": vendor_id})


def get_payment_status(run_id: str, agent_id: str, charge_id: str) -> dict[str, object]:
    return _run(run_id, agent_id, "get_payment_status", "meridian-pay", "get_charge",
                {"chargeId": charge_id})


# -- receivables tools (meridian-pay acceptance, refunds, disputes, settlements) --

def capture_receivable(run_id: str, agent_id: str, customer_id: str, amount: float,
                       currency: str, source: str = "tok_visa") -> dict[str, object]:
    """Accept an inbound customer payment on the card-acceptance rail."""
    return _run(run_id, agent_id, "capture_receivable", "meridian-pay", "create_charge",
                {"amount": amount, "currency": currency, "source": source,
                 "customer": customer_id, "metadata": {"customerId": customer_id}})


def refund_receivable(run_id: str, agent_id: str, charge_id: str,
                      amount: float | None = None) -> dict[str, object]:
    """Refund a captured receivable in full or in part."""
    payload: dict[str, object] = {"chargeId": charge_id, "reason": "requested_by_customer"}
    if amount is not None:
        payload["amount"] = amount
    return _run(run_id, agent_id, "refund_receivable", "meridian-pay", "refund_charge", payload)


def list_payment_disputes(run_id: str, agent_id: str, status: str = "") -> dict[str, object]:
    """List chargeback disputes raised against captured receivables."""
    payload = {"status": status} if status else {}
    return _run(run_id, agent_id, "list_payment_disputes", "meridian-pay", "list_disputes", payload)


def get_payout_status(run_id: str, agent_id: str, payout_id: str) -> dict[str, object]:
    """Track a card-rail payout through to its settled state."""
    return _run(run_id, agent_id, "get_payout_status", "meridian-pay", "get_payout",
                {"payoutId": payout_id})


# -- vendor lifecycle tools --

def kyb_screen_vendor(run_id: str, agent_id: str, vendor_id: str) -> dict[str, object]:
    return _run(run_id, agent_id, "kyb_screen_vendor", "aegis-screening", "verify_business",
                {"legalName": vendor_id})


def register_vendor(run_id: str, agent_id: str, vendor_id: str) -> dict[str, object]:
    return _run(run_id, agent_id, "register_vendor", "atlas-vendor", "register_vendor",
                {"name": vendor_id, "country": "US"})


def refresh_vendor_compliance(run_id: str, agent_id: str, vendor_id: str) -> dict[str, object]:
    return _run(run_id, agent_id, "refresh_vendor_compliance", "atlas-vendor", "get_compliance_status",
                {"vendorId": vendor_id})


def get_vendor_onboarding_status(run_id: str, agent_id: str, vendor_id: str) -> dict[str, object]:
    return _run(run_id, agent_id, "get_vendor_onboarding_status", "atlas-vendor",
                "get_onboarding_status", {"vendorId": vendor_id})


def advance_vendor_onboarding(run_id: str, agent_id: str, vendor_id: str,
                              step: str, outcome: str = "pass") -> dict[str, object]:
    return _run(run_id, agent_id, "advance_vendor_onboarding", "atlas-vendor",
                "advance_onboarding", {"vendorId": vendor_id, "step": step, "outcome": outcome})


def verify_vendor_banking(run_id: str, agent_id: str, vendor_id: str,
                          account_number: str = "") -> dict[str, object]:
    payload: dict[str, object] = {"vendorId": vendor_id}
    if account_number:
        payload["accountNumber"] = account_number
    return _run(run_id, agent_id, "verify_vendor_banking", "atlas-vendor",
                "verify_vendor_banking", payload)


# -- treasury tools --

def get_cash_position(run_id: str, agent_id: str, region: str) -> dict[str, object]:
    return _run(run_id, agent_id, "get_cash_position", "keystone-treasury", "get_position",
                {"currency": _ccy(region)})


def get_treasury_summary(run_id: str, agent_id: str) -> dict[str, object]:
    return _run(run_id, agent_id, "get_treasury_summary", "keystone-treasury",
                "get_position_summary", {})


def forecast_liquidity(run_id: str, agent_id: str, horizon_days: int,
                       scenario: str = "base") -> dict[str, object]:
    return _run(run_id, agent_id, "forecast_liquidity", "keystone-treasury", "forecast_liquidity",
                {"currency": "USD", "horizonDays": horizon_days, "scenario": scenario})


def get_fx_exposure(run_id: str, agent_id: str, currency: str) -> dict[str, object]:
    return _run(run_id, agent_id, "get_fx_exposure", "keystone-treasury", "get_exposure",
                {"currency": currency.upper()})


def place_fx_hedge(run_id: str, agent_id: str, from_currency: str, to_currency: str, notional: float, tenor_days: int) -> dict[str, object]:
    return _run(run_id, agent_id, "place_fx_hedge", "keystone-treasury", "place_hedge",
                {"pair": f"{from_currency}/{to_currency}", "notional": notional, "side": "buy",
                 "instrument": "forward", "tenorDays": tenor_days})


def transfer_funds(run_id: str, agent_id: str, from_region: str, to_region: str, amount_usd: float) -> dict[str, object]:
    return _run(run_id, agent_id, "transfer_funds", "keystone-treasury", "transfer_funds",
                {"currency": "USD", "amount": amount_usd, "destination": to_region,
                 "purposeCode": "INTC"})


# -- close tools --

def list_ledger_accounts(run_id: str, agent_id: str, account_type: str = "") -> dict[str, object]:
    payload = {"type": account_type} if account_type else {}
    return _run(run_id, agent_id, "list_ledger_accounts", "slate-ledger", "list_accounts", payload)


def post_journal_entry(run_id: str, agent_id: str, account_id: str, amount: float, currency: str, period: str) -> dict[str, object]:
    lines = [
        {"accountNo": account_id, "debit": amount, "credit": 0.0, "memo": "Close journal"},
        {"accountNo": "2100", "debit": 0.0, "credit": amount, "memo": "Accrued liability"},
    ]
    return _run(run_id, agent_id, "post_journal_entry", "slate-ledger", "post_entry",
                {"period": period, "currency": currency, "type": "standard",
                 "description": "Period-close journal", "lines": lines})


def reconcile_account(run_id: str, agent_id: str, account_id: str) -> dict[str, object]:
    started = _run(run_id, agent_id, "reconcile_account", "slate-ledger", "reconcile_account",
                   {"accountId": account_id})
    rec = started.get("data") if isinstance(started, dict) else None
    if not isinstance(rec, dict) or "reconciliationId" not in rec:
        return started
    return _run(run_id, agent_id, "reconcile_account", "slate-ledger", "get_reconciliation",
                {"reconciliationId": rec["reconciliationId"]})


def compute_accrual(run_id: str, agent_id: str, category: str, period: str) -> dict[str, object]:
    return _run(run_id, agent_id, "compute_accrual", "slate-ledger", "create_accrual",
                {"amount": 12000, "periods": 12, "description": category})


def get_trial_balance(run_id: str, agent_id: str, period: str) -> dict[str, object]:
    return _run(run_id, agent_id, "get_trial_balance", "slate-ledger", "trial_balance",
                {"period": period})


def close_period(run_id: str, agent_id: str, period: str) -> dict[str, object]:
    return _run(run_id, agent_id, "close_period", "slate-ledger", "close_period",
                {"period": period})


# -- compliance / regulatory tools --

def aml_monitor_transaction(run_id: str, agent_id: str, vendor_id: str, amount: float,
                            currency: str, channel: str = "wire") -> dict[str, object]:
    return _run(run_id, agent_id, "aml_monitor_transaction", "verafin-monitor", "monitor_transaction",
                {"transactionId": vendor_id, "customerId": vendor_id, "amount": amount,
                 "currency": currency, "channel": channel})


def sanctions_screen_batch(run_id: str, agent_id: str, batch_id: str) -> dict[str, object]:
    return _run(run_id, agent_id, "sanctions_screen_batch", "aegis-screening", "screen_batch",
                {"batchId": batch_id})


def prepare_regulatory_filing(run_id: str, agent_id: str, filing_type: str, alert_id: str) -> dict[str, object]:
    return _run(run_id, agent_id, "prepare_regulatory_filing", "verafin-monitor", "prepare_filing",
                {"alertId": alert_id, "filingType": filing_type})


def submit_regulatory_filing(run_id: str, agent_id: str, filing_id: str) -> dict[str, object]:
    return _run(run_id, agent_id, "submit_regulatory_filing", "verafin-monitor", "submit_filing",
                {"filingId": filing_id})


def attest_control(run_id: str, agent_id: str, control_id: str,
                   effectiveness: str = "effective") -> dict[str, object]:
    return _run(run_id, agent_id, "attest_control", "verafin-monitor", "attest_control",
                {"controlId": control_id, "attestor": agent_id, "effectiveness": effectiveness})


# -- receivables tools --

def issue_customer_invoice(run_id: str, agent_id: str, customer_id: str, amount: float, currency: str) -> dict[str, object]:
    return _run(run_id, agent_id, "issue_customer_invoice", "core-billing", "create_invoice",
                {"customerId": customer_id, "amount": amount})


def send_dunning_notice(run_id: str, agent_id: str, customer_id: str, stage: int) -> dict[str, object]:
    return _run(run_id, agent_id, "send_dunning_notice", "vela-notify", "send_message",
                {"channel": "email", "to": customer_id, "template": "dunning_reminder"})


def apply_customer_payment(run_id: str, agent_id: str, invoice_id: str, amount: float) -> dict[str, object]:
    return _run(run_id, agent_id, "apply_customer_payment", "core-billing", "apply_payment",
                {"invoiceId": invoice_id, "amount": amount})


def get_ar_aging(run_id: str, agent_id: str, region: str) -> dict[str, object]:
    return _run(run_id, agent_id, "get_ar_aging", "core-billing", "get_ar_aging", {})


# -- procurement tools (junction-procure) --

def create_requisition(run_id: str, agent_id: str, department: str, amount: float, description: str) -> dict[str, object]:
    return _run(run_id, agent_id, "create_requisition", "junction-procure", "create_requisition",
                {"department": department, "amount": amount, "description": description})


def approve_requisition(run_id: str, agent_id: str, requisition_id: str) -> dict[str, object]:
    return _run(run_id, agent_id, "approve_requisition", "junction-procure", "approve_requisition",
                {"requisitionId": requisition_id})


def create_purchase_order(run_id: str, agent_id: str, requisition_id: str, vendor_id: str) -> dict[str, object]:
    return _run(run_id, agent_id, "create_purchase_order", "junction-procure", "create_purchase_order",
                {"requisitionId": requisition_id, "vendorId": vendor_id})


def get_budget(run_id: str, agent_id: str, department: str) -> dict[str, object]:
    return _run(run_id, agent_id, "get_budget", "junction-procure", "get_budget",
                {"department": department})


# -- crm tools (beacon-crm) --

def get_supplier_contact(run_id: str, agent_id: str, contact_id: str) -> dict[str, object]:
    return _run(run_id, agent_id, "get_supplier_contact", "beacon-crm", "get_contact",
                {"contactId": contact_id})


def list_supplier_contacts(run_id: str, agent_id: str, account_id: str) -> dict[str, object]:
    return _run(run_id, agent_id, "list_supplier_contacts", "beacon-crm", "list_contacts",
                {"accountId": account_id})


def get_supplier_account(run_id: str, agent_id: str, account_id: str) -> dict[str, object]:
    return _run(run_id, agent_id, "get_supplier_account", "beacon-crm", "get_account",
                {"accountId": account_id})


def list_supplier_deals(run_id: str, agent_id: str, account_id: str) -> dict[str, object]:
    return _run(run_id, agent_id, "list_supplier_deals", "beacon-crm", "list_deals",
                {"accountId": account_id, "status": "open"})


def advance_supplier_deal(run_id: str, agent_id: str, deal_id: str, stage: str) -> dict[str, object]:
    return _run(run_id, agent_id, "advance_supplier_deal", "beacon-crm", "update_deal",
                {"dealId": deal_id, "stage": stage})


def log_supplier_activity(run_id: str, agent_id: str, contact_id: str, activity_type: str) -> dict[str, object]:
    return _run(run_id, agent_id, "log_supplier_activity", "beacon-crm", "log_activity",
                {"contactId": contact_id, "type": activity_type})


def add_supplier_note(run_id: str, agent_id: str, contact_id: str, body: str) -> dict[str, object]:
    return _run(run_id, agent_id, "add_supplier_note", "beacon-crm", "add_note",
                {"contactId": contact_id, "body": body})


# -- identity tools (lumen-identity, internal directory) --

def resolve_user(run_id: str, agent_id: str, user_id: str) -> dict[str, object]:
    return _run(run_id, agent_id, "resolve_user", "lumen-identity", "get_user",
                {"userId": user_id})


def list_approver_groups(run_id: str, agent_id: str) -> dict[str, object]:
    return _run(run_id, agent_id, "list_approver_groups", "lumen-identity", "list_groups",
                {"type": "access"})


def resolve_approver_chain(run_id: str, agent_id: str, user_id: str) -> dict[str, object]:
    return _run(run_id, agent_id, "resolve_approver_chain", "lumen-identity", "get_manager_chain",
                {"userId": user_id})


def check_user_access(run_id: str, agent_id: str, user_id: str) -> dict[str, object]:
    return _run(run_id, agent_id, "check_user_access", "lumen-identity", "get_user_access",
                {"userId": user_id})


def list_team_members(run_id: str, agent_id: str, team_id: str) -> dict[str, object]:
    return _run(run_id, agent_id, "list_team_members", "lumen-identity", "list_users",
                {"teamId": team_id})


def get_service_identity(run_id: str, agent_id: str, service_account_id: str) -> dict[str, object]:
    return _run(run_id, agent_id, "get_service_identity", "lumen-identity", "get_service_account",
                {"serviceAccountId": service_account_id})


# -- market data tools (pulse-market) --

def get_market_snapshot(run_id: str, agent_id: str, symbol: str) -> dict[str, object]:
    return _run(run_id, agent_id, "get_market_snapshot", "pulse-market", "get_snapshot",
                {"symbol": symbol})


# -- external partner integration tool --

def partner_operation(run_id: str, agent_id: str, provider_id: str, operation: str,
                      payload: dict[str, object] | None = None) -> dict[str, object]:
    args = {"provider_id": provider_id, "operation": operation, "payload": payload or {}}
    bus.publish(ev.tool_call(run_id, agent_id, "partner_operation", args))
    bus.publish(ev.service_call(run_id, agent_id, provider_id, operation, args["payload"]))
    try:
        result = _partner(provider_id, operation, payload or {})
    except PartnerPendingCaracal:
        result = {"provider": provider_id, "operation": operation,
                  "status": "pending_caracal_integration",
                  "message": "provider activates in the Caracal SDK integration phase"}
    bus.publish(ev.service_result(run_id, agent_id, provider_id, operation, result))
    bus.publish(ev.tool_result(run_id, agent_id, "partner_operation", result))
    return result


TOOLS: dict[str, Callable] = {
    "extract_invoice": extract_invoice,
    "get_vendor_profile": get_vendor_profile,
    "get_fx_rate": get_fx_rate,
    "match_invoice": match_invoice,
    "netsuite_match_invoice": netsuite_match_invoice,
    "netsuite_get_vendor_record": netsuite_get_vendor_record,
    "sap_match_invoice": sap_match_invoice,
    "sap_get_vendor_record": sap_get_vendor_record,
    "netsuite_create_purchase_order": netsuite_create_purchase_order,
    "netsuite_record_vendor_bill": netsuite_record_vendor_bill,
    "netsuite_list_open_bills": netsuite_list_open_bills,
    "netsuite_post_journal_entry": netsuite_post_journal_entry,
    "netsuite_get_ap_account": netsuite_get_ap_account,
    "quickbooks_match_bill": quickbooks_match_bill,
    "quickbooks_get_vendor": quickbooks_get_vendor,
    "quickbooks_pay_bill": quickbooks_pay_bill,
    "quickbooks_record_expense": quickbooks_record_expense,
    "quickbooks_issue_invoice": quickbooks_issue_invoice,
    "quickbooks_apply_payment": quickbooks_apply_payment,
    "quickbooks_run_report": quickbooks_run_report,
    "check_vendor": check_vendor,
    "check_transaction": check_transaction,
    "get_withholding_rate": get_withholding_rate,
    "validate_tax_id": validate_tax_id,
    "get_account_balance": get_account_balance,
    "get_quote": get_quote,
    "convert_currency": convert_currency,
    "settle_vendor_fx_payment": settle_vendor_fx_payment,
    "get_fx_settlement_status": get_fx_settlement_status,
    "submit_payment": submit_payment,
    "submit_payout": submit_payout,
    "create_outbound_payment": create_outbound_payment,
    "get_contract_terms": get_contract_terms,
    "get_payment_status": get_payment_status,
    "capture_receivable": capture_receivable,
    "refund_receivable": refund_receivable,
    "list_payment_disputes": list_payment_disputes,
    "get_payout_status": get_payout_status,
    "kyb_screen_vendor": kyb_screen_vendor,
    "register_vendor": register_vendor,
    "refresh_vendor_compliance": refresh_vendor_compliance,
    "get_vendor_onboarding_status": get_vendor_onboarding_status,
    "advance_vendor_onboarding": advance_vendor_onboarding,
    "verify_vendor_banking": verify_vendor_banking,
    "get_cash_position": get_cash_position,
    "get_treasury_summary": get_treasury_summary,
    "forecast_liquidity": forecast_liquidity,
    "get_fx_exposure": get_fx_exposure,
    "place_fx_hedge": place_fx_hedge,
    "transfer_funds": transfer_funds,
    "post_journal_entry": post_journal_entry,
    "list_ledger_accounts": list_ledger_accounts,
    "reconcile_account": reconcile_account,
    "compute_accrual": compute_accrual,
    "get_trial_balance": get_trial_balance,
    "close_period": close_period,
    "aml_monitor_transaction": aml_monitor_transaction,
    "sanctions_screen_batch": sanctions_screen_batch,
    "prepare_regulatory_filing": prepare_regulatory_filing,
    "submit_regulatory_filing": submit_regulatory_filing,
    "attest_control": attest_control,
    "issue_customer_invoice": issue_customer_invoice,
    "send_dunning_notice": send_dunning_notice,
    "apply_customer_payment": apply_customer_payment,
    "get_ar_aging": get_ar_aging,
    "create_requisition": create_requisition,
    "approve_requisition": approve_requisition,
    "create_purchase_order": create_purchase_order,
    "get_budget": get_budget,
    "get_supplier_contact": get_supplier_contact,
    "list_supplier_contacts": list_supplier_contacts,
    "get_supplier_account": get_supplier_account,
    "list_supplier_deals": list_supplier_deals,
    "advance_supplier_deal": advance_supplier_deal,
    "log_supplier_activity": log_supplier_activity,
    "add_supplier_note": add_supplier_note,
    "resolve_user": resolve_user,
    "list_approver_groups": list_approver_groups,
    "resolve_approver_chain": resolve_approver_chain,
    "check_user_access": check_user_access,
    "list_team_members": list_team_members,
    "get_service_identity": get_service_identity,
    "get_market_snapshot": get_market_snapshot,
    "partner_operation": partner_operation,
}
