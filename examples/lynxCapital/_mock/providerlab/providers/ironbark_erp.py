"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Ironbark ERP domain: enterprise vendor master, purchase orders, item receipts, vendor bills, three-way invoice match, vendor payments, journal entries, and the general ledger.
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
_OPEN_BILL_STATES = ("open", "partiallyPaid")
_AGING_BUCKETS = ("current", "1-30", "31-60", "61-90", "90+")


def _iso(epoch: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def _round(amount: float, currency: str) -> float:
    return round(amount) if currency in _DECIMAL_CCY else round(amount, 2)


def _bank_account(currency: str) -> str:
    return gen._BANK_ACCOUNT_BY_CURRENCY.get(currency, gen._DEFAULT_BANK_ACCOUNT)


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


def _adjust_account(ctx: Ctx, account_id: str, delta: float) -> None:
    account = ctx.state.table("accounts").get(account_id)
    if account is not None:
        account["balance"] = round(account["balance"] + delta, 2)


# --------------------------------------------------------------------------- #
# Vendors
# --------------------------------------------------------------------------- #
@base.op(ID, "list_vendors")
def list_vendors(ctx: Ctx) -> dict:
    """List vendor-master records, filterable by free text, status, category, or subsidiary."""
    ctx.require_scope("erp.read")
    items = list(ctx.state.table("vendors").values())
    query = str(ctx.get("query", "")).lower()
    if query:
        items = [
            v
            for v in items
            if query in v["companyName"].lower() or query in v["entityId"].lower()
        ]
    status = ctx.get("status")
    if status:
        items = [v for v in items if v["status"] == status]
    category = ctx.get("category")
    if category:
        items = [v for v in items if v["category"] == category]
    subsidiary = ctx.get("subsidiary")
    if subsidiary:
        items = [v for v in items if v["subsidiary"] == subsidiary]
    items.sort(key=lambda v: v["internalId"])
    return ctx.paginate(items, size_default=20)


@base.op(ID, "get_vendor")
def get_vendor(ctx: Ctx) -> dict:
    """Retrieve a single vendor-master record by id."""
    ctx.require_scope("erp.read")
    ctx.require("vendorId")
    return _vendor(ctx, ctx.payload["vendorId"])


# --------------------------------------------------------------------------- #
# Purchase orders
# --------------------------------------------------------------------------- #
@base.op(ID, "list_purchase_orders")
def list_purchase_orders(ctx: Ctx) -> dict:
    """List purchase orders, filterable by vendor, status, subsidiary, or received status."""
    ctx.require_scope("erp.read")
    items = list(ctx.state.table("purchase_orders").values())
    vendor_id = ctx.get("vendorId")
    if vendor_id:
        items = [p for p in items if p["vendorId"] == vendor_id]
    status = ctx.get("status")
    if status:
        items = [p for p in items if p["status"] == status]
    subsidiary = ctx.get("subsidiary")
    if subsidiary:
        items = [p for p in items if p["subsidiary"] == subsidiary]
    received_status = ctx.get("receivedStatus")
    if received_status:
        items = [p for p in items if p["receivedStatus"] == received_status]
    items.sort(key=lambda p: p["tranId"])
    return ctx.paginate(items, size_default=20)


@base.op(ID, "get_purchase_order")
def get_purchase_order(ctx: Ctx) -> dict:
    """Retrieve a single purchase order with its lines, receipt, and billing status."""
    ctx.require_scope("erp.read")
    ctx.require("purchaseOrderId")
    po = ctx.state.table("purchase_orders").get(ctx.payload["purchaseOrderId"])
    if po is None:
        raise DomainError(
            404, "purchase_order_not_found", ctx.payload["purchaseOrderId"]
        )
    return po


@base.op(ID, "create_purchase_order")
def create_purchase_order(ctx: Ctx) -> dict:
    """Raise a purchase order committing spend to an active vendor."""
    ctx.require_scope("erp.write")
    ctx.require("vendorId", "lines")
    vendor = _vendor(ctx, ctx.payload["vendorId"])
    if vendor["status"] != "active":
        raise DomainError(
            409,
            "vendor_inactive",
            f"vendor {vendor['id']} is {vendor['status']} and cannot transact",
        )
    raw_lines = ctx.payload["lines"]
    if not isinstance(raw_lines, list) or not raw_lines:
        raise DomainError(422, "invalid_request", "at least one line is required")
    lines, subtotal = [], 0.0
    for n, line in enumerate(raw_lines, start=1):
        try:
            quantity = int(line["quantity"])
            rate = float(line["rate"])
        except (KeyError, TypeError, ValueError):
            raise DomainError(
                422, "invalid_line", "each line needs numeric quantity and rate"
            )
        if quantity <= 0 or rate < 0:
            raise DomainError(
                422, "invalid_line", "quantity must be positive and rate non-negative"
            )
        amount = _round(quantity * rate, vendor["currency"])
        subtotal += amount
        lines.append(
            {
                "lineId": n,
                "item": line.get("item", "Goods or services"),
                "description": line.get("description", ""),
                "account": line.get("account", "6300"),
                "quantity": quantity,
                "quantityReceived": 0,
                "quantityBilled": 0,
                "rate": rate,
                "amount": amount,
            }
        )
    currency = vendor["currency"]
    tax_rate = gen._TAX_RATE_BY_COUNTRY.get(vendor["addressBook"][0]["country"], 0.0)
    tax_total = _round(subtotal * tax_rate, currency)
    now = base.now()
    po = {
        "id": base.new_id("po"),
        "tranId": f"PO-2026-{base.now()}",
        "type": "purchaseOrder",
        "tranDate": _iso(now)[:10],
        "entity": vendor["id"],
        "vendorId": vendor["id"],
        "vendorName": vendor["companyName"],
        "status": "pendingReceipt",
        "receivedStatus": "notReceived",
        "billingStatus": "notBilled",
        "approvalStatus": "pendingApproval",
        "subsidiary": vendor["subsidiary"],
        "department": ctx.get("department", "Operations"),
        "location": ctx.get("location", gen._ERP_LOCATIONS[0]),
        "class": ctx.get("class", gen._ERP_CLASSES[0]),
        "employee": ctx.get("employee", gen._ERP_AP_CLERK),
        "currency": currency,
        "exchangeRate": gen._fx_rate(currency),
        "incoterm": ctx.get("incoterm", vendor["incoterm"]),
        "shipMethod": ctx.get("shipMethod", gen._SHIP_METHODS[0]),
        "memo": ctx.get("memo", f"Commitment to {vendor['companyName']}"),
        "lines": lines,
        "subtotal": _round(subtotal, currency),
        "taxTotal": tax_total,
        "total": _round(subtotal + tax_total, currency),
        "createdDate": _iso(now),
        "dueDate": ctx.get("dueDate", _iso(now + 30 * 86_400)),
    }
    ctx.state.table("purchase_orders")[po["id"]] = po
    vendor["unbilledOrdersPrimary"] = _round(
        vendor["unbilledOrdersPrimary"] + po["total"], currency
    )
    return po


@base.op(ID, "receive_purchase_order")
def receive_purchase_order(ctx: Ctx) -> dict:
    """Book an item receipt against a purchase order. Receiving every ordered unit
    moves the order to pendingBilling; a partial receipt leaves it open for more."""
    ctx.require_scope("erp.write")
    ctx.require("purchaseOrderId")
    po = ctx.state.table("purchase_orders").get(ctx.payload["purchaseOrderId"])
    if po is None:
        raise DomainError(
            404, "purchase_order_not_found", ctx.payload["purchaseOrderId"]
        )
    if po["status"] in ("fullyBilled", "closed"):
        raise DomainError(
            409, "po_not_receivable", f"purchase order {po['id']} is {po['status']}"
        )

    by_line = {l["lineId"]: l for l in po["lines"]}
    raw = ctx.get("lines")
    receipt_lines = []
    if isinstance(raw, list) and raw:
        for entry in raw:
            line = by_line.get(int(entry.get("lineId", 0)))
            if line is None:
                raise DomainError(
                    422, "invalid_line", f"line {entry.get('lineId')} not on this order"
                )
            remaining = line["quantity"] - line["quantityReceived"]
            qty = int(entry.get("quantity", remaining))
            if qty <= 0 or qty > remaining:
                raise DomainError(
                    422,
                    "invalid_quantity",
                    f"line {line['lineId']} can receive up to {remaining}",
                )
            line["quantityReceived"] += qty
            receipt_lines.append(
                {
                    "lineId": line["lineId"],
                    "item": line["item"],
                    "quantity": qty,
                    "quantityOrdered": line["quantity"],
                }
            )
    else:
        for line in po["lines"]:
            remaining = line["quantity"] - line["quantityReceived"]
            if remaining > 0:
                line["quantityReceived"] = line["quantity"]
                receipt_lines.append(
                    {
                        "lineId": line["lineId"],
                        "item": line["item"],
                        "quantity": remaining,
                        "quantityOrdered": line["quantity"],
                    }
                )
    if not receipt_lines:
        raise DomainError(
            409, "nothing_to_receive", "every line is already fully received"
        )

    fully = all(l["quantityReceived"] >= l["quantity"] for l in po["lines"])
    po["status"] = "pendingBilling" if fully else "partiallyReceived"
    po["receivedStatus"] = "fullyReceived" if fully else "partiallyReceived"
    now = base.now()
    receipt = {
        "id": base.new_id("rcpt"),
        "tranId": f"ITEMRCPT-{now}",
        "type": "itemReceipt",
        "tranDate": _iso(now)[:10],
        "createdFrom": po["id"],
        "purchaseOrderTranId": po["tranId"],
        "entity": po["vendorId"],
        "vendorId": po["vendorId"],
        "vendorName": po["vendorName"],
        "subsidiary": po["subsidiary"],
        "location": po["location"],
        "status": "received",
        "lines": receipt_lines,
        "createdDate": _iso(now),
    }
    ctx.state.table("item_receipts")[receipt["id"]] = receipt
    return {"itemReceipt": receipt, "purchaseOrder": po}


@base.op(ID, "list_item_receipts")
def list_item_receipts(ctx: Ctx) -> dict:
    """List item receipts, filterable by source purchase order or vendor."""
    ctx.require_scope("erp.read")
    items = list(ctx.state.table("item_receipts").values())
    po_id = ctx.get("purchaseOrderId")
    if po_id:
        items = [r for r in items if r["createdFrom"] == po_id]
    vendor_id = ctx.get("vendorId")
    if vendor_id:
        items = [r for r in items if r["vendorId"] == vendor_id]
    items.sort(key=lambda r: r["createdDate"], reverse=True)
    return ctx.paginate(items, size_default=20)


# --------------------------------------------------------------------------- #
# Vendor bills (accounts payable)
# --------------------------------------------------------------------------- #
@base.op(ID, "list_bills")
def list_bills(ctx: Ctx) -> dict:
    """List vendor bills, filterable by vendor, status, approval status, posting
    period, or an overdue flag for bills past their due date."""
    ctx.require_scope("erp.read")
    items = list(ctx.state.table("bills").values())
    vendor_id = ctx.get("vendorId")
    if vendor_id:
        items = [b for b in items if b["vendorId"] == vendor_id]
    status = ctx.get("status")
    if status:
        items = [b for b in items if b["status"] == status]
    approval_status = ctx.get("approvalStatus")
    if approval_status:
        items = [b for b in items if b["approvalStatus"] == approval_status]
    period = ctx.get("postingPeriod")
    if period:
        items = [b for b in items if b["postingPeriod"] == period]
    if ctx.get("overdue") is not None:
        today = _iso(base.now())[:10]
        wanted = bool(ctx.get("overdue"))
        items = [
            b
            for b in items
            if (b["status"] in _OPEN_BILL_STATES and b["dueDate"][:10] < today)
            == wanted
        ]
    items.sort(key=lambda b: b["createdDate"], reverse=True)
    return ctx.paginate(items, size_default=20)


@base.op(ID, "get_bill")
def get_bill(ctx: Ctx) -> dict:
    """Retrieve a single vendor bill with its lines, tax, and payment status."""
    ctx.require_scope("erp.read")
    ctx.require("billId")
    bill = ctx.state.table("bills").get(ctx.payload["billId"])
    if bill is None:
        raise DomainError(404, "bill_not_found", ctx.payload["billId"])
    return bill


@base.op(ID, "create_bill")
def create_bill(ctx: Ctx) -> dict:
    """Record a vendor bill, optionally against a purchase order. Bills of $50,000
    or more route for approval; reused reference numbers are rejected as duplicates."""
    ctx.require_scope("erp.write")
    ctx.require("vendorId")
    vendor = _vendor(ctx, ctx.payload["vendorId"])
    if vendor["status"] == "onHold":
        raise DomainError(
            409,
            "vendor_on_hold",
            f"vendor {vendor['id']} is on hold; release before billing",
        )
    if vendor["status"] == "inactive":
        raise DomainError(409, "vendor_inactive", f"vendor {vendor['id']} is inactive")

    currency = ctx.get("currency", vendor["currency"])
    if currency != vendor["currency"]:
        raise DomainError(
            422,
            "currency_mismatch",
            f"vendor transacts in {vendor['currency']}, not {currency}",
        )

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
            raise DomainError(
                422, "invalid_request", "provide line items or a bill amount"
            )
        lines = [
            {
                "lineId": 1,
                "item": ctx.get("memo", "Vendor charge"),
                "account": vendor["defaultPayablesAccount"],
                "quantity": 1,
                "rate": subtotal,
                "amount": subtotal,
            }
        ]
    subtotal = _round(subtotal, currency)
    if subtotal <= 0:
        raise DomainError(422, "invalid_amount", "bill amount must be positive")

    reference = ctx.get("referenceNumber")
    if reference:
        for existing in ctx.state.table("bills").values():
            if (
                existing["vendorId"] == vendor["id"]
                and existing.get("referenceNumber") == reference
            ):
                raise DomainError(
                    409,
                    "duplicate_bill",
                    f"reference {reference} already recorded as {existing['id']}",
                )

    po_id = ctx.get("purchaseOrderId")
    po = None
    if po_id is not None:
        po = ctx.state.table("purchase_orders").get(po_id)
        if po is None:
            raise DomainError(404, "purchase_order_not_found", po_id)
        if po["vendorId"] != vendor["id"]:
            raise DomainError(
                422, "po_vendor_mismatch", "purchase order belongs to another vendor"
            )
        if po["status"] in ("fullyBilled", "closed"):
            raise DomainError(
                409, "po_already_billed", f"purchase order {po_id} is {po['status']}"
            )

    country = vendor["addressBook"][0]["country"]
    tax_total = _round(subtotal * gen._TAX_RATE_BY_COUNTRY.get(country, 0.0), currency)
    total = _round(subtotal + tax_total, currency)
    now = base.now()
    created_day = _iso(now)[:10]
    due = now + gen._term_days(vendor["terms"]) * 86_400
    needs_approval = total >= 50_000.0
    discount_pct = gen._DISCOUNT_PCT_BY_TERM.get(vendor["terms"], 0.0)
    bill = {
        "id": base.new_id("bill"),
        "tranId": f"VENDBILL-{base.now()}",
        "type": "vendorBill",
        "tranDate": created_day,
        "entity": vendor["id"],
        "vendorId": vendor["id"],
        "vendorName": vendor["companyName"],
        "referenceNumber": reference,
        "purchaseOrderId": po_id,
        "status": "pendingApproval" if needs_approval else "open",
        "approvalStatus": "pendingApproval" if needs_approval else "approved",
        "paymentHold": bool(ctx.get("paymentHold", False)),
        "subsidiary": vendor["subsidiary"],
        "account": vendor["defaultPayablesAccount"],
        "nexus": country,
        "currency": currency,
        "exchangeRate": gen._fx_rate(currency),
        "terms": vendor["terms"],
        "discountDate": _iso(now + 10 * 86_400)[:10] if discount_pct else None,
        "discountAmount": _round(subtotal * discount_pct, currency)
        if discount_pct
        else 0.0,
        "lines": lines,
        "subtotal": subtotal,
        "taxTotal": tax_total,
        "total": total,
        "amountPaid": 0.0,
        "amountRemaining": total,
        "postingPeriod": ctx.get(
            "postingPeriod", time.strftime("%b %Y", time.gmtime(now))
        ),
        "createdDate": _iso(now),
        "dueDate": _iso(due),
    }
    ctx.state.table("bills")[bill["id"]] = bill
    vendor["balancePrimary"] = _round(vendor["balancePrimary"] + total, currency)
    vendor["openBillCount"] += 1
    if po is not None:
        po["billingStatus"] = "fullyBilled"
        po["status"] = "fullyBilled"
        vendor["unbilledOrdersPrimary"] = _round(
            max(0.0, vendor["unbilledOrdersPrimary"] - po["total"]), currency
        )
    _adjust_account(ctx, "ACCT-2000", total)
    return bill


@base.op(ID, "approve_bill")
def approve_bill(ctx: Ctx) -> dict:
    """Approve a vendor bill that is awaiting approval, opening it for payment."""
    ctx.require_scope("erp.write")
    ctx.require("billId")
    bill = ctx.state.table("bills").get(ctx.payload["billId"])
    if bill is None:
        raise DomainError(404, "bill_not_found", ctx.payload["billId"])
    if bill["status"] != "pendingApproval":
        raise DomainError(
            409,
            "bill_not_pending",
            f"bill {bill['id']} is {bill['status']} and not awaiting approval",
        )
    bill["status"] = "open"
    bill["approvalStatus"] = "approved"
    return bill


@base.op(ID, "pay_bill")
def pay_bill(ctx: Ctx) -> dict:
    """Settle an approved, open vendor bill in full or in part. Posts a vendor
    payment, relieves the AP control account, and draws the operating bank."""
    ctx.require_scope("erp.write")
    ctx.require("billId")
    bill = ctx.state.table("bills").get(ctx.payload["billId"])
    if bill is None:
        raise DomainError(404, "bill_not_found", ctx.payload["billId"])
    if bill["status"] == "pendingApproval":
        raise DomainError(
            409,
            "bill_not_approved",
            f"bill {bill['id']} is awaiting approval and cannot be paid",
        )
    if bill["status"] not in _OPEN_BILL_STATES:
        raise DomainError(
            409, "bill_not_payable", f"bill {bill['id']} is {bill['status']}"
        )
    if bill["paymentHold"]:
        raise DomainError(
            409,
            "payment_hold",
            f"bill {bill['id']} is on payment hold; release it before paying",
        )

    currency = bill["currency"]
    remaining = bill["amountRemaining"]
    amount = ctx.get("amount")
    amount = _round(float(amount), currency) if amount is not None else remaining
    if amount <= 0:
        raise DomainError(422, "invalid_amount", "payment amount must be positive")
    if amount > remaining:
        raise DomainError(
            422,
            "overpayment",
            f"payment {amount} exceeds the {remaining} remaining on the bill",
        )

    vendor = _vendor(ctx, bill["vendorId"])
    now = base.now()
    bank_account = ctx.get("account") or _bank_account(currency)
    if not bank_account.startswith("ACCT-"):
        bank_account = f"ACCT-{bank_account}"
    bill["amountPaid"] = _round(bill["amountPaid"] + amount, currency)
    bill["amountRemaining"] = _round(remaining - amount, currency)
    fully = bill["amountRemaining"] <= 0
    bill["status"] = "paidInFull" if fully else "partiallyPaid"

    vendor["balancePrimary"] = _round(
        max(0.0, vendor["balancePrimary"] - amount), currency
    )
    if fully:
        vendor["openBillCount"] = max(0, vendor["openBillCount"] - 1)
    _adjust_account(ctx, "ACCT-2000", -amount)
    _adjust_account(ctx, bank_account, -amount)

    payment = {
        "id": base.new_id("payment"),
        "tranId": f"BILLPMT-{now}",
        "type": "vendorPayment",
        "tranDate": _iso(now)[:10],
        "entity": vendor["id"],
        "vendorId": vendor["id"],
        "vendorName": vendor["companyName"],
        "status": "paid",
        "account": bank_account.removeprefix("ACCT-"),
        "apAccount": "2000",
        "currency": currency,
        "exchangeRate": gen._fx_rate(currency),
        "paymentMethod": ctx.get("paymentMethod", vendor["paymentMethod"]),
        "memo": ctx.get(
            "memo", f"Payment to {vendor['companyName']} for {bill['tranId']}"
        ),
        "applied": [{"billId": bill["id"], "tranId": bill["tranId"], "amount": amount}],
        "total": amount,
        "postingPeriod": time.strftime("%b %Y", time.gmtime(now)),
        "createdDate": _iso(now),
    }
    ctx.state.table("payments")[payment["id"]] = payment
    return payment


@base.op(ID, "list_payments")
def list_payments(ctx: Ctx) -> dict:
    """List vendor payments, filterable by vendor or status."""
    ctx.require_scope("erp.read")
    items = list(ctx.state.table("payments").values())
    vendor_id = ctx.get("vendorId")
    if vendor_id:
        items = [p for p in items if p["vendorId"] == vendor_id]
    status = ctx.get("status")
    if status:
        items = [p for p in items if p["status"] == status]
    items.sort(key=lambda p: p["createdDate"], reverse=True)
    return ctx.paginate(items, size_default=20)


@base.op(ID, "get_payment")
def get_payment(ctx: Ctx) -> dict:
    """Retrieve a single vendor payment and the bills it was applied to."""
    ctx.require_scope("erp.read")
    ctx.require("paymentId")
    payment = ctx.state.table("payments").get(ctx.payload["paymentId"])
    if payment is None:
        raise DomainError(404, "payment_not_found", ctx.payload["paymentId"])
    return payment


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
        variance = (
            abs(po["total"] - rec["amount"]) / po["total"] if po["total"] else 0.0
        )
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
    """Post a balanced journal entry to an open period. Debits must equal credits
    and every account must exist in the chart; closed periods are rejected."""
    ctx.require_scope("erp.write")
    lines = ctx.get("lines") or []
    if len(lines) < 2:
        raise DomainError(
            422, "unbalanced_entry", "a journal entry needs at least two lines"
        )
    period = ctx.get("postingPeriod", time.strftime("%b %Y", time.gmtime(base.now())))
    if period in _CLOSED_PERIODS:
        raise DomainError(422, "period_closed", f"posting period {period} is closed")
    accounts = ctx.state.table("accounts")
    debit = credit = 0.0
    normalized = []
    for n, line in enumerate(lines, start=1):
        account = str(line.get("account", ""))
        if account and f"ACCT-{account}" not in accounts and account not in accounts:
            raise DomainError(
                422, "invalid_account", f"account {account} is not in the chart"
            )
        d = float(line.get("debit", 0) or 0)
        c = float(line.get("credit", 0) or 0)
        debit += d
        credit += c
        normalized.append(
            {
                "line": n,
                "account": account,
                "debit": d,
                "credit": c,
                "memo": line.get("memo", ""),
                "department": line.get("department", ""),
                "location": line.get("location", ""),
                "class": line.get("class", ""),
            }
        )
    if round(debit - credit, 2) != 0:
        raise DomainError(
            422, "unbalanced_entry", f"debits {debit} != credits {credit}"
        )
    now = base.now()
    entry = {
        "id": base.new_id("je"),
        "tranId": f"JOURNAL-{now}",
        "type": "journalEntry",
        "tranDate": _iso(now)[:10],
        "subsidiary": ctx.get("subsidiary", "LynxCapital : Consolidated"),
        "currency": ctx.get("currency", "USD"),
        "exchangeRate": gen._fx_rate(ctx.get("currency", "USD")),
        "postingPeriod": period,
        "memo": ctx.get("memo", ""),
        "lines": normalized,
        "totalDebit": round(debit, 2),
        "totalCredit": round(credit, 2),
        "status": "posted",
        "approvalStatus": "approved",
        "createdBy": ctx.get("createdBy", gen._ERP_AP_CLERK),
        "reversalOf": ctx.get("reversalOf"),
        "reversalDate": ctx.get("reversalDate"),
        "createdDate": _iso(now),
    }
    ctx.state.table("journal_entries")[entry["id"]] = entry
    return entry


@base.op(ID, "get_journal_entry")
def get_journal_entry(ctx: Ctx) -> dict:
    """Retrieve a single journal entry with its balanced debit and credit lines."""
    ctx.require_scope("erp.read")
    ctx.require("entryId")
    entry = ctx.state.table("journal_entries").get(ctx.payload["entryId"])
    if entry is None:
        raise DomainError(404, "journal_entry_not_found", ctx.payload["entryId"])
    return entry


@base.op(ID, "list_journal_entries")
def list_journal_entries(ctx: Ctx) -> dict:
    """List journal entries, filterable by posting period or subsidiary."""
    ctx.require_scope("erp.read")
    items = list(ctx.state.table("journal_entries").values())
    period = ctx.get("postingPeriod")
    if period:
        items = [e for e in items if e["postingPeriod"] == period]
    subsidiary = ctx.get("subsidiary")
    if subsidiary:
        items = [e for e in items if e["subsidiary"] == subsidiary]
    items.sort(key=lambda e: e["createdDate"], reverse=True)
    return ctx.paginate(items, size_default=20)


# --------------------------------------------------------------------------- #
# Chart of accounts and AP reporting
# --------------------------------------------------------------------------- #
@base.op(ID, "list_accounts")
def list_accounts(ctx: Ctx) -> dict:
    """List the chart of accounts, filterable by account type."""
    ctx.require_scope("erp.read")
    items = list(ctx.state.table("accounts").values())
    acct_type = ctx.get("acctType")
    if acct_type:
        items = [a for a in items if a["acctType"] == acct_type]
    items.sort(key=lambda a: a["acctNumber"])
    return ctx.paginate(items, size_default=25)


@base.op(ID, "get_account")
def get_account(ctx: Ctx) -> dict:
    """Retrieve a single ledger account by bare or ACCT-prefixed number."""
    ctx.require_scope("erp.read")
    ctx.require("accountId")
    accounts = ctx.state.table("accounts")
    account_id = ctx.payload["accountId"]
    acct = accounts.get(account_id) or accounts.get(f"ACCT-{account_id}")
    if acct is None:
        raise DomainError(404, "account_not_found", account_id)
    return acct


@base.op(ID, "get_ap_aging")
def get_ap_aging(ctx: Ctx) -> dict:
    """Summarize open accounts-payable exposure into standard aging buckets
    (current, 1-30, 31-60, 61-90, 90+ days past due), optionally for one vendor."""
    ctx.require_scope("erp.read")
    vendor_id = ctx.get("vendorId")
    today = base.now()
    buckets = {b: 0.0 for b in _AGING_BUCKETS}
    by_vendor: dict[str, dict] = {}
    for bill in ctx.state.table("bills").values():
        if bill["status"] not in _OPEN_BILL_STATES:
            continue
        if vendor_id and bill["vendorId"] != vendor_id:
            continue
        due_epoch = int(time.mktime(time.strptime(bill["dueDate"][:10], "%Y-%m-%d")))
        days = (today - due_epoch) // 86_400
        if days <= 0:
            bucket = "current"
        elif days <= 30:
            bucket = "1-30"
        elif days <= 60:
            bucket = "31-60"
        elif days <= 90:
            bucket = "61-90"
        else:
            bucket = "90+"
        remaining = bill["amountRemaining"]
        buckets[bucket] = round(buckets[bucket] + remaining, 2)
        slot = by_vendor.setdefault(
            bill["vendorId"],
            {
                "vendorId": bill["vendorId"],
                "vendorName": bill["vendorName"],
                "currency": bill["currency"],
                "openBills": 0,
                "buckets": {b: 0.0 for b in _AGING_BUCKETS},
                "total": 0.0,
            },
        )
        slot["openBills"] += 1
        slot["buckets"][bucket] = round(slot["buckets"][bucket] + remaining, 2)
        slot["total"] = round(slot["total"] + remaining, 2)
    vendors = sorted(by_vendor.values(), key=lambda v: v["total"], reverse=True)
    return {
        "asOf": _iso(today)[:10],
        "buckets": buckets,
        "total": round(sum(buckets.values()), 2),
        "openBillCount": sum(v["openBills"] for v in vendors),
        "vendors": vendors,
    }
