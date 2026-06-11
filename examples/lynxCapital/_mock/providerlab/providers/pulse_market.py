"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Pulse Market Data domain: FX instrument reference, real-time quotes, OHLC bars, end-of-day reference fixings, and streamable rate subscriptions.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from _mock.providerlab.data import generators as gen
from _mock.providerlab.providers import base
from _mock.providerlab.providers.base import Ctx, DomainError

ID = "pulse-market"

_EPOCH = datetime(2026, 1, 1, tzinfo=timezone.utc)
_RESOLUTIONS = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}
_MAX_BARS = 500
_MAX_BATCH = 25
_MAX_STREAM_TICKS = 50
_CHANNELS = ("quotes", "trades", "bars")
_HEARTBEAT_MS = 15000


def _iso(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")


@base.seeder(ID)
def seed(state: base.State) -> None:
    for name, table in gen.pulse_dataset(ID).items():
        state.tables[name] = table


def _instrument(ctx: Ctx, symbol: str) -> dict:
    inst = ctx.state.table("instruments").get(symbol)
    if inst is None:
        raise DomainError(404, "instrument_not_found", f"unknown instrument {symbol!r}")
    return inst


def _symbols(ctx: Ctx, field: str = "symbols") -> list[str]:
    raw = ctx.payload.get(field)
    if isinstance(raw, str):
        items = [s.strip() for s in raw.split(",") if s.strip()]
    elif isinstance(raw, (list, tuple)):
        items = [str(s).strip() for s in raw if str(s).strip()]
    else:
        items = []
    if not items:
        raise DomainError(422, "invalid_request", f"{field} must list one or more instruments")
    return items


def _quote(inst: dict, seq: int = 0) -> dict:
    """A point-in-time top-of-book quote derived deterministically from the seed."""
    decimals = inst["priceDecimals"]
    rng = gen._rng(ID, "tick", inst["symbol"], seq)
    mid = round(inst["mid"] * (1 + rng.uniform(-0.0018, 0.0018)), decimals)
    half = inst["mid"] * (inst["spreadBps"] / 2 / 10_000)
    bid = round(mid - half, decimals)
    ask = round(mid + half, decimals)
    prev = inst["prevClose"]
    change = round(mid - prev, decimals)
    change_pct = round((mid - prev) / prev * 100, 4) if prev else 0.0
    day_high = round(max(inst["dayOpen"], mid) * (1 + abs(rng.uniform(0, 0.0011))), decimals)
    day_low = round(min(inst["dayOpen"], mid) * (1 - abs(rng.uniform(0, 0.0011))), decimals)
    return {
        "symbol": inst["symbol"],
        "bid": bid,
        "ask": ask,
        "mid": mid,
        "spread": round(ask - bid, decimals),
        "spreadBps": inst["spreadBps"],
        "bidSize": rng.choice((1, 2, 5, 10, 25)) * 1_000_000,
        "askSize": rng.choice((1, 2, 5, 10, 25)) * 1_000_000,
        "dayOpen": inst["dayOpen"],
        "dayHigh": day_high,
        "dayLow": day_low,
        "prevClose": prev,
        "change": change,
        "changePct": change_pct,
        "volume": rng.randint(1_000_000, 80_000_000),
        "quoteCurrency": inst["quoteCurrency"],
        "venue": inst["venue"],
        "tradingStatus": "open",
        "seq": seq,
        "timestamp": _iso(_EPOCH + timedelta(seconds=seq)),
    }


@base.op(ID, "list_instruments")
def list_instruments(ctx: Ctx) -> dict:
    """The tradable FX instrument universe with reference metadata."""
    items = list(ctx.state.table("instruments").values())
    asset_class = ctx.get("assetClass")
    if asset_class:
        items = [i for i in items if i["assetClass"] == asset_class]
    items.sort(key=lambda i: i["symbol"])
    return ctx.paginate(items, size_default=50)


@base.op(ID, "get_instrument")
def get_instrument(ctx: Ctx) -> dict:
    """Reference metadata for a single instrument."""
    ctx.require("symbol")
    return _instrument(ctx, ctx.payload["symbol"])


@base.op(ID, "get_snapshot")
def get_snapshot(ctx: Ctx) -> dict:
    """A single point-in-time top-of-book quote for one instrument."""
    ctx.require("symbol")
    return _quote(_instrument(ctx, ctx.payload["symbol"]), 0)


@base.op(ID, "get_quotes")
def get_quotes(ctx: Ctx) -> dict:
    """A batched quote request across multiple instruments."""
    symbols = _symbols(ctx)
    if len(symbols) > _MAX_BATCH:
        raise DomainError(422, "too_many_symbols",
                          f"a batch request accepts at most {_MAX_BATCH} instruments")
    quotes = [_quote(_instrument(ctx, symbol), 0) for symbol in symbols]
    return {"count": len(quotes), "quotes": quotes, "asOf": _iso(_EPOCH)}


@base.op(ID, "get_bars")
def get_bars(ctx: Ctx) -> dict:
    """Historical OHLCV aggregates for one instrument at a given resolution."""
    ctx.require("symbol")
    inst = _instrument(ctx, ctx.payload["symbol"])
    resolution = str(ctx.get("resolution", "1h"))
    if resolution not in _RESOLUTIONS:
        raise DomainError(422, "invalid_resolution",
                          f"resolution must be one of {', '.join(_RESOLUTIONS)}")
    count = int(ctx.get("count", 50))
    if count < 1 or count > _MAX_BARS:
        raise DomainError(422, "range_too_large",
                          f"count must be between 1 and {_MAX_BARS}")
    decimals = inst["priceDecimals"]
    step = _RESOLUTIONS[resolution]
    bars = []
    close = inst["prevClose"]
    for i in range(count):
        rng = gen._rng(ID, "bar", inst["symbol"], resolution, i)
        open_ = close
        drift = rng.uniform(-0.0025, 0.0025)
        close = round(open_ * (1 + drift), decimals)
        high = round(max(open_, close) * (1 + abs(rng.uniform(0, 0.0015))), decimals)
        low = round(min(open_, close) * (1 - abs(rng.uniform(0, 0.0015))), decimals)
        ts = _EPOCH - timedelta(seconds=step * (count - i))
        bars.append({
            "t": _iso(ts),
            "open": open_,
            "high": high,
            "low": low,
            "close": close,
            "volume": rng.randint(500_000, 25_000_000),
        })
    return {"symbol": inst["symbol"], "resolution": resolution,
            "count": len(bars), "bars": bars}


@base.op(ID, "get_market_status")
def get_market_status(ctx: Ctx) -> dict:
    """Current trading status of the FX market and its regional venues."""
    venues = [
        {"venue": "LDN", "region": "Europe", "status": "open"},
        {"venue": "NYC", "region": "Americas", "status": "open"},
        {"venue": "TKY", "region": "Asia", "status": "open"},
        {"venue": "SGP", "region": "Asia", "status": "open"},
    ]
    return {"market": "fx", "status": "open", "session": "london_newyork_overlap",
            "serverTime": _iso(_EPOCH), "venues": venues}


@base.op(ID, "list_reference_rates")
def list_reference_rates(ctx: Ctx) -> dict:
    """Published end-of-day reference fixings, newest first."""
    items = list(ctx.state.table("reference_rates").values())
    symbol = ctx.get("symbol")
    if symbol:
        items = [r for r in items if r["symbol"] == symbol]
    fixing_date = ctx.get("fixingDate")
    if fixing_date:
        items = [r for r in items if r["fixingDate"] == fixing_date]
    items.sort(key=lambda r: (r["fixingDate"], r["symbol"]), reverse=True)
    return ctx.paginate(items, size_default=50)


@base.op(ID, "get_reference_rate")
def get_reference_rate(ctx: Ctx) -> dict:
    """The reference fixing for one instrument, defaulting to the latest available."""
    ctx.require("symbol")
    symbol = ctx.payload["symbol"]
    _instrument(ctx, symbol)
    rows = [r for r in ctx.state.table("reference_rates").values() if r["symbol"] == symbol]
    fixing_date = ctx.get("fixingDate")
    if fixing_date:
        rows = [r for r in rows if r["fixingDate"] == fixing_date]
    if not rows:
        raise DomainError(404, "reference_rate_not_found",
                          f"no fixing for {symbol} on {fixing_date or 'any recent date'}")
    return max(rows, key=lambda r: r["fixingDate"])


@base.op(ID, "create_subscription")
def create_subscription(ctx: Ctx) -> dict:
    """Open a streaming subscription to one or more instruments on a channel."""
    symbols = _symbols(ctx)
    if len(symbols) > _MAX_BATCH:
        raise DomainError(422, "too_many_symbols",
                          f"a subscription accepts at most {_MAX_BATCH} instruments")
    channel = str(ctx.get("channel", "quotes"))
    if channel not in _CHANNELS:
        raise DomainError(422, "invalid_channel",
                          f"channel must be one of {', '.join(_CHANNELS)}")
    for symbol in symbols:
        _instrument(ctx, symbol)
    sub_id = base.new_id("sub")
    record = {
        "subscriptionId": sub_id,
        "channel": channel,
        "symbols": symbols,
        "status": "active",
        "deliveryProtocol": "sse",
        "streamUrl": f"/stream?symbol={symbols[0]}&channel={channel}",
        "heartbeatIntervalMs": _HEARTBEAT_MS,
        "createdAt": _iso(_EPOCH),
        "cancelledAt": None,
    }
    ctx.state.table("subscriptions")[sub_id] = record
    return record


@base.op(ID, "list_subscriptions")
def list_subscriptions(ctx: Ctx) -> dict:
    """All streaming subscriptions opened on this connection."""
    items = list(ctx.state.table("subscriptions").values())
    status = ctx.get("status")
    if status:
        items = [s for s in items if s["status"] == status]
    items.sort(key=lambda s: s["subscriptionId"])
    return ctx.paginate(items, size_default=25)


@base.op(ID, "get_subscription")
def get_subscription(ctx: Ctx) -> dict:
    """Fetch one streaming subscription by id."""
    ctx.require("subscriptionId")
    sub = ctx.state.table("subscriptions").get(ctx.payload["subscriptionId"])
    if sub is None:
        raise DomainError(404, "subscription_not_found",
                          f"no such subscription: {ctx.payload['subscriptionId']}")
    return sub


@base.op(ID, "cancel_subscription")
def cancel_subscription(ctx: Ctx) -> dict:
    """Cancel a streaming subscription; cancelling an already-closed one is a no-op."""
    ctx.require("subscriptionId")
    sub = ctx.state.table("subscriptions").get(ctx.payload["subscriptionId"])
    if sub is None:
        raise DomainError(404, "subscription_not_found",
                          f"no such subscription: {ctx.payload['subscriptionId']}")
    if sub["status"] == "active":
        sub["status"] = "cancelled"
        sub["cancelledAt"] = _iso(_EPOCH)
    return sub


@base.op(ID, "stream_rates")
def stream_rates(ctx: Ctx) -> dict:
    """A finite window of quote ticks; the SSE surface streams these as events."""
    ctx.require("symbol")
    inst = _instrument(ctx, ctx.payload["symbol"])
    count = max(1, min(int(ctx.get("ticks", 10)), _MAX_STREAM_TICKS))
    return {"symbol": inst["symbol"], "channel": "quotes", "count": count,
            "heartbeatIntervalMs": _HEARTBEAT_MS,
            "ticks": [_quote(inst, n) for n in range(count)]}
