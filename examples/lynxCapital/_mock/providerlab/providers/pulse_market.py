"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Pulse Market Data domain: FX instrument reference, real-time quotes, OHLC bars, conversions, movers, end-of-day fixings, usage, and streamable rate subscriptions.
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
_MAX_ACTIVE_SUBS = 50

# Entitlements and limits a real market-data plan publishes through its usage API.
_PLAN = "business"
_RATE_LIMIT_PER_MIN = 600
_DAILY_QUOTA = 500_000
_ENTITLEMENTS = ("fx_spot", "reference_rates", "ohlc_bars", "streaming", "conversions")


def _iso(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")


@base.seeder(ID)
def seed(state: base.State) -> None:
    for name, table in gen.pulse_dataset(ID).items():
        state.tables[name] = table


def _instrument(ctx: Ctx, symbol: str) -> dict:
    table = ctx.state.table("instruments")
    inst = table.get(symbol)
    if inst is None:
        sample = ", ".join(sorted(table)[:8])
        raise DomainError(
            404,
            "instrument_not_found",
            f"unknown instrument {symbol!r}; symbols use BASE/QUOTE format (e.g. {sample})",
        )
    return inst


def _currencies(ctx: Ctx) -> set[str]:
    """The currency universe the venue prices, drawn from the instrument book."""
    out: set[str] = set()
    for inst in ctx.state.table("instruments").values():
        out.add(inst["baseCurrency"])
        out.add(inst["quoteCurrency"])
    return out


def _symbols(ctx: Ctx, field: str = "symbols") -> list[str]:
    raw = ctx.payload.get(field)
    if isinstance(raw, str):
        items = [s.strip() for s in raw.split(",") if s.strip()]
    elif isinstance(raw, (list, tuple)):
        items = [str(s).strip() for s in raw if str(s).strip()]
    else:
        items = []
    if not items:
        raise DomainError(
            422, "invalid_request", f"{field} must list one or more instruments"
        )
    return items


def _tick_direction(change: float) -> str:
    if change > 0:
        return "up"
    if change < 0:
        return "down"
    return "zero"


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
    day_high = round(
        max(inst["dayOpen"], mid) * (1 + abs(rng.uniform(0, 0.0011))), decimals
    )
    day_low = round(
        min(inst["dayOpen"], mid) * (1 - abs(rng.uniform(0, 0.0011))), decimals
    )
    last = round(mid + rng.uniform(-half, half), decimals)
    vwap = round((day_high + day_low + mid + inst["dayOpen"]) / 4, decimals)
    # Closeout prices a position would actually trade out at, a touch beyond the inside market.
    closeout_bid = round(bid - half * 0.5, decimals)
    closeout_ask = round(ask + half * 0.5, decimals)
    return {
        "symbol": inst["symbol"],
        "bid": bid,
        "ask": ask,
        "mid": mid,
        "last": last,
        "lastSize": rng.choice((1, 2, 5, 10)) * 1_000_000,
        "vwap": vwap,
        "spread": round(ask - bid, decimals),
        "spreadBps": inst["spreadBps"],
        "bidSize": rng.choice((1, 2, 5, 10, 25)) * 1_000_000,
        "askSize": rng.choice((1, 2, 5, 10, 25)) * 1_000_000,
        "closeoutBid": closeout_bid,
        "closeoutAsk": closeout_ask,
        "dayOpen": inst["dayOpen"],
        "dayHigh": day_high,
        "dayLow": day_low,
        "prevClose": prev,
        "change": change,
        "changePct": change_pct,
        "tickDirection": _tick_direction(change),
        "volume": rng.randint(1_000_000, 80_000_000),
        "quoteCurrency": inst["quoteCurrency"],
        "venue": inst["venue"],
        "tradeable": True,
        "tradingStatus": "open",
        "seq": seq,
        "timestamp": _iso(_EPOCH + timedelta(seconds=seq)),
    }


def _trade(inst: dict, seq: int) -> dict:
    """A simulated executed trade print, the payload a `trades` channel carries."""
    quote = _quote(inst, seq)
    rng = gen._rng(ID, "trade", inst["symbol"], seq)
    side = rng.choice(("buy", "sell"))
    price = quote["ask"] if side == "buy" else quote["bid"]
    return {
        "symbol": inst["symbol"],
        "tradeId": f"trd_{inst['ticker']}_{seq:06d}",
        "price": price,
        "size": rng.choice((1, 2, 5, 10, 25)) * 100_000,
        "side": side,
        "aggressor": side,
        "venue": inst["venue"],
        "seq": seq,
        "timestamp": quote["timestamp"],
    }


def _bar_event(inst: dict, seq: int) -> dict:
    """A simulated rolling one-minute bar, the payload a `bars` channel carries."""
    bar = _build_bars(inst, "1m", 1, end_offset=seq)[0]
    bar["symbol"] = inst["symbol"]
    bar["seq"] = seq
    bar["timestamp"] = _iso(_EPOCH + timedelta(seconds=seq))
    return bar


def _build_bars(
    inst: dict, resolution: str, count: int, *, end_offset: int = 0
) -> list[dict]:
    decimals = inst["priceDecimals"]
    step = _RESOLUTIONS[resolution]
    bars = []
    close = inst["prevClose"]
    for i in range(count):
        rng = gen._rng(ID, "bar", inst["symbol"], resolution, i + end_offset)
        open_ = close
        drift = rng.uniform(-0.0025, 0.0025)
        close = round(open_ * (1 + drift), decimals)
        high = round(max(open_, close) * (1 + abs(rng.uniform(0, 0.0015))), decimals)
        low = round(min(open_, close) * (1 - abs(rng.uniform(0, 0.0015))), decimals)
        vwap = round((open_ + high + low + close) / 4, decimals)
        ts = _EPOCH - timedelta(seconds=step * (count - i))
        bars.append(
            {
                "t": _iso(ts),
                "open": open_,
                "high": high,
                "low": low,
                "close": close,
                "vwap": vwap,
                "volume": rng.randint(500_000, 25_000_000),
                "tradeCount": rng.randint(40, 4_000),
                "complete": True,
            }
        )
    return bars


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
        raise DomainError(
            422,
            "too_many_symbols",
            f"a batch request accepts at most {_MAX_BATCH} instruments",
        )
    quotes = [_quote(_instrument(ctx, symbol), 0) for symbol in symbols]
    return {
        "status": "ok",
        "count": len(quotes),
        "quotes": quotes,
        "asOf": _iso(_EPOCH),
    }


@base.op(ID, "convert")
def convert(ctx: Ctx) -> dict:
    """Convert an amount between two priced currencies at the live mid rate."""
    ctx.require("from", "to", "amount")
    sell = str(ctx.payload["from"]).upper()
    buy = str(ctx.payload["to"]).upper()
    supported = _currencies(ctx)
    unknown = [c for c in (sell, buy) if c not in supported]
    if unknown:
        raise DomainError(
            422,
            "unsupported_currency",
            f"currency not priced by this venue: {', '.join(unknown)}",
        )
    try:
        amount = float(ctx.payload["amount"])
    except (TypeError, ValueError):
        raise DomainError(422, "invalid_request", "amount must be a number")
    if amount <= 0:
        raise DomainError(422, "invalid_amount", "amount must be greater than zero")
    decimals = gen.pulse_price_decimals(buy)
    mid = round(gen.fx_mid_rate(sell, buy), decimals)
    half = mid * (gen._pulse_spread_bps(sell, buy) / 2 / 10_000)
    bid = round(mid - half, decimals)
    ask = round(mid + half, decimals)
    return {
        "symbol": f"{sell}/{buy}",
        "fromCurrency": sell,
        "toCurrency": buy,
        "rate": mid,
        "bid": bid,
        "ask": ask,
        "fromAmount": round(amount, 2),
        "toAmount": round(amount * mid, 2),
        "inverseRate": round(1 / mid, 8) if mid else None,
        "rateType": "mid",
        "asOf": _iso(_EPOCH),
    }


@base.op(ID, "get_bars")
def get_bars(ctx: Ctx) -> dict:
    """Historical OHLCV aggregates for one instrument at a given resolution."""
    ctx.require("symbol")
    inst = _instrument(ctx, ctx.payload["symbol"])
    resolution = str(ctx.get("resolution", "1h"))
    if resolution not in _RESOLUTIONS:
        raise DomainError(
            422,
            "invalid_resolution",
            f"resolution must be one of {', '.join(_RESOLUTIONS)}",
        )
    count = int(ctx.get("count", 50))
    if count < 1 or count > _MAX_BARS:
        raise DomainError(
            422, "range_too_large", f"count must be between 1 and {_MAX_BARS}"
        )
    bars = _build_bars(inst, resolution, count)
    return {
        "symbol": inst["symbol"],
        "resolution": resolution,
        "count": len(bars),
        "bars": bars,
    }


@base.op(ID, "list_movers")
def list_movers(ctx: Ctx) -> dict:
    """Top gainers and losers across the instrument universe by session change."""
    limit = max(1, min(int(ctx.get("limit", 5)), 25))
    quotes = [_quote(inst, 0) for inst in ctx.state.table("instruments").values()]
    ranked = sorted(quotes, key=lambda q: q["changePct"], reverse=True)
    movers = [
        {
            "symbol": q["symbol"],
            "mid": q["mid"],
            "change": q["change"],
            "changePct": q["changePct"],
            "tickDirection": q["tickDirection"],
        }
        for q in ranked
    ]
    return {
        "gainers": movers[:limit],
        "losers": list(reversed(movers[-limit:])),
        "asOf": _iso(_EPOCH),
    }


@base.op(ID, "get_market_status")
def get_market_status(ctx: Ctx) -> dict:
    """Current trading status of the FX market, its venues, and session schedule."""
    venues = [
        {"venue": "LDN", "region": "Europe", "status": "open"},
        {"venue": "NYC", "region": "Americas", "status": "open"},
        {"venue": "TKY", "region": "Asia", "status": "open"},
        {"venue": "SGP", "region": "Asia", "status": "open"},
    ]
    sessions = [
        {"name": "sydney", "status": "closed", "openUtc": "22:00", "closeUtc": "07:00"},
        {"name": "tokyo", "status": "open", "openUtc": "00:00", "closeUtc": "09:00"},
        {"name": "london", "status": "open", "openUtc": "08:00", "closeUtc": "17:00"},
        {"name": "newyork", "status": "open", "openUtc": "13:00", "closeUtc": "22:00"},
    ]
    return {
        "market": "fx",
        "status": "open",
        "session": "london_newyork_overlap",
        "serverTime": _iso(_EPOCH),
        "venues": venues,
        "sessions": sessions,
        "currencies": sorted(_currencies(ctx)),
        "nextClose": _iso(_EPOCH + timedelta(hours=8)),
        "nextOpen": _iso(_EPOCH + timedelta(hours=56)),
        "earlyClose": False,
    }


@base.op(ID, "get_usage")
def get_usage(ctx: Ctx) -> dict:
    """API plan entitlements, rate-limit window, and quota consumption for the key."""
    active = sum(
        1 for s in ctx.state.table("subscriptions").values() if s["status"] == "active"
    )
    used = len(ctx.state.table("reference_rates")) + active
    return {
        "plan": _PLAN,
        "entitlements": list(_ENTITLEMENTS),
        "rateLimit": {
            "limit": _RATE_LIMIT_PER_MIN,
            "intervalSec": 60,
            "remaining": _RATE_LIMIT_PER_MIN - 1,
        },
        "dailyQuota": {
            "limit": _DAILY_QUOTA,
            "used": used,
            "remaining": _DAILY_QUOTA - used,
            "resetAt": _iso(_EPOCH + timedelta(days=1)),
        },
        "subscriptions": {"limit": _MAX_ACTIVE_SUBS, "active": active},
        "asOf": _iso(_EPOCH),
    }


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
    rows = [
        r for r in ctx.state.table("reference_rates").values() if r["symbol"] == symbol
    ]
    fixing_date = ctx.get("fixingDate")
    if fixing_date:
        rows = [r for r in rows if r["fixingDate"] == fixing_date]
    if not rows:
        raise DomainError(
            404,
            "reference_rate_not_found",
            f"no fixing for {symbol} on {fixing_date or 'any recent date'}",
        )
    return max(rows, key=lambda r: r["fixingDate"])


@base.op(ID, "create_subscription")
def create_subscription(ctx: Ctx) -> dict:
    """Open a streaming subscription to one or more instruments on a channel."""
    symbols = _symbols(ctx)
    if len(symbols) > _MAX_BATCH:
        raise DomainError(
            422,
            "too_many_symbols",
            f"a subscription accepts at most {_MAX_BATCH} instruments",
        )
    channel = str(ctx.get("channel", "quotes"))
    if channel not in _CHANNELS:
        raise DomainError(
            422, "invalid_channel", f"channel must be one of {', '.join(_CHANNELS)}"
        )
    for symbol in symbols:
        _instrument(ctx, symbol)
    table = ctx.state.table("subscriptions")
    active = sum(1 for s in table.values() if s["status"] == "active")
    if active >= _MAX_ACTIVE_SUBS:
        raise DomainError(
            429,
            "subscription_limit_reached",
            f"plan allows at most {_MAX_ACTIVE_SUBS} concurrent subscriptions",
        )
    snapshot_on_subscribe = bool(ctx.get("snapshotOnSubscribe", True))
    conflate_ms = max(0, int(ctx.get("conflateMs", 0)))
    sub_id = base.new_id("sub")
    record = {
        "subscriptionId": sub_id,
        "channel": channel,
        "symbols": symbols,
        "status": "active",
        "deliveryProtocol": "sse",
        "streamUrl": f"/stream?symbol={symbols[0]}&channel={channel}",
        "heartbeatIntervalMs": _HEARTBEAT_MS,
        "snapshotOnSubscribe": snapshot_on_subscribe,
        "conflateMs": conflate_ms,
        "sequenceStart": 0,
        "createdAt": _iso(_EPOCH),
        "updatedAt": _iso(_EPOCH),
        "cancelledAt": None,
    }
    table[sub_id] = record
    return record


@base.op(ID, "update_subscription")
def update_subscription(ctx: Ctx) -> dict:
    """Add or remove instruments on an open subscription without re-handshaking."""
    ctx.require("subscriptionId")
    sub = ctx.state.table("subscriptions").get(ctx.payload["subscriptionId"])
    if sub is None:
        raise DomainError(
            404,
            "subscription_not_found",
            f"no such subscription: {ctx.payload['subscriptionId']}",
        )
    if sub["status"] != "active":
        raise DomainError(
            409,
            "subscription_closed",
            "a cancelled subscription can no longer be modified",
        )
    symbols = list(sub["symbols"])
    for symbol in ctx.get("add") or []:
        symbol = str(symbol).strip()
        _instrument(ctx, symbol)
        if symbol not in symbols:
            symbols.append(symbol)
    remove = {str(s).strip() for s in (ctx.get("remove") or [])}
    symbols = [s for s in symbols if s not in remove]
    if not symbols:
        raise DomainError(
            422, "invalid_request", "a subscription must retain at least one instrument"
        )
    if len(symbols) > _MAX_BATCH:
        raise DomainError(
            422,
            "too_many_symbols",
            f"a subscription accepts at most {_MAX_BATCH} instruments",
        )
    sub["symbols"] = symbols
    sub["updatedAt"] = _iso(_EPOCH)
    return sub


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
        raise DomainError(
            404,
            "subscription_not_found",
            f"no such subscription: {ctx.payload['subscriptionId']}",
        )
    return sub


@base.op(ID, "cancel_subscription")
def cancel_subscription(ctx: Ctx) -> dict:
    """Cancel a streaming subscription; cancelling an already-closed one is a no-op."""
    ctx.require("subscriptionId")
    sub = ctx.state.table("subscriptions").get(ctx.payload["subscriptionId"])
    if sub is None:
        raise DomainError(
            404,
            "subscription_not_found",
            f"no such subscription: {ctx.payload['subscriptionId']}",
        )
    if sub["status"] == "active":
        sub["status"] = "cancelled"
        sub["cancelledAt"] = _iso(_EPOCH)
        sub["updatedAt"] = _iso(_EPOCH)
    return sub


@base.op(ID, "stream_rates")
def stream_rates(ctx: Ctx) -> dict:
    """A finite window of channel events; the SSE surface streams these as events."""
    ctx.require("symbol")
    inst = _instrument(ctx, ctx.payload["symbol"])
    channel = str(ctx.get("channel", "quotes"))
    if channel not in _CHANNELS:
        raise DomainError(
            422, "invalid_channel", f"channel must be one of {', '.join(_CHANNELS)}"
        )
    count = max(1, min(int(ctx.get("ticks", 10)), _MAX_STREAM_TICKS))
    if channel == "trades":
        ticks = [_trade(inst, n) for n in range(count)]
    elif channel == "bars":
        ticks = [_bar_event(inst, n) for n in range(count)]
    else:
        ticks = [_quote(inst, n) for n in range(count)]
    return {
        "symbol": inst["symbol"],
        "channel": channel,
        "count": count,
        "heartbeatIntervalMs": _HEARTBEAT_MS,
        "ticks": ticks,
    }
