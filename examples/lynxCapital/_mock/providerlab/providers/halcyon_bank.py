"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Halcyon Bank domain: open-banking accounts, transactions, payment initiation, and statements.
"""
from __future__ import annotations

from _mock.providerlab.data import generators as gen
from _mock.providerlab.providers import base
from _mock.providerlab.providers.base import Ctx, DomainError

ID = "halcyon-bank"


@base.seeder(ID)
def seed(state: base.State) -> None:
    accts = gen.accounts(ID, 6)
    state.tables["accounts"] = gen.index_by(accts)
    txns = gen.transactions(ID, [a["id"] for a in accts], 400)
    state.tables["transactions"] = gen.index_by(txns)
    state.tables["payments"] = {}


@base.op(ID, "list_accounts")
def list_accounts(ctx: Ctx) -> dict:
    ctx.require_scope("accounts.read")
    return ctx.paginate(list(ctx.state.table("accounts").values()), size_default=10)


@base.op(ID, "get_account")
def get_account(ctx: Ctx) -> dict:
    ctx.require_scope("accounts.read")
    ctx.require("accountId")
    acct = ctx.state.table("accounts").get(ctx.payload["accountId"])
    if acct is None:
        raise DomainError(404, "account_not_found", ctx.payload["accountId"])
    return acct


@base.op(ID, "list_transactions")
def list_transactions(ctx: Ctx) -> dict:
    ctx.require_scope("accounts.read")
    txns = list(ctx.state.table("transactions").values())
    account_id = ctx.get("accountId")
    if account_id:
        txns = [t for t in txns if t["accountId"] == account_id]
    return ctx.paginate(sorted(txns, key=lambda t: t["postedAt"], reverse=True))


@base.op(ID, "initiate_payment")
def initiate_payment(ctx: Ctx) -> dict:
    ctx.require_scope("payments.write")
    ctx.require("fromAccount", "amount", "creditor")
    acct = ctx.state.table("accounts").get(ctx.payload["fromAccount"])
    if acct is None:
        raise DomainError(404, "account_not_found", ctx.payload["fromAccount"])
    amount = float(ctx.payload["amount"])
    if amount <= 0:
        raise DomainError(422, "invalid_amount", "amount must be positive")
    if amount > acct["available"]:
        raise DomainError(402, "insufficient_funds", "amount exceeds available balance")
    idem = ctx.get("idempotencyKey")
    payments = ctx.state.table("payments")
    if idem and idem in payments:
        return payments[idem]
    acct["available"] = round(acct["available"] - amount, 2)
    payment = {
        "paymentId": base.new_id("pmt"),
        "status": "pending_authorization",
        "fromAccount": acct["id"],
        "amount": amount,
        "currency": acct["currency"],
        "creditor": ctx.payload["creditor"],
        "createdAt": base.now(),
    }
    payments[payment["paymentId"]] = payment
    if idem:
        payments[idem] = payment
    return payment


@base.op(ID, "get_payment")
def get_payment(ctx: Ctx) -> dict:
    ctx.require_scope("accounts.read")
    ctx.require("paymentId")
    payment = ctx.state.table("payments").get(ctx.payload["paymentId"])
    if payment is None:
        raise DomainError(404, "payment_not_found", ctx.payload["paymentId"])
    if payment["status"] == "pending_authorization":
        payment["status"] = "settled"
    return payment


@base.op(ID, "get_statement")
def get_statement(ctx: Ctx) -> dict:
    ctx.require_scope("accounts.read")
    ctx.require("accountId")
    txns = [t for t in ctx.state.table("transactions").values()
            if t["accountId"] == ctx.payload["accountId"]]
    debits = round(sum(t["amount"] for t in txns if t["type"] == "debit"), 2)
    credits = round(sum(t["amount"] for t in txns if t["type"] == "credit"), 2)
    return {"accountId": ctx.payload["accountId"], "transactions": len(txns),
            "debits": debits, "credits": credits, "net": round(credits - debits, 2)}
