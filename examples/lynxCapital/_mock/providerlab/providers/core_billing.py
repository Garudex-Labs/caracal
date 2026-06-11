"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Core Billing domain: LynxCapital's internal accounts-receivable platform for customer invoicing, cash application, AR aging, dunning, and collections.
"""
from __future__ import annotations

from datetime import date, timedelta

from _mock.providerlab.data import generators as gen
from _mock.providerlab.providers import base
from _mock.providerlab.providers.base import Ctx, DomainError

ID = "core-billing"

AS_OF = date(2026, 1, 1)
_OPEN_STATES = ("open", "overdue", "partiallyPaid", "disputed")
_DUNNING_TEMPLATES = ("payment_reminder", "second_notice", "final_notice")


@base.seeder(ID)
def seed(state: base.State) -> None:
    for name, table in gen.core_billing_dataset(ID).items():
        state.tables[name] = table


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _instant_now() -> str:
    return f"{AS_OF.isoformat()}T00:00:00Z"


def _term_days(term: str) -> int:
    return int(str(term).removeprefix("NET")) if str(term).startswith("NET") else 30


def _bucket(days_past_due: int) -> str:
    if days_past_due <= 0:
        return "current"
    if days_past_due <= 30:
        return "1-30"
    if days_past_due <= 60:
        return "31-60"
    if days_past_due <= 90:
        return "61-90"
    return "90+"


def _dunning_level(days_past_due: int) -> int:
    if days_past_due <= 0:
        return 0
    if days_past_due <= 30:
        return 1
    if days_past_due <= 60:
        return 2
    return 3


def _next_seq(ctx: Ctx, counter: str) -> int:
    counters = ctx.state.table("counters")
    row = counters.setdefault(counter, {"value": 0})
    row["value"] += 1
    return row["value"]


def _customer(ctx: Ctx, customer_id: str) -> dict:
    cust = ctx.state.table("customers").get(customer_id)
    if cust is None:
        raise DomainError(404, "customer_not_found", str(customer_id))
    return cust


def _invoice(ctx: Ctx, invoice_id: str) -> dict:
    inv = ctx.state.table("invoices").get(invoice_id)
    if inv is None:
        raise DomainError(404, "invoice_not_found", str(invoice_id))
    return inv


def _reage(inv: dict) -> dict:
    """Recompute an invoice's age, bucket, and overdue flag against the as-of date."""
    if inv["status"] in ("paid", "void", "draft", "writtenOff"):
        inv["daysPastDue"] = 0
        inv["agingBucket"] = "current"
        return inv
    due = date.fromisoformat(inv["dueDate"])
    days = max(0, (AS_OF - due).days)
    inv["daysPastDue"] = days
    inv["agingBucket"] = _bucket(days)
    if inv["status"] == "open" and days > 0:
        inv["status"] = "overdue"
    return inv


def _customer_invoices(ctx: Ctx, customer_id: str) -> list[dict]:
    return [_reage(inv) for inv in ctx.state.table("invoices").values()
            if inv["customerId"] == customer_id]


def _roll_customer(ctx: Ctx, customer_id: str) -> dict:
    cust = _customer(ctx, customer_id)
    ar = overdue = 0.0
    worst = 0
    for inv in _customer_invoices(ctx, customer_id):
        if inv["status"] in ("paid", "void", "draft", "writtenOff"):
            continue
        ar += inv["amountDue"]
        if inv["daysPastDue"] > 0:
            overdue += inv["amountDue"]
            worst = max(worst, inv["daysPastDue"])
    cust["arBalance"] = round(ar, 2)
    cust["overdueBalance"] = round(overdue, 2)
    if worst > 60:
        cust["collectionsStatus"] = "in_collections"
    elif worst > 30:
        cust["collectionsStatus"] = "past_due"
    elif worst > 0:
        cust["collectionsStatus"] = "watch"
    else:
        cust["collectionsStatus"] = "current"
    cust["creditHold"] = cust["overdueBalance"] > cust["creditLimit"]
    return cust


def _audit(ctx: Ctx, action: str, entity_type: str, entity_id: str, details: dict) -> dict:
    seq = _next_seq(ctx, "auditNo")
    actor = ctx.principal.get("principal") or "api-token@core-billing.lynxcapital.test"
    event = {
        "eventId": f"AUD-{seq:06d}",
        "at": _instant_now(),
        "actor": str(actor),
        "action": action,
        "entityType": entity_type,
        "entityId": entity_id,
        "details": details,
    }
    ctx.state.table("auditEvents")[event["eventId"]] = event
    return event


def _settle_invoice(inv: dict, amount: float) -> float:
    """Apply up to `amount` against an invoice's open balance, returning the amount used."""
    applied = min(amount, inv["amountDue"])
    inv["amountPaid"] = round(inv["amountPaid"] + applied, 2)
    inv["amountDue"] = round(inv["total"] - inv["amountPaid"], 2)
    if inv["amountDue"] <= 0.005:
        inv["amountDue"] = 0.0
        inv["status"] = "paid"
    elif inv["status"] in ("open", "overdue"):
        inv["status"] = "partiallyPaid"
    inv["updatedAt"] = _instant_now()
    _reage(inv)
    return round(applied, 2)


# --------------------------------------------------------------------------- #
# Customer master
# --------------------------------------------------------------------------- #
@base.op(ID, "list_customers")
def list_customers(ctx: Ctx) -> dict:
    items = list(ctx.state.table("customers").values())
    for field in ("segment", "status", "collectionsStatus"):
        value = ctx.get(field)
        if value:
            items = [c for c in items if c[field] == value]
    if ctx.get("creditHold") is not None:
        want = bool(ctx.get("creditHold"))
        items = [c for c in items if c["creditHold"] == want]
    items.sort(key=lambda c: c["customerId"])
    return ctx.paginate(items, size_default=25)


@base.op(ID, "get_customer")
def get_customer(ctx: Ctx) -> dict:
    ctx.require("customerId")
    cust = _roll_customer(ctx, ctx.payload["customerId"])
    invoices = _customer_invoices(ctx, cust["customerId"])
    open_invoices = [i for i in invoices if i["status"] in _OPEN_STATES]
    oldest = min((i["dueDate"] for i in open_invoices), default=None)
    buckets = {"current": 0.0, "1-30": 0.0, "31-60": 0.0, "61-90": 0.0, "90+": 0.0}
    for inv in open_invoices:
        buckets[inv["agingBucket"]] = round(buckets[inv["agingBucket"]] + inv["amountDue"], 2)
    return {
        **cust,
        "arSummary": {
            "openInvoices": len(open_invoices),
            "oldestDueDate": oldest,
            "availableCredit": round(cust["creditLimit"] - cust["arBalance"], 2),
            "aging": buckets,
        },
    }


# --------------------------------------------------------------------------- #
# Invoice lifecycle
# --------------------------------------------------------------------------- #
@base.op(ID, "create_invoice")
def create_invoice(ctx: Ctx) -> dict:
    ctx.require("customerId")
    cust = _customer(ctx, ctx.payload["customerId"])
    if cust["status"] != "active":
        raise DomainError(409, "customer_inactive", f"{cust['customerId']} is not active")
    if cust["creditHold"]:
        raise DomainError(409, "credit_hold",
                          f"{cust['customerId']} is on credit hold; clear overdue balance to bill")

    lines = ctx.get("lineItems")
    if not lines:
        if ctx.get("amount") in (None, ""):
            raise DomainError(422, "invalid_request", "provide either lineItems or amount")
        lines = [{"lineNo": 1, "sku": ctx.get("sku", "MISC"),
                  "description": ctx.get("description", "Billed charges"),
                  "quantity": 1, "unitPrice": round(float(ctx.payload["amount"]), 2),
                  "amount": round(float(ctx.payload["amount"]), 2)}]
    else:
        for n, line in enumerate(lines, start=1):
            line.setdefault("lineNo", n)
            line["amount"] = round(float(line.get("amount",
                                    float(line.get("quantity", 1)) * float(line.get("unitPrice", 0)))), 2)

    subtotal = round(sum(l["amount"] for l in lines), 2)
    tax_rate = float(ctx.get("taxRate", gen._CB_TAX_RATE.get(cust["country"], 0.0)))
    tax_amount = round(subtotal * tax_rate, 2)
    total = round(subtotal + tax_amount, 2)
    terms = ctx.get("terms", cust["paymentTerms"])
    issue = AS_OF
    due = issue + timedelta(days=_term_days(terms))
    seq = _next_seq(ctx, "invoiceNo")
    invoice = {
        "invoiceId": f"INV-2026-{seq:06d}",
        "customerId": cust["customerId"],
        "customerName": cust["name"],
        "status": ctx.get("status", "open"),
        "currency": cust["currency"],
        "terms": terms,
        "issueDate": issue.isoformat(),
        "dueDate": due.isoformat(),
        "poNumber": ctx.get("poNumber"),
        "lineItems": lines,
        "subtotal": subtotal,
        "taxRate": tax_rate,
        "taxAmount": tax_amount,
        "total": total,
        "amountPaid": 0.0,
        "amountDue": total,
        "daysPastDue": 0,
        "agingBucket": "current",
        "dunningLevel": 0,
        "lastDunnedAt": None,
        "memo": ctx.get("memo", ""),
        "createdBy": str(ctx.principal.get("principal") or "api-token@core-billing.lynxcapital.test"),
        "createdAt": _instant_now(),
        "updatedAt": _instant_now(),
    }
    if invoice["status"] == "draft":
        invoice["amountDue"] = 0.0
    ctx.state.table("invoices")[invoice["invoiceId"]] = invoice
    _audit(ctx, "invoice.issued", "invoice", invoice["invoiceId"],
           {"customerId": cust["customerId"], "total": total, "currency": invoice["currency"]})
    _roll_customer(ctx, cust["customerId"])
    return invoice


@base.op(ID, "get_invoice")
def get_invoice(ctx: Ctx) -> dict:
    ctx.require("invoiceId")
    return _reage(_invoice(ctx, ctx.payload["invoiceId"]))


@base.op(ID, "list_invoices")
def list_invoices(ctx: Ctx) -> dict:
    items = [_reage(inv) for inv in ctx.state.table("invoices").values()]
    if ctx.get("customerId"):
        items = [i for i in items if i["customerId"] == ctx.payload["customerId"]]
    if ctx.get("status"):
        items = [i for i in items if i["status"] == ctx.payload["status"]]
    if ctx.get("bucket"):
        items = [i for i in items if i["agingBucket"] == ctx.payload["bucket"]]
    if ctx.get("overdue") is not None and bool(ctx.get("overdue")):
        items = [i for i in items if i["daysPastDue"] > 0 and i["status"] in _OPEN_STATES]
    items.sort(key=lambda i: i["invoiceId"], reverse=True)
    return ctx.paginate(items, size_default=25)


@base.op(ID, "void_invoice")
def void_invoice(ctx: Ctx) -> dict:
    ctx.require("invoiceId")
    inv = _invoice(ctx, ctx.payload["invoiceId"])
    if inv["status"] in ("paid", "void", "writtenOff"):
        raise DomainError(409, "invalid_state", f"cannot void a {inv['status']} invoice")
    if inv["amountPaid"] > 0:
        raise DomainError(409, "payment_exists", "void is not allowed once cash is applied; issue a credit memo")
    inv["status"] = "void"
    inv["amountDue"] = 0.0
    inv["updatedAt"] = _instant_now()
    _audit(ctx, "invoice.voided", "invoice", inv["invoiceId"],
           {"reason": ctx.get("reason", "unspecified")})
    _roll_customer(ctx, inv["customerId"])
    return inv


@base.op(ID, "write_off_invoice")
def write_off_invoice(ctx: Ctx) -> dict:
    ctx.require("invoiceId")
    inv = _reage(_invoice(ctx, ctx.payload["invoiceId"]))
    if inv["status"] in ("paid", "void", "writtenOff", "draft"):
        raise DomainError(409, "invalid_state", f"cannot write off a {inv['status']} invoice")
    written = inv["amountDue"]
    inv["status"] = "writtenOff"
    inv["writeOffAmount"] = written
    inv["writeOffReason"] = ctx.get("reason", "bad_debt")
    inv["amountDue"] = 0.0
    inv["updatedAt"] = _instant_now()
    _audit(ctx, "invoice.written_off", "invoice", inv["invoiceId"],
           {"amount": written, "reason": inv["writeOffReason"]})
    _roll_customer(ctx, inv["customerId"])
    return inv


@base.op(ID, "dispute_invoice")
def dispute_invoice(ctx: Ctx) -> dict:
    ctx.require("invoiceId", "reason")
    inv = _reage(_invoice(ctx, ctx.payload["invoiceId"]))
    if inv["status"] in ("paid", "void", "writtenOff"):
        raise DomainError(409, "invalid_state", f"cannot dispute a {inv['status']} invoice")
    inv["status"] = "disputed"
    inv["disputeReason"] = ctx.payload["reason"]
    inv["disputedAt"] = _instant_now()
    inv["updatedAt"] = _instant_now()
    _audit(ctx, "invoice.disputed", "invoice", inv["invoiceId"], {"reason": inv["disputeReason"]})
    _roll_customer(ctx, inv["customerId"])
    return inv


# --------------------------------------------------------------------------- #
# Cash application
# --------------------------------------------------------------------------- #
def _record_payment(ctx: Ctx, customer_id: str, amount: float, allocations: list[dict],
                    method: str, reference: str | None) -> dict:
    applied = round(sum(a["amount"] for a in allocations), 2)
    unapplied = round(amount - applied, 2)
    cust = _customer(ctx, customer_id)
    if unapplied > 0:
        cust["unappliedCredit"] = round(cust.get("unappliedCredit", 0.0) + unapplied, 2)
    seq = _next_seq(ctx, "paymentNo")
    pid = f"PMT-2026-{seq:06d}"
    status = "applied" if unapplied <= 0.005 else ("partially_applied" if applied > 0 else "unapplied")
    payment = {
        "paymentId": pid,
        "customerId": customer_id,
        "customerName": cust["name"],
        "currency": cust["currency"],
        "amount": round(amount, 2),
        "method": method,
        "reference": reference or f"{method.upper()}-{seq:06d}",
        "receivedDate": ctx.get("receivedDate", AS_OF.isoformat()),
        "appliedAmount": applied,
        "unappliedAmount": max(0.0, unapplied),
        "status": status,
        "allocations": allocations,
        "createdAt": _instant_now(),
    }
    ctx.state.table("payments")[pid] = payment
    _audit(ctx, "payment.applied", "payment", pid,
           {"customerId": customer_id, "amount": payment["amount"], "applied": applied,
            "unapplied": payment["unappliedAmount"]})
    _roll_customer(ctx, customer_id)
    return payment


@base.op(ID, "apply_payment")
def apply_payment(ctx: Ctx) -> dict:
    ctx.require("invoiceId", "amount")
    inv = _reage(_invoice(ctx, ctx.payload["invoiceId"]))
    if inv["status"] in ("paid", "void", "writtenOff"):
        raise DomainError(409, "invalid_state", f"cannot apply payment to a {inv['status']} invoice")
    amount = round(float(ctx.payload["amount"]), 2)
    if amount <= 0:
        raise DomainError(422, "invalid_amount", "payment must be positive")
    applied = _settle_invoice(inv, amount)
    payment = _record_payment(
        ctx, inv["customerId"], amount,
        [{"invoiceId": inv["invoiceId"], "amount": applied, "appliedAt": _instant_now()}],
        ctx.get("method", "ach"), ctx.get("reference"))
    return {
        "paymentId": payment["paymentId"],
        "invoiceId": inv["invoiceId"],
        "amount": amount,
        "applied": applied,
        "unapplied": payment["unappliedAmount"],
        "status": "applied",
        "invoiceStatus": inv["status"],
        "remaining": inv["amountDue"],
    }


@base.op(ID, "record_payment")
def record_payment(ctx: Ctx) -> dict:
    """Record a customer remittance and apply it across invoices. Explicit
    allocations are honored; otherwise cash is applied oldest-invoice-first the
    way an AR clerk clears the aging."""
    ctx.require("customerId", "amount")
    cust = _customer(ctx, ctx.payload["customerId"])
    amount = round(float(ctx.payload["amount"]), 2)
    if amount <= 0:
        raise DomainError(422, "invalid_amount", "payment must be positive")
    method = ctx.get("method", "ach")
    reference = ctx.get("reference")
    allocations: list[dict] = []
    remaining = amount

    requested = ctx.get("allocations")
    if requested:
        for alloc in requested:
            inv = _reage(_invoice(ctx, alloc["invoiceId"]))
            if inv["customerId"] != cust["customerId"]:
                raise DomainError(422, "invoice_customer_mismatch",
                                  f"{inv['invoiceId']} does not belong to {cust['customerId']}")
            want = round(min(float(alloc.get("amount", inv["amountDue"])), remaining), 2)
            used = _settle_invoice(inv, want)
            if used > 0:
                allocations.append({"invoiceId": inv["invoiceId"], "amount": used,
                                    "appliedAt": _instant_now()})
                remaining = round(remaining - used, 2)
    else:
        open_invoices = sorted(
            (i for i in _customer_invoices(ctx, cust["customerId"])
             if i["status"] in ("open", "overdue", "partiallyPaid")),
            key=lambda i: i["dueDate"])
        for inv in open_invoices:
            if remaining <= 0.005:
                break
            used = _settle_invoice(inv, remaining)
            if used > 0:
                allocations.append({"invoiceId": inv["invoiceId"], "amount": used,
                                    "appliedAt": _instant_now()})
                remaining = round(remaining - used, 2)

    return _record_payment(ctx, cust["customerId"], amount, allocations, method, reference)


@base.op(ID, "get_payment")
def get_payment(ctx: Ctx) -> dict:
    ctx.require("paymentId")
    payment = ctx.state.table("payments").get(ctx.payload["paymentId"])
    if payment is None:
        raise DomainError(404, "payment_not_found", ctx.payload["paymentId"])
    return payment


@base.op(ID, "list_payments")
def list_payments(ctx: Ctx) -> dict:
    items = list(ctx.state.table("payments").values())
    if ctx.get("customerId"):
        items = [p for p in items if p["customerId"] == ctx.payload["customerId"]]
    if ctx.get("status"):
        items = [p for p in items if p["status"] == ctx.payload["status"]]
    items.sort(key=lambda p: p["paymentId"], reverse=True)
    return ctx.paginate(items, size_default=25)


# --------------------------------------------------------------------------- #
# Credit memos
# --------------------------------------------------------------------------- #
@base.op(ID, "issue_credit_memo")
def issue_credit_memo(ctx: Ctx) -> dict:
    ctx.require("customerId", "amount", "reason")
    cust = _customer(ctx, ctx.payload["customerId"])
    amount = round(float(ctx.payload["amount"]), 2)
    if amount <= 0:
        raise DomainError(422, "invalid_amount", "credit memo must be positive")
    seq = _next_seq(ctx, "creditMemoNo")
    cmid = f"CM-2026-{seq:04d}"
    memo = {
        "creditMemoId": cmid,
        "customerId": cust["customerId"],
        "currency": cust["currency"],
        "amount": amount,
        "appliedAmount": 0.0,
        "remainingAmount": amount,
        "reason": ctx.payload["reason"],
        "status": "open",
        "issueDate": AS_OF.isoformat(),
    }
    ctx.state.table("creditMemos")[cmid] = memo
    _audit(ctx, "credit_memo.issued", "creditMemo", cmid,
           {"customerId": cust["customerId"], "amount": amount, "reason": memo["reason"]})
    return memo


@base.op(ID, "apply_credit_memo")
def apply_credit_memo(ctx: Ctx) -> dict:
    ctx.require("creditMemoId", "invoiceId")
    memo = ctx.state.table("creditMemos").get(ctx.payload["creditMemoId"])
    if memo is None:
        raise DomainError(404, "credit_memo_not_found", ctx.payload["creditMemoId"])
    if memo["status"] == "applied" or memo["remainingAmount"] <= 0:
        raise DomainError(409, "credit_exhausted", "credit memo has no remaining balance")
    inv = _reage(_invoice(ctx, ctx.payload["invoiceId"]))
    if inv["customerId"] != memo["customerId"]:
        raise DomainError(422, "invoice_customer_mismatch", "credit memo and invoice differ in customer")
    if inv["status"] in ("paid", "void", "writtenOff"):
        raise DomainError(409, "invalid_state", f"cannot credit a {inv['status']} invoice")
    used = _settle_invoice(inv, min(memo["remainingAmount"], inv["amountDue"]))
    memo["appliedAmount"] = round(memo["appliedAmount"] + used, 2)
    memo["remainingAmount"] = round(memo["amount"] - memo["appliedAmount"], 2)
    memo["status"] = "applied" if memo["remainingAmount"] <= 0.005 else "partially_applied"
    _audit(ctx, "credit_memo.applied", "creditMemo", memo["creditMemoId"],
           {"invoiceId": inv["invoiceId"], "amount": used})
    _roll_customer(ctx, inv["customerId"])
    return {"creditMemo": memo, "invoice": inv, "applied": used}


# --------------------------------------------------------------------------- #
# Dunning
# --------------------------------------------------------------------------- #
def _send_dunning(ctx: Ctx, inv: dict) -> dict:
    level = max(inv.get("dunningLevel", 0), _dunning_level(inv["daysPastDue"]))
    level = max(1, min(3, level))
    seq = _next_seq(ctx, "dunningNo")
    did = f"DUN-2026-{seq:06d}"
    notice = {
        "dunningId": did,
        "invoiceId": inv["invoiceId"],
        "customerId": inv["customerId"],
        "level": level,
        "channel": ctx.get("channel", "email"),
        "template": _DUNNING_TEMPLATES[level - 1],
        "status": "sent",
        "amountDue": inv["amountDue"],
        "sentAt": _instant_now(),
        "nextActionDate": (AS_OF + timedelta(days=14)).isoformat(),
    }
    ctx.state.table("dunning")[did] = notice
    inv["dunningLevel"] = level
    inv["lastDunnedAt"] = notice["sentAt"]
    inv["updatedAt"] = _instant_now()
    _audit(ctx, "dunning.sent", "dunning", did,
           {"invoiceId": inv["invoiceId"], "level": level, "customerId": inv["customerId"]})
    return notice


@base.op(ID, "issue_dunning")
def issue_dunning(ctx: Ctx) -> dict:
    ctx.require("invoiceId")
    inv = _reage(_invoice(ctx, ctx.payload["invoiceId"]))
    if inv["status"] == "paid":
        raise DomainError(409, "already_paid", "cannot dun a paid invoice")
    if inv["status"] in ("void", "writtenOff", "draft"):
        raise DomainError(409, "invalid_state", f"cannot dun a {inv['status']} invoice")
    if inv["status"] == "disputed":
        raise DomainError(409, "invoice_disputed", "resolve the dispute before dunning")
    return _send_dunning(ctx, inv)


@base.op(ID, "run_dunning_cycle")
def run_dunning_cycle(ctx: Ctx) -> dict:
    """Sweep overdue receivables and escalate dunning by policy, returning the
    batch of notices the collections workflow would send."""
    min_dpd = int(ctx.get("minDaysPastDue", 1))
    customer_id = ctx.get("customerId")
    notices: list[dict] = []
    by_level = {1: 0, 2: 0, 3: 0}
    for inv in ctx.state.table("invoices").values():
        _reage(inv)
        if customer_id and inv["customerId"] != customer_id:
            continue
        if inv["status"] not in ("overdue", "partiallyPaid") or inv["daysPastDue"] < min_dpd:
            continue
        target = _dunning_level(inv["daysPastDue"])
        if target <= inv.get("dunningLevel", 0):
            continue
        notice = _send_dunning(ctx, inv)
        notices.append(notice)
        by_level[notice["level"]] += 1
    return {"sent": len(notices), "byLevel": by_level, "notices": notices}


@base.op(ID, "list_dunning")
def list_dunning(ctx: Ctx) -> dict:
    items = list(ctx.state.table("dunning").values())
    if ctx.get("customerId"):
        items = [d for d in items if d["customerId"] == ctx.payload["customerId"]]
    if ctx.get("invoiceId"):
        items = [d for d in items if d["invoiceId"] == ctx.payload["invoiceId"]]
    if ctx.get("level"):
        items = [d for d in items if d["level"] == int(ctx.payload["level"])]
    items.sort(key=lambda d: d["dunningId"], reverse=True)
    return ctx.paginate(items, size_default=25)


# --------------------------------------------------------------------------- #
# Collections
# --------------------------------------------------------------------------- #
@base.op(ID, "open_collection_case")
def open_collection_case(ctx: Ctx) -> dict:
    ctx.require("customerId")
    cust = _roll_customer(ctx, ctx.payload["customerId"])
    threshold = int(ctx.get("minDaysPastDue", 60))
    case_invoices = [i["invoiceId"] for i in _customer_invoices(ctx, cust["customerId"])
                     if i["daysPastDue"] >= threshold and i["status"] in _OPEN_STATES]
    if not case_invoices:
        raise DomainError(409, "no_qualifying_invoices",
                          f"{cust['customerId']} has no invoices past {threshold} days")
    seq = _next_seq(ctx, "collectionNo")
    cid = f"COL-2026-{seq:04d}"
    case = {
        "caseId": cid,
        "customerId": cust["customerId"],
        "customerName": cust["name"],
        "status": "open",
        "priority": "high" if cust["overdueBalance"] > 100_000 else "medium",
        "assignedTo": ctx.get("assignedTo", cust["collectionsOwner"]),
        "invoiceIds": case_invoices,
        "totalOutstanding": round(sum(_invoice(ctx, i)["amountDue"] for i in case_invoices), 2),
        "openedDate": AS_OF.isoformat(),
        "promiseToPayDate": ctx.get("promiseToPayDate"),
        "notes": [],
    }
    ctx.state.table("collections")[cid] = case
    cust["collectionsStatus"] = "in_collections"
    _audit(ctx, "collection.opened", "collection", cid,
           {"customerId": cust["customerId"], "outstanding": case["totalOutstanding"]})
    return case


@base.op(ID, "list_collections")
def list_collections(ctx: Ctx) -> dict:
    items = list(ctx.state.table("collections").values())
    if ctx.get("customerId"):
        items = [c for c in items if c["customerId"] == ctx.payload["customerId"]]
    if ctx.get("status"):
        items = [c for c in items if c["status"] == ctx.payload["status"]]
    items.sort(key=lambda c: c["totalOutstanding"], reverse=True)
    return ctx.paginate(items, size_default=25)


# --------------------------------------------------------------------------- #
# Aging and reporting
# --------------------------------------------------------------------------- #
def _aging(ctx: Ctx, customer_id: str | None) -> dict:
    buckets = {"current": 0.0, "1-30": 0.0, "31-60": 0.0, "61-90": 0.0, "90+": 0.0}
    counts = {k: 0 for k in buckets}
    for inv in ctx.state.table("invoices").values():
        if customer_id and inv["customerId"] != customer_id:
            continue
        _reage(inv)
        if inv["status"] not in _OPEN_STATES or inv["amountDue"] <= 0:
            continue
        buckets[inv["agingBucket"]] = round(buckets[inv["agingBucket"]] + inv["amountDue"], 2)
        counts[inv["agingBucket"]] += 1
    return {
        "asOf": AS_OF.isoformat(),
        "customerId": customer_id,
        "buckets": buckets,
        "counts": counts,
        "total": round(sum(buckets.values()), 2),
    }


@base.op(ID, "get_ar_aging")
def get_ar_aging(ctx: Ctx) -> dict:
    return _aging(ctx, ctx.get("customerId"))


@base.op(ID, "get_ar_summary")
def get_ar_summary(ctx: Ctx) -> dict:
    """Receivables management dashboard: total and overdue AR, DSO, write-offs,
    disputes, credit holds, and open collection cases — the month-end figures
    the AR controller reports."""
    invoices = list(ctx.state.table("invoices").values())
    for inv in invoices:
        _reage(inv)
    aging = _aging(ctx, None)
    total_ar = aging["total"]
    overdue = round(aging["total"] - aging["buckets"]["current"], 2)
    sales_90 = round(sum(
        i["total"] for i in invoices
        if i["status"] not in ("void", "draft")
        and (AS_OF - date.fromisoformat(i["issueDate"])).days <= 90), 2)
    dso = round(total_ar / sales_90 * 90, 1) if sales_90 else 0.0
    by_status: dict[str, int] = {}
    for inv in invoices:
        by_status[inv["status"]] = by_status.get(inv["status"], 0) + 1
    written_off = round(sum(i.get("writeOffAmount", 0.0) for i in invoices if i["status"] == "writtenOff"), 2)
    disputed = round(sum(i["amountDue"] for i in invoices if i["status"] == "disputed"), 2)
    customers = list(ctx.state.table("customers").values())
    return {
        "asOf": AS_OF.isoformat(),
        "totalReceivable": total_ar,
        "currentReceivable": aging["buckets"]["current"],
        "overdueReceivable": overdue,
        "overduePct": round(overdue / total_ar * 100, 1) if total_ar else 0.0,
        "daysSalesOutstanding": dso,
        "aging": aging["buckets"],
        "agingCounts": aging["counts"],
        "invoicesByStatus": by_status,
        "disputedAmount": disputed,
        "writtenOffAmount": written_off,
        "customersOnCreditHold": sum(1 for c in customers if c["creditHold"]),
        "customersInCollections": sum(1 for c in customers if c["collectionsStatus"] == "in_collections"),
        "openCollectionCases": sum(1 for c in ctx.state.table("collections").values()
                                   if c["status"] != "resolved"),
    }


@base.op(ID, "get_audit_trail")
def get_audit_trail(ctx: Ctx) -> dict:
    items = list(ctx.state.table("auditEvents").values())
    if ctx.get("entityType"):
        items = [e for e in items if e["entityType"] == ctx.payload["entityType"]]
    if ctx.get("entityId"):
        items = [e for e in items if e["entityId"] == ctx.payload["entityId"]]
    if ctx.get("action"):
        items = [e for e in items if e["action"] == ctx.payload["action"]]
    items.sort(key=lambda e: e["eventId"], reverse=True)
    return ctx.paginate(items, size_default=50)
