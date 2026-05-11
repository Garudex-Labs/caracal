"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

fx-rates streaming server: server-sent events emitting deterministic rate ticks.
"""
from __future__ import annotations

import asyncio
import json
import time
from hashlib import sha256

from fastapi import FastAPI, HTTPException, Request
from sse_starlette.sse import EventSourceResponse

from _mock.faults import evaluate
from _mock.faults.engine import profile_for


app = FastAPI(title="mock:fx-rates-stream")


@app.get("/healthz")
async def healthz() -> dict:
    return {"status": "ok"}


def _rate(pair: str, tick: int) -> dict:
    h = sha256(f"{pair}|{tick}".encode()).hexdigest()
    drift = (int(h[:8], 16) % 2000 - 1000) / 1_000_000.0
    base = {"USDEUR": 0.92, "USDGBP": 0.79, "USDINR": 83.2, "EURUSD": 1.087}.get(pair, 1.0)
    return {
        "pair": pair,
        "rate": round(base * (1 + drift), 6),
        "tick": tick,
        "ts": time.time(),
        "venue": "fx-rates.mock",
    }


@app.get("/v1/stream")
async def stream(request: Request, pairs: str = "USDEUR,USDGBP,USDINR"):
    profile = profile_for("fx-rates")
    auth = profile["auth"]
    expected = (request.headers.get(auth["header"]) or "").removeprefix(auth.get("prefix") or "")
    if not expected:
        raise HTTPException(status_code=401, detail={"error": "fx-rates: missing credential"})
    pair_list = [p.strip() for p in pairs.split(",") if p.strip()]
    last_id = request.headers.get("last-event-id")
    start_tick = int(last_id) + 1 if last_id and last_id.isdigit() else 0

    async def gen():
        tick = start_tick
        while True:
            if await request.is_disconnected():
                break
            decision = evaluate("fx-rates", "stream_tick", {"tick": tick}, attempt=0, api_key=expected)
            if decision.error_status and decision.error_status >= 500:
                yield {"event": "error", "data": json.dumps({"error": "stream interrupted"})}
                break
            for pair in pair_list:
                yield {"id": str(tick), "event": "rate", "data": json.dumps(_rate(pair, tick))}
            tick += 1
            await asyncio.sleep(0.25)

    return EventSourceResponse(gen())
