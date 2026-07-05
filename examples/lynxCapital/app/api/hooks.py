"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Webhook intake: receives signed callbacks from external providers, verifies
HMAC signatures, deduplicates events, and republishes them on the bus.
"""

from __future__ import annotations

import hmac
import os
import threading
import time
from collections import deque
from hashlib import sha256

from fastapi import APIRouter, Header, HTTPException, Request

from app.events.bus import bus
from app.events.types import Event


router = APIRouter(prefix="/hooks", tags=["webhooks"])


_SECRET_ENV = {
    "halcyon-bank": "LYNX_HALCYON_HOOK_SECRET",
    "meridian-pay": "LYNX_MERIDIAN_HOOK_SECRET",
    "quetzal-payouts": "LYNX_QUETZAL_HOOK_SECRET",
    "inkwell-ocr": "LYNX_INKWELL_HOOK_SECRET",
    "beacon-crm": "LYNX_BEACON_HOOK_SECRET",
}


_TOLERANCE_S = 5 * 60


class _Dedup:
    """Webhook event-id dedup. Backed by Redis when LYNX_REDIS_URL is set;
    otherwise an in-process bounded LRU. Redis-backed entries expire after
    `_TOLERANCE_S * 2` seconds, matching the upstream replay window."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._seen: deque[str] = deque(maxlen=4096)
        self._set: set[str] = set()
        self._redis = None
        url = os.getenv("LYNX_REDIS_URL")
        if url:
            import redis

            self._redis = redis.Redis.from_url(url, decode_responses=True)

    def seen(self, event_id: str) -> bool:
        if self._redis is not None:
            key = f"lynx:hook:seen:{event_id}"
            added = self._redis.set(key, "1", nx=True, ex=_TOLERANCE_S * 2)
            return added is None
        with self._lock:
            if event_id in self._set:
                return True
            self._seen.append(event_id)
            self._set.add(event_id)
            if (
                len(self._seen) == self._seen.maxlen
                and len(self._set) > self._seen.maxlen
            ):
                self._set.intersection_update(self._seen)
            return False


_dedup = _Dedup()


def _secret(provider: str) -> str:
    env = _SECRET_ENV.get(provider)
    if env is None:
        raise HTTPException(
            status_code=404, detail={"error": f"unknown provider: {provider}"}
        )
    val = os.getenv(env)
    if not val:
        raise HTTPException(
            status_code=503, detail={"error": f"webhook secret missing: {env}"}
        )
    return val


def _parse_signature(header: str) -> tuple[str, str]:
    parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
    return parts.get("t", ""), parts.get("v1", "")


def _verify(provider: str, body: bytes, header: str) -> None:
    ts, mac = _parse_signature(header or "")
    if not ts or not mac:
        raise HTTPException(status_code=400, detail={"error": "malformed signature"})
    try:
        if abs(time.time() - int(ts)) > _TOLERANCE_S:
            raise HTTPException(status_code=400, detail={"error": "stale signature"})
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"error": "bad timestamp"}) from exc
    expected = hmac.new(
        _secret(provider).encode(), f"{ts}.".encode() + body, sha256
    ).hexdigest()
    if not hmac.compare_digest(expected, mac):
        raise HTTPException(status_code=401, detail={"error": "signature mismatch"})


@router.post("/{provider}")
async def receive(
    provider: str,
    request: Request,
    x_lynx_signature: str = Header(default=""),
    x_lynx_event_id: str = Header(default=""),
) -> dict:
    body = await request.body()
    _verify(provider, body, x_lynx_signature)
    event_id = x_lynx_event_id or sha256(body).hexdigest()
    if _dedup.seen(event_id):
        return {"ack": True, "deduped": True}
    try:
        payload = await request.json()
    except Exception:
        payload = {"raw": body.decode("utf-8", errors="replace")}
    bus.publish(
        Event(
            run_id="webhook",
            category="service",
            kind="webhook.received",
            payload={"provider": provider, "event_id": event_id, "body": payload},
        )
    )
    return {"ack": True}


def required_secret_envs() -> list[str]:
    return list(_SECRET_ENV.values())
