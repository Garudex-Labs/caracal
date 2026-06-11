"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Keystone Treasury domain: multi-entity cash positioning, liquidity forecasting, FX hedging, intercompany transfers, currency exposure, and short-term treasury operations over a versioned gRPC service surface.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from _mock.providerlab.data import generators as gen
from _mock.providerlab.providers import base
from _mock.providerlab.providers.base import Ctx, DomainError

ID = "keystone-treasury"

_REPORTING_CCY = "USD"
_FORECAST_SCENARIOS = ("base", "optimistic", "stress")
_HEDGE_INSTRUMENTS = ("forward", "fx_swap", "ndf")
_SETTLEMENT_DAYS = 2


base.grpc_service(
    ID,
    package="keystone.treasury.v1",
    services=[
        {"name": "CashPositionService", "rpcs": [
            {"name": "ListPositions", "operation": "list_positions",
             "request": "ListPositionsRequest", "response": "ListPositionsResponse"},
            {"name": "GetPosition", "operation": "get_position",
             "request": "GetPositionRequest", "response": "CurrencyPosition"},
            {"name": "GetAccount", "operation": "get_account",
             "request": "GetAccountRequest", "response": "AccountPosition"},
            {"name": "GetPositionSummary", "operation": "get_position_summary",
             "request": "GetPositionSummaryRequest", "response": "PositionSummary"},
            {"name": "WatchPositions", "operation": "watch_positions",
             "request": "WatchPositionsRequest", "response": "PositionUpdate",
             "server_streaming": True},
        ]},
        {"name": "LiquidityForecastService", "rpcs": [
            {"name": "ForecastLiquidity", "operation": "forecast_liquidity",
             "request": "ForecastLiquidityRequest", "response": "LiquidityForecast"},
        ]},
        {"name": "HedgingService", "rpcs": [
            {"name": "ListHedges", "operation": "list_hedges",
             "request": "ListHedgesRequest", "response": "ListHedgesResponse"},
            {"name": "PlaceHedge", "operation": "place_hedge",
             "request": "PlaceHedgeRequest", "response": "Hedge"},
            {"name": "GetHedge", "operation": "get_hedge",
             "request": "GetHedgeRequest", "response": "Hedge"},
            {"name": "CancelHedge", "operation": "cancel_hedge",
             "request": "CancelHedgeRequest", "response": "Hedge"},
        ]},
        {"name": "FundsTransferService", "rpcs": [
            {"name": "TransferFunds", "operation": "transfer_funds",
             "request": "TransferFundsRequest", "response": "Transfer"},
            {"name": "GetTransfer", "operation": "get_transfer",
             "request": "GetTransferRequest", "response": "Transfer"},
            {"name": "ListTransfers", "operation": "list_transfers",
             "request": "ListTransfersRequest", "response": "ListTransfersResponse"},
        ]},
        {"name": "ExposureService", "rpcs": [
            {"name": "GetExposure", "operation": "get_exposure",
             "request": "GetExposureRequest", "response": "CurrencyExposure"},
            {"name": "ListExposures", "operation": "list_exposures",
             "request": "ListExposuresRequest", "response": "ListExposuresResponse"},
        ]},
        {"name": "TreasuryOperationsService", "rpcs": [
            {"name": "ListOperations", "operation": "list_operations",
             "request": "ListOperationsRequest", "response": "ListOperationsResponse"},
            {"name": "GetOperation", "operation": "get_operation",
             "request": "GetOperationRequest", "response": "TreasuryOperation"},
        ]},
    ],
)


def _now() -> datetime:
    return datetime(2026, 1, 1, tzinfo=timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _currency(ctx: Ctx, field: str) -> str:
    value = str(ctx.payload[field]).upper()
    if not gen.fx_supported(value):
        raise DomainError(422, "currency_not_supported", f"{field} {value!r} is not a supported currency")
    return value


def _amount(ctx: Ctx, field: str = "amount") -> float:
    try:
        value = float(ctx.payload[field])
    except (TypeError, ValueError):
        raise DomainError(422, "invalid_amount", f"{field} must be a number")
    if value <= 0:
        raise DomainError(422, "invalid_amount", f"{field} must be greater than zero")
    return value


def _money(amount: float, currency: str) -> float:
    return round(amount, gen.fx_minor_units(currency))


def _value_date(ctx: Ctx, base_dt: datetime) -> datetime:
    """Resolve a settlement value date, defaulting to spot and rejecting back-value."""
    raw = ctx.get("valueDate")
    if not raw:
        return base_dt + timedelta(days=_SETTLEMENT_DAYS)
    try:
        parsed = datetime.fromisoformat(str(raw)).replace(tzinfo=timezone.utc)
    except ValueError:
        raise DomainError(422, "invalid_value_date", "valueDate must be ISO-8601 (YYYY-MM-DD)")
    if parsed.date() < base_dt.date():
        raise DomainError(422, "value_date_in_past", "valueDate cannot precede the current treasury date")
    return parsed


def _accounts_for(ctx: Ctx, currency: str) -> list[dict]:
    return [p for p in ctx.state.table("positions").values() if p["currency"] == currency]


@base.seeder(ID)
def seed(state: base.State) -> None:
    for name, table in gen.keystone_dataset(ID).items():
        state.tables[name] = table


# --------------------------------------------------------------------------- #
# CashPositionService
# --------------------------------------------------------------------------- #
@base.op(ID, "list_positions")
def list_positions(ctx: Ctx) -> dict:
    """Bank-account cash positions across the treasury group."""
    items = list(ctx.state.table("positions").values())
    currency = ctx.get("currency")
    if currency:
        items = [p for p in items if p["currency"] == str(currency).upper()]
    entity = ctx.get("legalEntityId") or ctx.get("entityId")
    if entity:
        items = [p for p in items if p["legalEntityId"] == str(entity).upper()]
    items.sort(key=lambda p: (p["currency"], p["legalEntityId"], p["purpose"]))
    return ctx.paginate(items, size_default=25)


@base.op(ID, "get_position")
def get_position(ctx: Ctx) -> dict:
    """Aggregate cash position for one currency across every group account."""
    ctx.require("currency")
    currency = _currency(ctx, "currency")
    accounts = _accounts_for(ctx, currency)
    if not accounts:
        raise DomainError(404, "position_not_found", f"no accounts hold {currency}")
    ledger = _money(sum(a["ledgerBalance"] for a in accounts), currency)
    available = _money(sum(a["availableBalance"] for a in accounts), currency)
    value_dated = _money(sum(a["valueDatedBalance"] for a in accounts), currency)
    projected = _money(sum(a["projectedBalance"] for a in accounts), currency)
    as_of = max(a["asOf"] for a in accounts)
    return {
        "currency": currency,
        "asOf": as_of,
        "accountCount": len(accounts),
        "ledgerBalance": ledger,
        "availableBalance": available,
        "valueDatedBalance": value_dated,
        "projectedBalance": projected,
        "reportingCurrency": _REPORTING_CCY,
        "availableBalanceBase": round(gen.keystone_usd(available, currency), 2),
        "accounts": [
            {"accountId": a["accountId"], "legalEntity": a["legalEntity"],
             "bankName": a["bankName"], "purpose": a["purpose"],
             "availableBalance": a["availableBalance"]}
            for a in sorted(accounts, key=lambda x: x["legalEntityId"])
        ],
    }


@base.op(ID, "get_account")
def get_account(ctx: Ctx) -> dict:
    """Full position for one bank account."""
    ctx.require("accountId")
    account = ctx.state.table("positions").get(ctx.payload["accountId"])
    if account is None:
        raise DomainError(404, "account_not_found", ctx.payload["accountId"])
    return account


@base.op(ID, "get_position_summary")
def get_position_summary(ctx: Ctx) -> dict:
    """Group cash summary converted to the reporting currency."""
    accounts = list(ctx.state.table("positions").values())
    by_currency: dict[str, dict] = {}
    total_base = 0.0
    for a in accounts:
        ccy = a["currency"]
        bucket = by_currency.setdefault(ccy, {"currency": ccy, "accountCount": 0,
                                               "availableBalance": 0.0, "ledgerBalance": 0.0})
        bucket["accountCount"] += 1
        bucket["availableBalance"] = _money(bucket["availableBalance"] + a["availableBalance"], ccy)
        bucket["ledgerBalance"] = _money(bucket["ledgerBalance"] + a["ledgerBalance"], ccy)
    for ccy, bucket in by_currency.items():
        base_eq = round(gen.keystone_usd(bucket["availableBalance"], ccy), 2)
        bucket["availableBalanceBase"] = base_eq
        total_base += base_eq
    return {
        "reportingCurrency": _REPORTING_CCY,
        "asOf": _iso(_now()),
        "totalAvailableBase": round(total_base, 2),
        "currencyCount": len(by_currency),
        "accountCount": len(accounts),
        "byCurrency": sorted(by_currency.values(), key=lambda b: b["availableBalanceBase"], reverse=True),
    }


@base.op(ID, "watch_positions")
def watch_positions(ctx: Ctx) -> dict:
    """Server-streaming snapshot of intraday position movements for one currency."""
    ctx.require("currency")
    currency = _currency(ctx, "currency")
    accounts = _accounts_for(ctx, currency)
    if not accounts:
        raise DomainError(404, "position_not_found", f"no accounts hold {currency}")
    ticks = max(1, min(int(ctx.get("snapshots", 6)), 24))
    base_available = sum(a["availableBalance"] for a in accounts)
    updates = []
    running = base_available
    start = _now()
    for i in range(ticks):
        rng = gen._rng(ID, "watch", currency, i)
        delta = round(rng.uniform(-0.02, 0.02) * base_available, 2)
        running = _money(running + delta, currency)
        updates.append({
            "sequence": i,
            "currency": currency,
            "asOf": _iso(start + timedelta(minutes=i * 5)),
            "availableBalance": running,
            "movement": delta,
        })
    return {"currency": currency, "streaming": True, "count": len(updates), "updates": updates}


# --------------------------------------------------------------------------- #
# LiquidityForecastService
# --------------------------------------------------------------------------- #
@base.op(ID, "forecast_liquidity")
def forecast_liquidity(ctx: Ctx) -> dict:
    """Project cash flow over a horizon for one currency under a named scenario."""
    ctx.require("currency", "horizonDays")
    currency = _currency(ctx, "currency")
    accounts = _accounts_for(ctx, currency)
    if not accounts:
        raise DomainError(404, "position_not_found", f"no accounts hold {currency}")
    try:
        horizon = int(ctx.payload["horizonDays"])
    except (TypeError, ValueError):
        raise DomainError(422, "invalid_horizon", "horizonDays must be an integer")
    if horizon <= 0 or horizon > 365:
        raise DomainError(422, "invalid_horizon", "horizonDays must be 1..365")
    scenario = str(ctx.get("scenario", "base")).lower()
    if scenario not in _FORECAST_SCENARIOS:
        raise DomainError(422, "invalid_scenario",
                          f"scenario must be one of {', '.join(_FORECAST_SCENARIOS)}")

    bias = {"base": 1.0, "optimistic": 1.4, "stress": 0.55}[scenario]
    step = max(1, horizon // 8)
    opening = _money(sum(a["availableBalance"] for a in accounts), currency)
    balance = opening
    minimum = balance
    points = []
    for day in range(0, horizon + 1, step):
        rng = gen._rng(ID, "forecast", currency, scenario, day)
        scale = max(a["availableBalance"] for a in accounts) if accounts else 1_000_000
        inflows = _money(rng.uniform(0.02, 0.12) * scale * bias, currency)
        outflows = _money(rng.uniform(0.02, 0.11) * scale * (2 - bias), currency)
        opening_day = balance
        balance = _money(balance + inflows - outflows, currency)
        minimum = min(minimum, balance)
        points.append({
            "day": day,
            "date": (_now() + timedelta(days=day)).date().isoformat(),
            "openingBalance": opening_day,
            "projectedInflows": inflows,
            "projectedOutflows": outflows,
            "closingBalance": balance,
        })

    forecast = {
        "forecastId": base.new_id("fct"),
        "currency": currency,
        "scenario": scenario,
        "horizonDays": horizon,
        "openingBalance": opening,
        "closingBalance": balance,
        "minimumProjectedBalance": minimum,
        "shortfall": minimum < 0,
        "reportingCurrency": _REPORTING_CCY,
        "closingBalanceBase": round(gen.keystone_usd(balance, currency), 2),
        "generatedAt": _iso(_now()),
        "points": points,
    }
    ctx.state.table("forecasts")[forecast["forecastId"]] = forecast
    return forecast


# --------------------------------------------------------------------------- #
# HedgingService
# --------------------------------------------------------------------------- #
def _parse_pair(value: str) -> tuple[str, str]:
    parts = str(value).upper().replace("-", "/").split("/")
    if len(parts) != 2 or not all(parts):
        raise DomainError(422, "invalid_pair", "pair must be formatted 'BUY/SELL'")
    buy, sell = parts
    if buy == sell:
        raise DomainError(422, "same_currency_pair", "pair currencies must differ")
    for ccy in (buy, sell):
        if not gen.fx_supported(ccy):
            raise DomainError(422, "currency_not_supported", f"{ccy} is not a tradeable currency")
    return buy, sell


@base.op(ID, "list_hedges")
def list_hedges(ctx: Ctx) -> dict:
    items = list(ctx.state.table("hedges").values())
    status = ctx.get("status")
    if status:
        items = [h for h in items if h["status"] == str(status).lower()]
    pair = ctx.get("pair")
    if pair:
        items = [h for h in items if h["pair"] == str(pair).upper()]
    items.sort(key=lambda h: h["tradeDate"], reverse=True)
    return ctx.paginate(items, size_default=25)


@base.op(ID, "place_hedge")
def place_hedge(ctx: Ctx) -> dict:
    """Book an FX hedge (forward, swap, or NDF) against a currency exposure."""
    ctx.require("pair", "notional", "side")
    buy, sell = _parse_pair(ctx.payload["pair"])
    side = str(ctx.payload["side"]).lower()
    if side not in ("buy", "sell"):
        raise DomainError(422, "invalid_side", "side must be 'buy' or 'sell'")
    notional = _amount(ctx, "notional")
    instrument = str(ctx.get("instrument", "forward")).lower()
    if instrument not in _HEDGE_INSTRUMENTS:
        raise DomainError(422, "invalid_instrument",
                          f"instrument must be one of {', '.join(_HEDGE_INSTRUMENTS)}")
    tenor_days = int(ctx.get("tenorDays", 90))
    if tenor_days <= 0 or tenor_days > 730:
        raise DomainError(422, "invalid_tenor", "tenorDays must be 1..730")

    now = _now()
    value_date = _value_date(ctx, now)
    settlement = value_date + timedelta(days=tenor_days)
    spot = gen.fx_mid_rate(sell, buy)
    forward_points = round((tenor_days / 365.0) * spot * 0.004, 6)
    all_in = spot + forward_points
    hedge = {
        "hedgeId": base.new_id("hdg"),
        "dealRef": f"FX{now:%Y%m%d}-{base.new_id('ref').split('_')[-1][:6].upper()}",
        "instrument": instrument,
        "pair": f"{buy}/{sell}",
        "side": side,
        "notional": _money(notional, buy),
        "notionalCurrency": buy,
        "counterCurrency": sell,
        "spotRate": gen.fx_rate_str(spot),
        "forwardPoints": f"{forward_points:.6f}",
        "allInRate": gen.fx_rate_str(all_in),
        "tradeDate": _iso(now),
        "valueDate": value_date.date().isoformat(),
        "settlementDate": settlement.date().isoformat(),
        "tenorDays": tenor_days,
        "counterparty": str(ctx.get("counterparty", "Halcyon Bank")),
        "hedgeType": str(ctx.get("hedgeType", "cashflow")),
        "portfolio": str(ctx.get("portfolio", "FX-CORE")),
        "status": "booked",
        "markToMarket": 0.0,
        "markToMarketCurrency": _REPORTING_CCY,
    }
    ctx.state.table("hedges")[hedge["hedgeId"]] = hedge
    return hedge


@base.op(ID, "get_hedge")
def get_hedge(ctx: Ctx) -> dict:
    ctx.require("hedgeId")
    hedge = ctx.state.table("hedges").get(ctx.payload["hedgeId"])
    if hedge is None:
        raise DomainError(404, "hedge_not_found", ctx.payload["hedgeId"])
    return hedge


@base.op(ID, "cancel_hedge")
def cancel_hedge(ctx: Ctx) -> dict:
    """Cancel an unsettled hedge; settled trades can no longer be unwound here."""
    ctx.require("hedgeId")
    hedge = ctx.state.table("hedges").get(ctx.payload["hedgeId"])
    if hedge is None:
        raise DomainError(404, "hedge_not_found", ctx.payload["hedgeId"])
    if hedge["status"] == "settled":
        raise DomainError(409, "hedge_not_cancellable", "a settled hedge cannot be cancelled")
    if hedge["status"] == "cancelled":
        return hedge
    hedge["status"] = "cancelled"
    hedge["cancelledAt"] = _iso(_now())
    return hedge


# --------------------------------------------------------------------------- #
# FundsTransferService
# --------------------------------------------------------------------------- #
@base.op(ID, "transfer_funds")
def transfer_funds(ctx: Ctx) -> dict:
    """Move cash intercompany or between a group entity's own accounts."""
    ctx.require("currency", "amount")
    currency = _currency(ctx, "currency")
    amount = _amount(ctx)
    accounts = _accounts_for(ctx, currency)
    if not accounts:
        raise DomainError(404, "position_not_found", f"no accounts hold {currency}")

    source = max(accounts, key=lambda a: a["availableBalance"])
    if ctx.get("fromAccountId"):
        source = ctx.state.table("positions").get(ctx.payload["fromAccountId"])
        if source is None:
            raise DomainError(404, "account_not_found", ctx.payload["fromAccountId"])
        if source["currency"] != currency:
            raise DomainError(422, "currency_mismatch",
                              f"source account holds {source['currency']}, not {currency}")
    if amount > source["availableBalance"]:
        raise DomainError(402, "insufficient_liquidity",
                          f"amount exceeds {source['availableBalance']} available on {source['accountId']}")

    dest_entity = gen.keystone_entity(region=str(ctx.get("destination", "")),
                                      currency=str(ctx.get("toCurrency", "")) or None)
    to_account = ctx.get("toAccountId")
    if to_account:
        dest = ctx.state.table("positions").get(to_account)
        if dest is None:
            raise DomainError(404, "account_not_found", to_account)
        to_account_id, to_entity_id, to_entity = dest["accountId"], dest["legalEntityId"], dest["legalEntity"]
    elif dest_entity is not None:
        to_account_id = f"acct_{dest_entity[0].lower()}_concentration"
        to_entity_id, to_entity = dest_entity[0], dest_entity[1]
    else:
        to_account_id = str(ctx.get("destination", "external"))
        to_entity_id, to_entity = "EXTERNAL", str(ctx.get("destination", "external"))

    if to_account_id == source["accountId"]:
        raise DomainError(422, "same_account_transfer", "source and destination accounts are identical")

    now = _now()
    value_date = _value_date(ctx, now)
    same_entity = to_entity_id == source["legalEntityId"]
    fee = 0.0 if same_entity else _money(min(25.0, amount * 0.0001), currency)
    source["availableBalance"] = _money(source["availableBalance"] - amount, currency)
    source["valueDatedBalance"] = _money(source["valueDatedBalance"] - amount, currency)
    transfer = {
        "transferId": base.new_id("tr"),
        "reference": f"TT{now:%Y%m%d}-{base.new_id('ref').split('_')[-1][:6].upper()}",
        "type": "internal_sweep" if same_entity else "intercompany",
        "fromAccountId": source["accountId"],
        "fromEntityId": source["legalEntityId"],
        "fromEntity": source["legalEntity"],
        "toAccountId": to_account_id,
        "toEntityId": to_entity_id,
        "toEntity": to_entity,
        "currency": currency,
        "amount": _money(amount, currency),
        "valueDate": value_date.date().isoformat(),
        "status": "executed",
        "purposeCode": str(ctx.get("purposeCode", "INTC")),
        "fee": fee,
        "feeCurrency": currency,
        "initiatedAt": _iso(now),
        "settledAt": None,
    }
    ctx.state.table("transfers")[transfer["transferId"]] = transfer
    return transfer


@base.op(ID, "get_transfer")
def get_transfer(ctx: Ctx) -> dict:
    ctx.require("transferId")
    transfer = ctx.state.table("transfers").get(ctx.payload["transferId"])
    if transfer is None:
        raise DomainError(404, "transfer_not_found", ctx.payload["transferId"])
    return transfer


@base.op(ID, "list_transfers")
def list_transfers(ctx: Ctx) -> dict:
    items = list(ctx.state.table("transfers").values())
    currency = ctx.get("currency")
    if currency:
        items = [t for t in items if t["currency"] == str(currency).upper()]
    status = ctx.get("status")
    if status:
        items = [t for t in items if t["status"] == str(status).lower()]
    items.sort(key=lambda t: t["initiatedAt"], reverse=True)
    return ctx.paginate(items, size_default=25)


# --------------------------------------------------------------------------- #
# ExposureService
# --------------------------------------------------------------------------- #
@base.op(ID, "get_exposure")
def get_exposure(ctx: Ctx) -> dict:
    """Current FX exposure for one currency, netting cash, receivables, payables, and hedges."""
    ctx.require("currency")
    currency = _currency(ctx, "currency")
    exposure = ctx.state.table("exposures").get(currency)
    if exposure is None:
        raise DomainError(404, "exposure_not_found", currency)
    return exposure


@base.op(ID, "list_exposures")
def list_exposures(ctx: Ctx) -> dict:
    items = sorted(ctx.state.table("exposures").values(),
                   key=lambda e: abs(e["netExposureBase"]), reverse=True)
    total_unhedged_base = round(sum(
        gen.keystone_usd(e["unhedgedAmount"], e["currency"]) for e in items), 2)
    return {
        "reportingCurrency": _REPORTING_CCY,
        "asOf": _iso(_now()),
        "total": len(items),
        "totalUnhedgedBase": total_unhedged_base,
        "exposures": items,
    }


# --------------------------------------------------------------------------- #
# TreasuryOperationsService
# --------------------------------------------------------------------------- #
@base.op(ID, "list_operations")
def list_operations(ctx: Ctx) -> dict:
    items = list(ctx.state.table("operations").values())
    op_type = ctx.get("type")
    if op_type:
        items = [o for o in items if o["type"] == str(op_type).lower()]
    status = ctx.get("status")
    if status:
        items = [o for o in items if o["status"] == str(status).lower()]
    items.sort(key=lambda o: o["valueDate"], reverse=True)
    return ctx.paginate(items, size_default=25)


@base.op(ID, "get_operation")
def get_operation(ctx: Ctx) -> dict:
    ctx.require("operationId")
    operation = ctx.state.table("operations").get(ctx.payload["operationId"])
    if operation is None:
        raise DomainError(404, "operation_not_found", ctx.payload["operationId"])
    return operation
