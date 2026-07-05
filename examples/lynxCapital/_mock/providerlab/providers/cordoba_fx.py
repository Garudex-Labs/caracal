"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Cordoba FX domain: cross-border FX quotes, rate-locked conversions, settlement beneficiaries, and the multi-currency vendor payments those conversions fund.
"""

from __future__ import annotations

import secrets
import uuid
from datetime import datetime, timedelta, timezone

from _mock.providerlab.data import generators as gen
from _mock.providerlab.providers import base
from _mock.providerlab.providers.base import Ctx, DomainError

ID = "cordoba-fx"

_QUOTE_TTL_SECONDS = 300
_SETTLEMENT_DAYS = 2
_PRIORITY_FEE = {"USD": 8.0, "EUR": 7.5, "GBP": 6.5, "SGD": 11.0, "JPY": 900.0}


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat()


def _short_ref(when: datetime) -> str:
    token = "".join(
        secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ0123456789") for _ in range(6)
    )
    return f"{when:%Y%m%d}-{token}"


def _currency(ctx: Ctx, field: str) -> str:
    value = str(ctx.payload[field]).upper()
    if not gen.fx_supported(value):
        raise DomainError(
            422, "currency_pair_not_supported", f"{field} {value!r} is not tradeable"
        )
    return value


def _amount(ctx: Ctx, field: str = "amount") -> float:
    try:
        value = float(ctx.payload[field])
    except (TypeError, ValueError):
        raise DomainError(422, "invalid_amount", f"{field} must be a number")
    if value <= 0:
        raise DomainError(422, "invalid_amount", f"{field} must be greater than zero")
    return value


def _sides(sell: str, buy: str, amount: float, fixed_side: str) -> dict:
    """Resolve buy/sell amounts and rates from the fixed side of the trade."""
    client_rate = gen.fx_client_rate(sell, buy)
    mid_rate = gen.fx_mid_rate(sell, buy)
    if fixed_side == "sell":
        sell_amount, buy_amount = amount, amount * client_rate
    else:
        buy_amount, sell_amount = amount, amount / client_rate
    return {
        "buy_amount": buy_amount,
        "sell_amount": sell_amount,
        "client_rate": client_rate,
        "mid_rate": mid_rate,
    }


@base.seeder(ID)
def seed(state: base.State) -> None:
    for name, table in gen.cordoba_dataset(ID).items():
        state.tables[name] = table
    state.tables.setdefault("quotes", {})
    state.tables.setdefault("idempotency", {})


@base.op(ID, "get_quote")
def get_quote(ctx: Ctx) -> dict:
    """Indicative cross-border rate, mid-market plus the client spread."""
    ctx.require_scope("fx.read")
    ctx.require("buy_currency", "sell_currency", "amount")
    buy = _currency(ctx, "buy_currency")
    sell = _currency(ctx, "sell_currency")
    if buy == sell:
        raise DomainError(
            422, "same_currency_conversion", "buy and sell currency must differ"
        )
    fixed_side = str(ctx.get("fixed_side", "buy")).lower()
    if fixed_side not in ("buy", "sell"):
        raise DomainError(
            422, "invalid_fixed_side", "fixed_side must be 'buy' or 'sell'"
        )
    sides = _sides(sell, buy, _amount(ctx), fixed_side)
    now = _now()
    quote = {
        "quote_id": _uuid(),
        "currency_pair": f"{buy}{sell}",
        "client_buy_currency": buy,
        "client_sell_currency": sell,
        "client_buy_amount": gen.fx_money(sides["buy_amount"], buy),
        "client_sell_amount": gen.fx_money(sides["sell_amount"], sell),
        "fixed_side": fixed_side,
        "client_rate": gen.fx_rate_str(sides["client_rate"]),
        "mid_market_rate": gen.fx_rate_str(sides["mid_rate"]),
        "core_rate": gen.fx_rate_str(sides["client_rate"]),
        "fee_amount": gen.fx_money(0, sell),
        "fee_currency": sell,
        "settlement_cut_off_time": _iso(now + timedelta(days=_SETTLEMENT_DAYS)),
        "quote_expiry_time": _iso(now + timedelta(seconds=_QUOTE_TTL_SECONDS)),
        "conversion_date": _iso(
            (now + timedelta(days=_SETTLEMENT_DAYS)).replace(hour=0, minute=0, second=0)
        ),
        "deposit_required": False,
    }
    ctx.state.table("quotes")[quote["quote_id"]] = quote
    return quote


@base.op(ID, "create_conversion")
def create_conversion(ctx: Ctx) -> dict:
    """Lock a rate and book a conversion into the settlement lifecycle."""
    ctx.require_scope("fx.convert")
    ctx.require("buy_currency", "sell_currency", "amount")
    if str(ctx.get("term_agreement", "")).lower() not in ("true", "1", "yes"):
        raise DomainError(
            422,
            "term_agreement_required",
            "term_agreement must be accepted to book a conversion",
        )
    buy = _currency(ctx, "buy_currency")
    sell = _currency(ctx, "sell_currency")
    if buy == sell:
        raise DomainError(
            422, "same_currency_conversion", "buy and sell currency must differ"
        )
    fixed_side = str(ctx.get("fixed_side", "buy")).lower()
    sides = _sides(sell, buy, _amount(ctx), fixed_side)
    minimum = gen.fx_min_conversion(sell)
    if sides["sell_amount"] < minimum:
        raise DomainError(
            422,
            "amount_below_minimum",
            f"conversion is below the {gen.fx_money(minimum, sell)} {sell} minimum",
        )

    idem = ctx.get("unique_request_id")
    keys = ctx.state.table("idempotency")
    conversions = ctx.state.table("conversions")
    if idem and idem in keys:
        return conversions[keys[idem]]

    now = _now()
    settlement = now + timedelta(days=_SETTLEMENT_DAYS)
    conversion = {
        "id": _uuid(),
        "short_reference": _short_ref(now),
        "currency_pair": f"{buy}{sell}",
        "status": "awaiting_funds",
        "buy_currency": buy,
        "sell_currency": sell,
        "client_buy_amount": gen.fx_money(sides["buy_amount"], buy),
        "client_sell_amount": gen.fx_money(sides["sell_amount"], sell),
        "fixed_side": fixed_side,
        "client_rate": gen.fx_rate_str(sides["client_rate"]),
        "mid_market_rate": gen.fx_rate_str(sides["mid_rate"]),
        "core_rate": gen.fx_rate_str(sides["client_rate"]),
        "settlement_date": _iso(settlement),
        "conversion_date": _iso(settlement.replace(hour=0, minute=0, second=0)),
        "deposit_required": False,
        "deposit_amount": gen.fx_money(0, sell),
        "deposit_currency": sell,
        "unique_request_id": idem,
        "payment_ids": [],
        "created_at": _iso(now),
        "updated_at": _iso(now),
    }
    conversions[conversion["id"]] = conversion
    if idem:
        keys[idem] = conversion["id"]
    return conversion


@base.op(ID, "get_conversion")
def get_conversion(ctx: Ctx) -> dict:
    ctx.require_scope("fx.read")
    ctx.require("conversion_id")
    conversion = ctx.state.table("conversions").get(ctx.payload["conversion_id"])
    if conversion is None:
        raise DomainError(404, "conversion_not_found", ctx.payload["conversion_id"])
    nxt = gen.fx_next_status(conversion["status"], "conversion")
    if nxt != conversion["status"]:
        conversion["status"] = nxt
        conversion["updated_at"] = _iso(_now())
    return conversion


@base.op(ID, "create_beneficiary")
def create_beneficiary(ctx: Ctx) -> dict:
    """Register a vendor's bank account as a settlement beneficiary."""
    ctx.require_scope("fx.transfer")
    ctx.require("bank_account_holder_name", "bank_country", "currency")
    currency = _currency(ctx, "currency")
    if not ctx.get("account_number") and not ctx.get("iban"):
        raise DomainError(
            422, "missing_routing_details", "an account_number or iban is required"
        )
    entity_type = str(ctx.get("beneficiary_entity_type", "individual")).lower()
    if entity_type not in ("individual", "company"):
        raise DomainError(
            422,
            "invalid_entity_type",
            "beneficiary_entity_type must be 'individual' or 'company'",
        )
    holder = str(ctx.payload["bank_account_holder_name"])
    country = str(ctx.payload["bank_country"]).upper()
    now = _now()
    beneficiary = {
        "id": _uuid(),
        "bank_account_holder_name": holder,
        "name": ctx.get("name", f"{holder} {currency} account"),
        "beneficiary_entity_type": entity_type,
        "beneficiary_company_name": holder if entity_type == "company" else "",
        "beneficiary_first_name": "" if entity_type == "company" else holder.split()[0],
        "beneficiary_last_name": "" if entity_type == "company" else holder.split()[-1],
        "beneficiary_country": str(ctx.get("beneficiary_country", country)).upper(),
        "beneficiary_address": ctx.get("beneficiary_address", []),
        "beneficiary_city": ctx.get("beneficiary_city", ""),
        "currency": currency,
        "bank_country": country,
        "bank_name": ctx.get("bank_name", ""),
        "account_number": ctx.get("account_number"),
        "iban": ctx.get("iban"),
        "bic_swift": ctx.get("bic_swift"),
        "routing_code_type_1": ctx.get("routing_code_type_1"),
        "routing_code_value_1": ctx.get("routing_code_value_1"),
        "bank_account_type": ctx.get("bank_account_type"),
        "payment_types": ctx.get("payment_types", ["regular"]),
        "status": "enabled",
        "created_at": _iso(now),
        "updated_at": _iso(now),
    }
    ctx.state.table("beneficiaries")[beneficiary["id"]] = beneficiary
    return beneficiary


@base.op(ID, "get_beneficiary")
def get_beneficiary(ctx: Ctx) -> dict:
    ctx.require_scope("fx.read")
    ctx.require("beneficiary_id")
    beneficiary = ctx.state.table("beneficiaries").get(ctx.payload["beneficiary_id"])
    if beneficiary is None:
        raise DomainError(404, "beneficiary_not_found", ctx.payload["beneficiary_id"])
    return beneficiary


@base.op(ID, "list_beneficiaries")
def list_beneficiaries(ctx: Ctx) -> dict:
    ctx.require_scope("fx.read")
    items = list(ctx.state.table("beneficiaries").values())
    currency = ctx.get("currency")
    if currency:
        items = [b for b in items if b["currency"] == str(currency).upper()]
    items.sort(key=lambda b: b["created_at"], reverse=True)
    return ctx.paginate(items, size_default=20)


@base.op(ID, "create_payment")
def create_payment(ctx: Ctx) -> dict:
    """Settle funds to a beneficiary, optionally drawing on a booked conversion."""
    ctx.require_scope("fx.transfer")
    ctx.require("currency", "amount", "beneficiary_id")
    currency = _currency(ctx, "currency")
    amount = _amount(ctx)
    beneficiary = ctx.state.table("beneficiaries").get(ctx.payload["beneficiary_id"])
    if beneficiary is None:
        raise DomainError(404, "beneficiary_not_found", ctx.payload["beneficiary_id"])
    if beneficiary["currency"] != currency:
        raise DomainError(
            422,
            "beneficiary_currency_mismatch",
            f"beneficiary settles in {beneficiary['currency']}, not {currency}",
        )

    payment_type = str(ctx.get("payment_type", "regular")).lower()
    if payment_type not in ("regular", "priority"):
        raise DomainError(
            422, "invalid_payment_type", "payment_type must be 'regular' or 'priority'"
        )
    if payment_type not in beneficiary.get("payment_types", ["regular"]):
        raise DomainError(
            422,
            "payment_type_unavailable",
            f"beneficiary does not support {payment_type} payments",
        )

    conversion = None
    conversion_id = ctx.get("conversion_id")
    if conversion_id:
        conversion = ctx.state.table("conversions").get(conversion_id)
        if conversion is None:
            raise DomainError(404, "conversion_not_found", conversion_id)
        if conversion["buy_currency"] != currency:
            raise DomainError(
                422,
                "conversion_currency_mismatch",
                f"conversion delivers {conversion['buy_currency']}, not {currency}",
            )

    idem = ctx.get("unique_request_id")
    keys = ctx.state.table("idempotency")
    payments = ctx.state.table("payments")
    if idem and idem in keys:
        return payments[keys[idem]]

    fee = _PRIORITY_FEE.get(currency, 8.0) if payment_type == "priority" else 0.0
    now = _now()
    payment = {
        "id": _uuid(),
        "short_reference": _short_ref(now),
        "beneficiary_id": beneficiary["id"],
        "conversion_id": conversion_id,
        "amount": gen.fx_money(amount, currency),
        "currency": currency,
        "status": "ready_to_send",
        "payment_type": payment_type,
        "charge_type": str(ctx.get("charge_type", "shared")).lower(),
        "reference": ctx.get("reference", ""),
        "reason": ctx.get("reason", "vendor invoice settlement"),
        "purpose_code": ctx.get("purpose_code", "GDDS"),
        "payment_date": _iso(now.replace(hour=0, minute=0, second=0)),
        "payment_fee_amount": gen.fx_money(fee, currency),
        "payment_fee_currency": currency,
        "transaction_id": _uuid(),
        "failure_reason": "",
        "created_at": _iso(now),
        "updated_at": _iso(now),
    }
    payments[payment["id"]] = payment
    if conversion is not None:
        conversion["payment_ids"].append(payment["id"])
    if idem:
        keys[idem] = payment["id"]
    return payment


@base.op(ID, "get_payment")
def get_payment(ctx: Ctx) -> dict:
    ctx.require_scope("fx.read")
    ctx.require("payment_id")
    payment = ctx.state.table("payments").get(ctx.payload["payment_id"])
    if payment is None:
        raise DomainError(404, "payment_not_found", ctx.payload["payment_id"])
    nxt = gen.fx_next_status(payment["status"], "payment")
    if nxt != payment["status"]:
        payment["status"] = nxt
        payment["updated_at"] = _iso(_now())
    return payment


@base.op(ID, "list_balances")
def list_balances(ctx: Ctx) -> dict:
    ctx.require_scope("fx.read")
    items = sorted(ctx.state.table("balances").values(), key=lambda b: b["currency"])
    return {"balances": items, "total": len(items)}
