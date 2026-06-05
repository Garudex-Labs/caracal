"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Core Billing domain: internal accounts-receivable invoicing, customer dunning, payment application, and AR aging.
"""
from __future__ import annotations

from _mock.providerlab.data import generators as gen
from _mock.providerlab.providers import base
from _mock.providerlab.providers.base import Ctx, DomainError

ID = "core-billing"


@base.seeder(ID)
def seed(state: base.State) -> None:
    customers = {}
    for i in range(1, 61):
        rng = gen._rng(ID, "cust", i)
        cid = f"CUST-{i:04d}"
        customers[cid] = {"id": cid, "name": gen._company(rng), "terms": rng.choice(("NET15", "NET30", "NET45"))}
    state.tables["customers"] = customers
    cust_ids = list(customers)
    invoices = {}
    for i in range(1, 220):
        rng = gen._rng(ID, "inv", i)
        iid = f"AR-{i:06d}"
        amount = round(rng.uniform(500, 120_000), 2)
        age = rng.choice((-20, -10, 5, 20, 45, 75))
        invoices[iid] = {"id": iid, "customerId": rng.choice(cust_ids), "amount": amount,
                         "paid": 0.0, "status": "open" if age < 0 else "overdue",
                         "daysPastDue": max(0, age)}
    state.tables["invoices"] = invoices
    state.tables["dunning"] = {}
    state.tables["payments"] = {}


@base.op(ID, "create_invoice")
def create_invoice(ctx: Ctx) -> dict:
    ctx.require("customerId", "amount")
    if ctx.payload["customerId"] not in ctx.state.table("customers"):
        raise DomainError(404, "customer_not_found", ctx.payload["customerId"])
    invoices = ctx.state.table("invoices")
    iid = f"AR-{len(invoices) + 1:06d}"
    invoice = {"id": iid, "customerId": ctx.payload["customerId"], "amount": float(ctx.payload["amount"]),
               "paid": 0.0, "status": "open", "daysPastDue": 0}
    invoices[iid] = invoice
    return invoice


@base.op(ID, "get_invoice")
def get_invoice(ctx: Ctx) -> dict:
    ctx.require("invoiceId")
    invoice = ctx.state.table("invoices").get(ctx.payload["invoiceId"])
    if invoice is None:
        raise DomainError(404, "invoice_not_found", ctx.payload["invoiceId"])
    return invoice


@base.op(ID, "issue_dunning")
def issue_dunning(ctx: Ctx) -> dict:
    ctx.require("invoiceId")
    invoice = ctx.state.table("invoices").get(ctx.payload["invoiceId"])
    if invoice is None:
        raise DomainError(404, "invoice_not_found", ctx.payload["invoiceId"])
    if invoice["status"] == "paid":
        raise DomainError(409, "already_paid", "cannot dun a paid invoice")
    notice = {"dunningId": base.new_id("dun"), "invoiceId": invoice["id"],
              "level": min(3, invoice["daysPastDue"] // 30 + 1), "status": "sent"}
    ctx.state.table("dunning")[notice["dunningId"]] = notice
    return notice


@base.op(ID, "apply_payment")
def apply_payment(ctx: Ctx) -> dict:
    ctx.require("invoiceId", "amount")
    invoice = ctx.state.table("invoices").get(ctx.payload["invoiceId"])
    if invoice is None:
        raise DomainError(404, "invoice_not_found", ctx.payload["invoiceId"])
    amount = float(ctx.payload["amount"])
    if amount <= 0:
        raise DomainError(422, "invalid_amount", "payment must be positive")
    invoice["paid"] = round(invoice["paid"] + amount, 2)
    if invoice["paid"] >= invoice["amount"]:
        invoice["status"] = "paid"
    payment = {"paymentId": base.new_id("pmt"), "invoiceId": invoice["id"], "amount": amount,
               "status": "applied", "remaining": round(max(0.0, invoice["amount"] - invoice["paid"]), 2)}
    ctx.state.table("payments")[payment["paymentId"]] = payment
    return payment


@base.op(ID, "get_ar_aging")
def get_ar_aging(ctx: Ctx) -> dict:
    buckets = {"current": 0.0, "1-30": 0.0, "31-60": 0.0, "61-90": 0.0, "90+": 0.0}
    for inv in ctx.state.table("invoices").values():
        if inv["status"] == "paid":
            continue
        outstanding = round(inv["amount"] - inv["paid"], 2)
        d = inv["daysPastDue"]
        if d == 0:
            buckets["current"] += outstanding
        elif d <= 30:
            buckets["1-30"] += outstanding
        elif d <= 60:
            buckets["31-60"] += outstanding
        elif d <= 90:
            buckets["61-90"] += outstanding
        else:
            buckets["90+"] += outstanding
    return {"buckets": {k: round(v, 2) for k, v in buckets.items()},
            "total": round(sum(buckets.values()), 2)}
