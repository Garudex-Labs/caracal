"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Long-lived stream consumer that bridges the Pulse Market Data SSE feed onto the in-process event bus.
"""
from __future__ import annotations

import asyncio
import json
import os
import threading

import httpx

from app import caracal, tenancy
from app.events.bus import bus
from app.events.types import Event
from app.services.partners import simulation_enabled

PULSE_VIEW = "resource://treasury-pulse"
STREAM_ROLE = "route-optimization"

_stop = threading.Event()
_threads: list[threading.Thread] = []


def _publish_tick(data: dict) -> None:
    bus.publish(Event(run_id="streams", category="service", kind="market.tick", payload=data))


def _handle_line(line: str, event: str) -> str:
    """Feed one SSE line through the parser state, publishing tick payloads."""
    if not line:
        return "message"
    if line.startswith("event:"):
        return line[6:].strip()
    if line.startswith("data:") and event == "tick":
        _publish_tick(json.loads(line[5:].strip()))
    return event


def _consume_governed(symbol: str) -> None:
    asyncio.run(_governed_stream(symbol))


async def _governed_stream(symbol: str) -> None:
    """Consume the Pulse feed through the Caracal Gateway. The consumer runs as a
    labeled treasury agent session whose delegation edge is narrowed to pulse:read on
    the treasury view; the Gateway validates its mandate and injects the provider
    credential, so this process never holds the partner API key."""
    rt = caracal.runtime("treasury")
    async with rt.client.spawn(
        labels=["dispatcher", "lynx-swarm"],
        metadata={"service": "market-stream"},
    ) as root:
        while not _stop.is_set():
            try:
                await _stream_once(rt, root, symbol)
            except Exception:
                if _stop.is_set():
                    return
                await asyncio.sleep(2.0)


async def _stream_once(rt: caracal.AppRuntime, root: caracal.CaracalContext, symbol: str) -> None:
    async with rt.client.spawn(
        grant=caracal.worker_grant(["pulse:read"], [PULSE_VIEW]),
        labels=tenancy.agent_labels(STREAM_ROLE),
        metadata={"service": "market-stream", "provider": "pulse-market"},
        parent_ctx=root,
        ttl_seconds=caracal.WORKER_TTL_SECONDS,
    ) as ctx:
        token = rt.client.mint_mandate(
            PULSE_VIEW, ["pulse:read"], ctx=ctx, ttl_seconds=caracal.MANDATE_TTL_SECONDS
        )
        async with httpx.AsyncClient(timeout=None) as http:
            async with http.stream(
                "GET",
                f"{rt.gateway_url}/stream",
                headers={"Authorization": f"Bearer {token}", "X-Caracal-Resource": PULSE_VIEW},
                params={"symbol": symbol, "ticks": 50},
            ) as resp:
                event = "message"
                async for line in resp.aiter_lines():
                    if _stop.is_set():
                        return
                    event = _handle_line(line, event)


def _consume_direct(url: str, api_key: str, symbol: str) -> None:
    headers = {"X-Api-Key": api_key}
    params = {"symbol": symbol, "ticks": 50}
    while not _stop.is_set():
        try:
            with httpx.stream("GET", f"{url}/stream", headers=headers, params=params, timeout=None) as resp:
                event = "message"
                for line in resp.iter_lines():
                    if _stop.is_set():
                        return
                    event = _handle_line(line, event)
        except Exception:
            if _stop.is_set():
                return
            _stop.wait(2.0)


def start_streams() -> None:
    """Start the market feed consumer. With Caracal configured the feed flows through
    the Gateway under a governed agent session; otherwise the direct simulated-provider
    path requires explicit LYNX_SIMULATION, mirroring the partner dispatch gate."""
    symbol = os.getenv("LYNX_PULSE_SYMBOL", "USD/EUR")
    if caracal.enabled():
        target, args = _consume_governed, (symbol,)
    else:
        if not simulation_enabled():
            return
        url = os.getenv("LYNX_PARTNER_PULSE_MARKET_URL")
        api_key = os.getenv("LYNX_PARTNER_PULSE_MARKET_API_KEY")
        if not url or not api_key:
            return
        target, args = _consume_direct, (url, api_key, symbol)
    t = threading.Thread(target=target, args=args, name="pulse-market-sse", daemon=True)
    t.start()
    _threads.append(t)


def stop_streams() -> None:
    _stop.set()
    for t in _threads:
        t.join(timeout=2.0)
    _threads.clear()
    _stop.clear()
