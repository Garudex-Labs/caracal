"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Ironbark ERP domain: enterprise vendor master, purchase orders, vendor bills, three-way invoice match, journal entries, and the general ledger.
"""
from __future__ import annotations

import time

from _mock.providerlab.data import generators as gen
from _mock.providerlab.providers import base
from _mock.providerlab.providers.base import Ctx, DomainError

ID = "ironbark-erp"

_CLOSED_PERIODS = {"Nov 2025", "Dec 2025"}
_PRICE_VARIANCE_TOLERANCE = 0.05
_DECIMAL_CCY = {"JPY"}


def _iso(epoch: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def _round(amount: float, currency: str) -> float:
    return round(amount) if currency in _DECIMAL_CCY else round(amount, 2)


@base.seeder(ID)
def seed(state: base.State) -> None:
    for name, table in gen.ironbark_dataset(ID).items():
        state.tables[name] = table
    state.tables.setdefault("idempotency", {})


def _vendor(ctx: Ctx, vendor_id: str) -> dict:
    vendor = ctx.state.table("vendors").get(vendor_id)
    if vendor is None:
        raise DomainError(404, "vendor_not_found", f"no vendor record for {vendor_id}")
    return vendor


# --------------------------------------------------------------------------- #
# Vendors
# --------------------------------------------------------------------------- #
@base.op(ID, "list_vendors")
def list_vendors(ctx: Ctx) -> dict:
    ctx.require_scope("erp.read")
    items = list(ctx.state.table("vendors").values())
    query = str(ctx.get("query", "")).lower()
    if query:
        items = [v for v in items
                 if query in v["companyName"].lower() or query in v["entityId"].lower()]
    status = ctx.get("status")
    if status:
        items = [v for v in items if v["status"] == status]
    category = ctx.get("category")
    if category:
        items = [v for v in items if v["category"] == category]
    items.sort(key=lambda v: v["internalId"])
    return ctx.paginate(items, size_default=20)


@base.op(ID, "get_vendor")
def get_vendor(ctx: Ctx) -> dict:
    ctx.require_scope("erp.read")
    ctx.require("vendorId")
    return _vendor(ctx, ctx.payload["vendorId"])


# --------------------------------------------------------------------------- #
# Purchase orders
# --------------------------------------------------------------------------- #
@base.op(ID, "list_purchase_orders")
def list_purchase_orders(ctx: Ctx) -> dict:
    ctx.require_scope("erp.read")
    items = list(ctx.state.table("purchase_orders").values())
    vendor_id = ctx.get("vendorId")
    if vendor_id:
        items = [p for p in items if p["vendorId"] == vendor_id]
    status = ctx.get("status")
    if status:
        items = [p for p in items if p["status"] == status]
    items.sort(key=lambda p: p["tranId"])
    return ctx.paginate(items, size_default=20)


@base.op(ID, "get_purchase_order")
def get_purchase_order(ctx: Ctx) -> dict:
    ctx.require_scope("erp.read")
    ctx.require("purchaseOrderId")
    po = ctx.state.table("purchase_orders").get(ctx.payload["purchaseOrderId"])
    if po is None:
        raise DomainError(404, "purchase_order_not_found", ctx.payload["purchaseOrderId"])
    return po


@base.op(ID, "create_purchase_order")
def create_purchase_order(ctx: Ctx) -> dict:
    ctx.require_scope("erp.write")
    ctx.require("vendorId", "lines")
    vendor = _vendor(ctx, ctx.payload["vendorId"])
    if vendor["status"] != "active":
        raise DomainError(409, "vendor_inactive",
                          f"vendor {vendor['id']} is {vendor['status']} and cannot transact")
    raw_lines = ctx.payload["lines"]
    if not isinstance(raw_lines, list) or not raw_lines:
        raise DomainError(422, "invalid_request", "at least one line is required")
    lines, subtotal = [], 0.0
    for n, line in enumerate(raw_lines, start=1):
        try:
            quantity = int(line["quantity"])
            rate = float(line["rate"])
        except (KeyError, TypeError, ValueError):
            raise DomainError(422, "invalid_line", "each line needs numeric quantity and rate")
        if quantity <= 0 or rate < 0:
            raise DomainError(422, "invalid_line", "quantity must be positive and rate non-negative")
        amount = _round(quantity * rate, vendor["currency"])
        subtotal += amount
        lines.append({
            "lineId": n,
            "item": line.get("item", "Goods or services"),
            "description": line.get("description", ""),
            "account": line.get("account", "6300"),
            "quantity": quantity,
            "quantityReceived": 0,
            "quantityBilled": 0,
            "rate": rate,
            "amount": amount,
        })
    currency = vendor["currency"]
    rate = gen._TAX_RATE_BY_COUNTRY.get(vendor["addressBook"][0]["country"], 0.0)
    tax_total = _round(subtotal * rate, currency)
    now = base.now()
    po = {
        "id": base.new_id("po"),
        "tranId": f"PO-2026-{base.now()}",
        "type": "purchaseOrder",
        "vendorId": vendor["id"],
        "vendorName": vendor["companyName"],
        "status": "pendingReceipt",
        "approvalStatus": "pendingApproval",
        "subsidiary": vendor["subsidiary"],
        "department": ctx.get("department", "Operations"),
        "currency": currency,
        "memo": ctx.get("memo", f"Commitment to {vendor['companyName']}"),
        "lines": lines,
        "subtotal": _round(subtotal, currency),
        "taxTotal": tax_total,
        "total": _round(subtotal + tax_total, currency),
        "createdDate": _iso(now),
        "dueDate": ctx.get("dueDate", _iso(now + 30 * 86_400)),
    }
    ctx.state.table("purchase_orders")[po["id"]] = po
    return po


# --------------------------------------------------------------------------- #
# Vendor bills (accounts payable)
# --------------------------------------------------------------------------- #
@base.op(ID, "list_bills")
def list_bills(ctx: Ctx) -> dict:
    ctx.require_scope("erp.read")
    items = list(ctx.state.table("bills").values())
    vendor_id = ctx.get("vendorId")
    if vendor_id:
        items = [b for b in items if b["vendorId"] == vendor_id]
    status = ctx.get("status")
    if status:
        items = [b for b in items if b["status"] == status]
    items.sort(key=lambda b: b["createdDate"], reverse=True)
    return ctx.paginate(items, size_default=20)


@base.op(ID, "get_bill")
def get_bill(ctx: Ctx) -> dict:
    ctx.require_scope("erp.read")
    ctx.require("billId")
    bill = ctx.state.table("bills").get(ctx.payload["billId"])
    if bill is None:
        raise DomainError(404, "bill_not_found", ctx.payload["billId"])
    return bill


@base.op(ID, "create_bill")
def create_bill(ctx: Ctx) -> dict:
    ctx.require_scope("erp.write")
    ctx.require("vendorId")
    vendor = _vendor(ctx, ctx.payload["vendorId"])
    if vendor["status"] == "onHold":
        raise DomainError(409, "vendor_on_hold",
                          f"vendor {vendor['id']} is on hold; release before billing")
    if vendor["status"] == "inactive":
        raise DomainError(409, "vendor_inactive", f"vendor {vendor['id']} is inactive")

    currency = ctx.get("currency", vendor["currency"])
    if currency != vendor["currency"]:
        raise DomainError(422, "currency_mismatch",
                          f"vendor transacts in {vendor['currency']}, not {currency}")

    lines = ctx.get("lines")
    if isinstance(lines, list) and lines:
        subtotal = 0.0
        for line in lines:
            amount = line.get("amount")
            if amount is None:
                amount = float(line.get("quantity", 1)) * float(line.get("rate", 0))
            subtotal += _round(float(amount), currency)
    else:
        try:
            subtotal = float(ctx.payload["amount"])
        except (KeyError, TypeError, ValueError):
            raise DomainError(422, "invalid_request", "provide line items or a bill amount")
        lines = [{"lineId": 1, "item": ctx.get("memo", "Vendor charge"),
                  "account": vendor["defaultPayablesAccount"], "quantity": 1,
                  "rate": subtotal, "amount": subtotal}]
    subtotal = _round(subtotal, currency)
    if subtotal <= 0:
        raise DomainError(422, "invalid_amount", "bill amount must be positive")

    reference = ctx.get("referenceNumber")
    if reference:
        for existing in ctx.state.table("bills").values():
            if existing["vendorId"] == vendor["id"] and existing.get("referenceNumber") == reference:
                raise DomainError(409, "duplicate_bill",
                                  f"reference {reference} already recorded as {existing['id']}")

    po_id = ctx.get("purchaseOrderId")
    if po_id is not None:
        po = ctx.state.table("purchase_orders").get(po_id)
        if po is None:
            raise DomainError(404, "purchase_order_not_found", po_id)
        if po["vendorId"] != vendor["id"]:
            raise DomainError(422, "po_vendor_mismatch", "purchase order belongs to another vendor")
        if po["status"] in ("fullyBilled", "closed"):
            raise DomainError(409, "po_already_billed", f"purchase order {po_id} is {po['status']}")

    tax_total = _round(subtotal * gen._TAX_RATE_BY_COUNTRY.get(
        vendor["addressBook"][0]["country"], 0.0), currency)
    total = _round(subtotal + tax_total, currency)
    now = base.now()
    due = now + gen._term_days(vendor["terms"]) * 86_400
    needs_approval = total >= 50_000.0
    bill = {
        "id": base.new_id("bill"),
        "tranId": f"VENDBILL-{base.now()}",
        "type": "vendorBill",
        "vendorId": vendor["id"],
        "vendorName": vendor["companyName"],
        "referenceNumber": reference,
        "purchaseOrderId": po_id,
        "status": "pendingApproval" if needs_approval else "open",
        "approvalStatus": "pendingApproval" if needs_approval else "approved",
        "subsidiary": vendor["subsidiary"],
        "account": vendor["defaultPayablesAccount"],
        "currency": currency,
        "terms": vendor["terms"],
        "lines": lines,
        "subtotal": subtotal,
        "taxTotal": tax_total,
        "total": total,
        "amountPaid": 0.0,
        "amountRemaining": total,
        "postingPeriod": ctx.get("postingPeriod", time.strftime("%b %Y", time.gmtime(now))),
        "createdDate": _iso(now),
        "dueDate": _iso(due),
    }
    ctx.state.table("bills")[bill["id"]] = bill
    vendor["balancePrimary"] = _round(vendor["balancePrimary"] + total, currency)
    ctx.state.table("accounts")["ACCT-2000"]["balance"] = round(
        ctx.state.table("accounts")["ACCT-2000"]["balance"] + total, 2)
    return bill


@base.op(ID, "approve_bill")
def approve_bill(ctx: Ctx) -> dict:
    ctx.require_scope("erp.write")
    ctx.require("billId")
    bill = ctx.state.table("bills").get(ctx.payload["billId"])
    if bill is None:
        raise DomainError(404, "bill_not_found", ctx.payload["billId"])
    if bill["status"] != "pendingApproval":
        raise DomainError(409, "bill_not_pending",
                          f"bill {bill['id']} is {bill['status']} and not awaiting approval")
    bill["status"] = "open"
    bill["approvalStatus"] = "approved"
    return bill


# --------------------------------------------------------------------------- #
# Three-way invoice match (PO + receipt + vendor invoice), asynchronous
# --------------------------------------------------------------------------- #
@base.op(ID, "match_invoice")
def match_invoice(ctx: Ctx) -> dict:
    """Three-way match runs asynchronously: the first call queues the job and a
    later call reports completion, an exception on quantity/price variance, or a
    vendor that no longer exists."""
    ctx.require_scope("erp.write")
    ctx.require("invoiceId", "vendorId", "amount")
    matches = ctx.state.table("matches")
    key = str(ctx.payload["invoiceId"])
    if key not in matches:
        matches[key] = {
            "invoiceId": key,
            "vendorId": ctx.payload["vendorId"],
            "purchaseOrderId": ctx.get("purchaseOrderId"),
            "amount": float(ctx.payload["amount"]),
            "currency": ctx.get("currency", "USD"),
            "status": "processing",
            "jobId": base.new_id("job"),
            "submittedAt": _iso(base.now()),
        }
        return matches[key]

    rec = matches[key]
    if ctx.payload["vendorId"] not in ctx.state.table("vendors"):
        rec["status"] = "exception"
        rec["reason"] = "vendor_not_found"
        rec["completedAt"] = _iso(base.now())
        return rec

    po = ctx.state.table("purchase_orders").get(rec.get("purchaseOrderId") or "")
    if po is not None:
        variance = abs(po["total"] - rec["amount"]) / po["total"] if po["total"] else 0.0
        if variance > _PRICE_VARIANCE_TOLERANCE:
            rec["status"] = "exception"
            rec["reason"] = "price_variance"
            rec["variancePct"] = round(variance * 100, 2)
            rec["expectedAmount"] = po["total"]
            rec["completedAt"] = _iso(base.now())
            return rec
        rec["matchedPurchaseOrder"] = po["id"]
    rec["status"] = "matched"
    rec["confidence"] = 0.98
    rec["matchType"] = "threeWay" if po is not None else "twoWay"
    rec["completedAt"] = _iso(base.now())
    return rec


# --------------------------------------------------------------------------- #
# General ledger
# --------------------------------------------------------------------------- #
@base.op(ID, "post_journal_entry")
def post_journal_entry(ctx: Ctx) -> dict:
    ctx.require_scope("erp.write")
    lines = ctx.get("lines") or []
    if len(lines) < 2:
        raise DomainError(422, "unbalanced_entry", "a journal entry needs at least two lines")
    period = ctx.get("postingPeriod", time.strftime("%b %Y", time.gmtime(base.now())))
    if period in _CLOSED_PERIODS:
        raise DomainError(422, "period_closed", f"posting period {period} is closed")
    accounts = ctx.state.table("accounts")
    debit = credit = 0.0
    normalized = []
    for n, line in enumerate(lines, start=1):
        account = str(line.get("account", ""))
        if account and f"ACCT-{account}" not in accounts and account not in accounts:
            raise DomainError(422, "invalid_account", f"account {account} is not in the chart")
        d = float(line.get("debit", 0) or 0)
        c = float(line.get("credit", 0) or 0)
        debit += d
        credit += c
        normalized.append({"line": n, "account": account, "debit": d, "credit": c,
                           "memo": line.get("memo", ""), "department": line.get("department", "")})
    if round(debit - credit, 2) != 0:
        raise DomainError(422, "unbalanced_entry", f"debits {debit} != credits {credit}")
    now = base.now()
    entry = {
        "id": base.new_id("je"),
        "tranId": f"JOURNAL-{now}",
        "type": "journalEntry",
        "subsidiary": ctx.get("subsidiary", "LynxCapital : Consolidated"),
        "currency": ctx.get("currency", "USD"),
        "postingPeriod": period,
        "lines": normalized,
        "totalDebit": round(debit, 2),
        "totalCredit": round(credit, 2),
        "status": "posted",
        "reversalOf": ctx.get("reversalOf"),
        "createdDate": _iso(now),
    }
    ctx.state.table("journal_entries")[entry["id"]] = entry
    return entry


@base.op(ID, "get_journal_entry")
def get_journal_entry(ctx: Ctx) -> dict:
    ctx.require_scope("erp.read")
    ctx.require("entryId")
    entry = ctx.state.table("journal_entries").get(ctx.payload["entryId"])
    if entry is None:
        raise DomainError(404, "journal_entry_not_found", ctx.payload["entryId"])
    return entry


@base.op(ID, "list_journal_entries")
def list_journal_entries(ctx: Ctx) -> dict:
    ctx.require_scope("erp.read")
    items = list(ctx.state.table("journal_entries").values())
    period = ctx.get("postingPeriod")
    if period:
        items = [e for e in items if e["postingPeriod"] == period]
    items.sort(key=lambda e: e["createdDate"], reverse=True)
    return ctx.paginate(items, size_default=20)


# --------------------------------------------------------------------------- #
# Chart of accounts
# --------------------------------------------------------------------------- #
@base.op(ID, "list_accounts")
def list_accounts(ctx: Ctx) -> dict:
    ctx.require_scope("erp.read")
    items = list(ctx.state.table("accounts").values())
    acct_type = ctx.get("acctType")
    if acct_type:
        items = [a for a in items if a["acctType"] == acct_type]
    items.sort(key=lambda a: a["acctNumber"])
    return ctx.paginate(items, size_default=25)


@base.op(ID, "get_account")
def get_account(ctx: Ctx) -> dict:
    ctx.require_scope("erp.read")
    ctx.require("accountId")
    accounts = ctx.state.table("accounts")
    account_id = ctx.payload["accountId"]
    acct = accounts.get(account_id) or accounts.get(f"ACCT-{account_id}")
    if acct is None:
        raise DomainError(404, "account_not_found", account_id)
    return acct
