"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Ironbark ERP domain: enterprise vendors, bills, asynchronous invoice matching, journal entries, and accounts.
"""
from __future__ import annotations

from _mock.providerlab.data import generators as gen
from _mock.providerlab.providers import base
from _mock.providerlab.providers.base import Ctx, DomainError

ID = "ironbark-erp"


@base.seeder(ID)
def seed(state: base.State) -> None:
    vendors = gen.vendors(ID, 240)
    state.tables["vendors"] = gen.index_by(vendors)
    state.tables["bills"] = {}
    state.tables["journal_entries"] = {}
    accts = gen.accounts(ID, 12)
    state.tables["accounts"] = gen.index_by(accts)
    state.tables["matches"] = {}


@base.op(ID, "list_vendors")
def list_vendors(ctx: Ctx) -> dict:
    ctx.require_scope("erp.read")
    items = list(ctx.state.table("vendors").values())
    query = str(ctx.get("query", "")).lower()
    if query:
        items = [v for v in items if query in v["name"].lower()]
    return ctx.paginate(items, size_default=20)


@base.op(ID, "get_vendor")
def get_vendor(ctx: Ctx) -> dict:
    ctx.require_scope("erp.read")
    ctx.require("vendorId")
    vendor = ctx.state.table("vendors").get(ctx.payload["vendorId"])
    if vendor is None:
        raise DomainError(404, "vendor_not_found", ctx.payload["vendorId"])
    return vendor


@base.op(ID, "create_bill")
def create_bill(ctx: Ctx) -> dict:
    ctx.require_scope("erp.write")
    ctx.require("vendorId", "amount", "currency")
    if ctx.payload["vendorId"] not in ctx.state.table("vendors"):
        raise DomainError(404, "vendor_not_found", ctx.payload["vendorId"])
    amount = float(ctx.payload["amount"])
    if amount <= 0:
        raise DomainError(422, "invalid_amount", "bill amount must be positive")
    bill = {"billId": base.new_id("bill"), "status": "open", "vendorId": ctx.payload["vendorId"],
            "amount": amount, "currency": ctx.payload["currency"]}
    ctx.state.table("bills")[bill["billId"]] = bill
    return bill


@base.op(ID, "get_bill")
def get_bill(ctx: Ctx) -> dict:
    ctx.require_scope("erp.read")
    ctx.require("billId")
    bill = ctx.state.table("bills").get(ctx.payload["billId"])
    if bill is None:
        raise DomainError(404, "bill_not_found", ctx.payload["billId"])
    return bill


@base.op(ID, "match_invoice")
def match_invoice(ctx: Ctx) -> dict:
    """Three-way match runs asynchronously: first call queues, later calls report completion."""
    ctx.require_scope("erp.write")
    ctx.require("invoiceId", "vendorId", "amount")
    matches = ctx.state.table("matches")
    key = str(ctx.payload["invoiceId"])
    if key not in matches:
        matches[key] = {"invoiceId": key, "vendorId": ctx.payload["vendorId"],
                        "amount": float(ctx.payload["amount"]), "status": "processing",
                        "jobId": base.new_id("job")}
        return matches[key]
    rec = matches[key]
    if ctx.payload["vendorId"] not in ctx.state.table("vendors"):
        rec["status"] = "exception"
        rec["reason"] = "vendor_not_found"
    else:
        rec["status"] = "matched"
        rec["confidence"] = 0.98
    return rec


@base.op(ID, "post_journal_entry")
def post_journal_entry(ctx: Ctx) -> dict:
    ctx.require_scope("erp.write")
    lines = ctx.get("lines") or []
    if len(lines) < 2:
        raise DomainError(422, "unbalanced_entry", "a journal entry needs at least two lines")
    debit = sum(float(l.get("debit", 0)) for l in lines)
    credit = sum(float(l.get("credit", 0)) for l in lines)
    if round(debit - credit, 2) != 0:
        raise DomainError(422, "unbalanced_entry", f"debits {debit} != credits {credit}")
    entry = {"entryId": base.new_id("je"), "posted": True, "debit": debit, "credit": credit}
    ctx.state.table("journal_entries")[entry["entryId"]] = entry
    return entry


@base.op(ID, "get_account")
def get_account(ctx: Ctx) -> dict:
    ctx.require_scope("erp.read")
    ctx.require("accountId")
    acct = ctx.state.table("accounts").get(ctx.payload["accountId"])
    if acct is None:
        raise DomainError(404, "account_not_found", ctx.payload["accountId"])
    return acct
