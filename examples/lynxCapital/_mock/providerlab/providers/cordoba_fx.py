"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Cordoba FX domain: cross-border foreign-exchange quotes, scope-gated conversions, and settled transfers.
"""
from __future__ import annotations

from _mock.providerlab.providers import base
from _mock.providerlab.providers.base import Ctx, DomainError

ID = "cordoba-fx"

_RATES = {
    "USD:EUR": 0.92, "EUR:USD": 1.09, "USD:GBP": 0.79, "GBP:USD": 1.27,
    "USD:JPY": 156.4, "JPY:USD": 0.0064, "USD:BRL": 5.08, "BRL:USD": 0.197,
    "USD:SGD": 1.35, "SGD:USD": 0.74, "EUR:GBP": 0.86, "GBP:EUR": 1.16,
}


def _rate(frm: str, to: str) -> float:
    rate = _RATES.get(f"{frm}:{to}")
    if rate is None:
        raise DomainError(404, "pair_unavailable", f"{frm}:{to}")
    return rate


@base.seeder(ID)
def seed(state: base.State) -> None:
    state.tables["quotes"] = {}
    state.tables["transfers"] = {}


@base.op(ID, "get_quote")
def get_quote(ctx: Ctx) -> dict:
    ctx.require_scope("fx.read")
    ctx.require("from", "to", "amount")
    rate = _rate(ctx.payload["from"], ctx.payload["to"])
    amount = float(ctx.payload["amount"])
    quote = {"quoteId": base.new_id("q"), "pair": f"{ctx.payload['from']}:{ctx.payload['to']}",
             "rate": rate, "in": amount, "out": round(amount * rate, 2),
             "expiresAt": base.now() + 30}
    ctx.state.table("quotes")[quote["quoteId"]] = quote
    return quote


@base.op(ID, "convert")
def convert(ctx: Ctx) -> dict:
    ctx.require_scope("fx.convert")
    ctx.require("from", "to", "amount")
    rate = _rate(ctx.payload["from"], ctx.payload["to"])
    amount = float(ctx.payload["amount"])
    return {"dealId": base.new_id("fx"), "pair": f"{ctx.payload['from']}:{ctx.payload['to']}",
            "rate": rate, "in": amount, "out": round(amount * rate, 2), "status": "executed"}


@base.op(ID, "create_transfer")
def create_transfer(ctx: Ctx) -> dict:
    ctx.require_scope("fx.transfer")
    ctx.require("from", "to", "amount", "beneficiary")
    rate = _rate(ctx.payload["from"], ctx.payload["to"])
    amount = float(ctx.payload["amount"])
    transfer = {"transferId": base.new_id("trf"), "status": "processing",
                "pair": f"{ctx.payload['from']}:{ctx.payload['to']}", "rate": rate,
                "in": amount, "out": round(amount * rate, 2),
                "beneficiary": ctx.payload["beneficiary"]}
    ctx.state.table("transfers")[transfer["transferId"]] = transfer
    return transfer


@base.op(ID, "get_transfer")
def get_transfer(ctx: Ctx) -> dict:
    ctx.require_scope("fx.read")
    ctx.require("transferId")
    transfer = ctx.state.table("transfers").get(ctx.payload["transferId"])
    if transfer is None:
        raise DomainError(404, "transfer_not_found", ctx.payload["transferId"])
    if transfer["status"] == "processing":
        transfer["status"] = "settled"
    return transfer
