"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Pulse Market Data domain: real-time FX instruments, point-in-time snapshots, OHLC candles,
ECB-style daily reference rates, and streamable rate ticks.  Authentication: API Key (header).
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

from _mock.providerlab.data import generators as gen
from _mock.providerlab.providers import base
from _mock.providerlab.providers.base import Ctx, DomainError

ID = "pulse-market"

# Supported OHLC intervals and how many seconds each bar spans.
_INTERVALS: dict[str, int] = {
    "1m":  60,
    "5m":  300,
    "15m": 900,
    "1h":  3_600,
    "4h":  14_400,
    "1d":  86_400,
}

# ECB publishes reference rates for the major pairs against EUR.
_ECB_BASE = "EUR"
_ECB_PAIRS = ("EUR/USD", "EUR/GBP", "EUR/JPY", "EUR/CHF", "EUR/CAD",
              "EUR/SGD", "EUR/BRL", "EUR/AUD", "EUR/NZD")

# Market sessions with their approximate UTC coverage so callers can
# understand which session a tick belongs to.
_SESSIONS: list[tuple[int, int, str]] = [
    (22, 7,  "sydney"),
    (0,  9,  "asia"),
    (7,  16, "london"),
    (13, 22, "new_york"),
]


def _current_session() -> str:
    hour = datetime.now(timezone.utc).hour
    for start, end, name in _SESSIONS:
        if start <= end:
            if start <= hour < end:
                return name
        else:
            if hour >= start or hour < end:
                return name
    return "after_hours"


def _utc_iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@base.seeder(ID)
def seed(state: base.State) -> None:
    state.tables["instruments"] = gen.index_by(gen.instruments(ID), key="symbol")
    state.tables["subscriptions"] = {}
    state.tables["reference_date"] = {}


def _tick(inst: dict, seq: int, base_ts: float | None = None) -> dict:
    """Generate one deterministic price tick for an instrument."""
    symbol = inst["symbol"]
    mid_base = inst["mid"]
    pip = inst["pipSize"]
    decimals = 4 if pip == 0.0001 else 2

    rng = gen._rng(ID, "tick", symbol, seq)
    mid = round(mid_base * (1 + rng.uniform(-0.002, 0.002)), decimals)
    half_spread = round(mid * inst["spreadBps"] / 20_000, decimals)
    bid = round(mid - half_spread, decimals)
    ask = round(mid + half_spread, decimals)
    volume = rng.randint(500_000, 12_000_000)
    ts = (base_ts or time.time()) - seq * rng.uniform(0.08, 0.4)

    # Intra-day change relative to the seeded day open.
    open_price = inst["dayOpen"]
    change = round(mid - open_price, decimals)
    change_pct = round(change / open_price * 100, 4)

    # Running session high/low — widen slightly with each tick.
    session_high = round(max(inst["dayHigh"], mid) * (1 + seq * 0.000005), decimals)
    session_low  = round(min(inst["dayLow"],  mid) * (1 - seq * 0.000005), decimals)

    return {
        "symbol": symbol,
        "bid": bid,
        "ask": ask,
        "mid": mid,
        "seq": seq,
        "timestamp": _utc_iso(ts),
        "change": change,
        "changePct": change_pct,
        "volume": volume,
        "session": _current_session(),
        "open": open_price,
        "high": session_high,
        "low": session_low,
    }


def _ohlc_candle(symbol: str, mid_base: float, pip: int, interval_sec: int,
                 candle_idx: int) -> dict:
    """Return one OHLC candle for a symbol, deterministically derived from its index."""
    decimals = 4 if pip == 0.0001 else 2
    rng = gen._rng(ID, "ohlc", symbol, interval_sec, candle_idx)
    drift = rng.uniform(-0.006, 0.006)
    open_p = round(mid_base * (1 + drift), decimals)
    bar_range = rng.uniform(0.001, 0.008) * mid_base
    high_p = round(open_p + rng.uniform(0, bar_range), decimals)
    low_p  = round(open_p - rng.uniform(0, bar_range), decimals)
    close_p = round(rng.uniform(low_p, high_p), decimals)
    volume = rng.randint(1_000_000, 50_000_000)
    bar_ts = time.time() - candle_idx * interval_sec
    return {
        "t": _utc_iso(bar_ts),
        "o": open_p,
        "h": high_p,
        "l": low_p,
        "c": close_p,
        "v": volume,
    }


# ---------------------------------------------------------------------------
# Operations
# ---------------------------------------------------------------------------

@base.op(ID, "list_instruments")
def list_instruments(ctx: Ctx) -> dict:
    """List all tradeable FX instruments with full reference data."""
    items = list(ctx.state.table("instruments").values())
    asset_class = ctx.get("assetClass")
    liq_tier = ctx.get("liquidityTier")
    if asset_class:
        items = [i for i in items if i.get("assetClass") == asset_class]
    if liq_tier:
        items = [i for i in items if i.get("liquidityTier") == liq_tier]
    return {"items": items, "total": len(items)}


@base.op(ID, "get_snapshot")
def get_snapshot(ctx: Ctx) -> dict:
    """Return a point-in-time rate snapshot for one instrument."""
    ctx.require("symbol")
    inst = ctx.state.table("instruments").get(ctx.payload["symbol"])
    if inst is None:
        raise DomainError(404, "instrument_not_found", ctx.payload["symbol"])
    return _tick(inst, 0)


@base.op(ID, "stream_rates")
def stream_rates(ctx: Ctx) -> dict:
    """Return a finite window of ticks; the SSE surface streams these as events."""
    ctx.require("symbol")
    inst = ctx.state.table("instruments").get(ctx.payload["symbol"])
    if inst is None:
        raise DomainError(404, "instrument_not_found", ctx.payload["symbol"])
    count = max(1, min(int(ctx.get("ticks", 10)), 50))
    base_ts = time.time()
    return {
        "symbol": inst["symbol"],
        "interval": ctx.get("interval", "tick"),
        "ticks": [_tick(inst, n, base_ts) for n in range(count)],
    }


@base.op(ID, "get_ohlc")
def get_ohlc(ctx: Ctx) -> dict:
    """Return OHLC candles for one instrument.

    Supported intervals: 1m, 5m, 15m, 1h, 4h, 1d (default 1d).
    """
    ctx.require("symbol")
    inst = ctx.state.table("instruments").get(ctx.payload["symbol"])
    if inst is None:
        raise DomainError(404, "instrument_not_found", ctx.payload["symbol"])
    interval = ctx.get("interval", "1d")
    if interval not in _INTERVALS:
        raise DomainError(422, "invalid_interval",
                          f"interval must be one of: {', '.join(_INTERVALS)}")
    limit = max(1, min(int(ctx.get("limit", 20)), 100))
    interval_sec = _INTERVALS[interval]
    candles = [
        _ohlc_candle(inst["symbol"], inst["mid"], inst["pipSize"], interval_sec, i)
        for i in range(limit - 1, -1, -1)
    ]
    now_iso = _utc_iso(time.time())
    from_iso = _utc_iso(time.time() - limit * interval_sec)
    return {
        "symbol": inst["symbol"],
        "interval": interval,
        "from": from_iso,
        "to": now_iso,
        "candles": candles,
    }


@base.op(ID, "get_reference_rates")
def get_reference_rates(ctx: Ctx) -> dict:
    """Return ECB-style daily reference rates for all major pairs.

    The optional ``date`` field accepts an ISO date string (YYYY-MM-DD).
    When omitted the latest available fixing is returned.
    """
    date_str = ctx.get("date") or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    rng = gen._rng(ID, "refrate", date_str)
    instruments = ctx.state.table("instruments")
    rates = []
    for sym in _ECB_PAIRS:
        inst = instruments.get(sym)
        if inst is None:
            continue
        # ECB rate is a deterministic perturbation of the seeded mid price.
        perturb = rng.uniform(-0.0008, 0.0008)
        pip = inst["pipSize"]
        decimals = 4 if pip == 0.0001 else 2
        rate = round(inst["mid"] * (1 + perturb), decimals)
        rates.append({
            "symbol": sym,
            "rate": rate,
            "base": inst["base"],
            "quote": inst["quote"],
            "source": "ECB",
        })
    return {
        "date": date_str,
        "publishedAt": f"{date_str}T14:15:00Z",
        "baseCurrency": _ECB_BASE,
        "source": "ECB",
        "rates": rates,
    }


@base.op(ID, "list_subscriptions")
def list_subscriptions(ctx: Ctx) -> dict:
    """List active rate-stream subscriptions for the caller."""
    items = [s for s in ctx.state.table("subscriptions").values()
             if s["status"] == "active"]
    return ctx.paginate(items)


@base.op(ID, "create_subscription")
def create_subscription(ctx: Ctx) -> dict:
    """Subscribe to real-time rate events for an instrument."""
    ctx.require("symbol")
    inst = ctx.state.table("subscriptions")
    instruments = ctx.state.table("instruments")
    if ctx.payload["symbol"] not in instruments:
        raise DomainError(404, "instrument_not_found", ctx.payload["symbol"])
    sub_id = base.new_id("sub")
    sub = {
        "subscriptionId": sub_id,
        "symbol": ctx.payload["symbol"],
        "status": "active",
        "callbackUrl": ctx.get("callbackUrl"),
        "maxTicks": max(1, min(int(ctx.get("maxTicks", 50)), 50)),
        "createdAt": base.now(),
    }
    inst[sub_id] = sub
    return sub


@base.op(ID, "delete_subscription")
def delete_subscription(ctx: Ctx) -> dict:
    """Cancel an active subscription by ID."""
    ctx.require("subscriptionId")
    subs = ctx.state.table("subscriptions")
    sub = subs.get(ctx.payload["subscriptionId"])
    if sub is None:
        raise DomainError(404, "subscription_not_found", ctx.payload["subscriptionId"])
    if sub["status"] != "active":
        raise DomainError(409, "subscription_already_cancelled",
                          f"subscription {ctx.payload['subscriptionId']} is already {sub['status']}")
    sub = dict(sub)
    sub["status"] = "cancelled"
    sub["cancelledAt"] = base.now()
    subs[ctx.payload["subscriptionId"]] = sub
    return sub
