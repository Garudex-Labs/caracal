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


_DEFAULT_SECRETS = {
    "mercury-bank":         "LYNX_MERCURY_HOOK_SECRET",
    "wise-payouts":         "LYNX_WISE_HOOK_SECRET",
    "stripe-treasury":      "LYNX_STRIPE_HOOK_SECRET",
    "netsuite":             "LYNX_NETSUITE_HOOK_SECRET",
    "sap-erp":              "LYNX_SAP_HOOK_SECRET",
    "ocr-vision":           "LYNX_OCR_HOOK_SECRET",
    "close-engine":         "LYNX_CLOSE_HOOK_SECRET",
    "regulatory-filings":   "LYNX_REGULATORY_HOOK_SECRET",
    "customer-billing":     "LYNX_BILLING_HOOK_SECRET",
    "compliance-nexus":     "LYNX_COMPLIANCE_HOOK_SECRET",
    "treasury-ops":         "LYNX_TREASURY_HOOK_SECRET",
}


_SEEN: deque[str] = deque(maxlen=4096)
_SEEN_SET: set[str] = set()
_SEEN_LOCK = threading.Lock()
_TOLERANCE_S = 5 * 60


def _secret(provider: str) -> str:
    env = _DEFAULT_SECRETS.get(provider)
    if env is None:
        raise HTTPException(status_code=404, detail={"error": f"unknown provider: {provider}"})
    return os.getenv(env, f"dev-{provider}-secret")


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
    expected = hmac.new(_secret(provider).encode(), f"{ts}.".encode() + body, sha256).hexdigest()
    if not hmac.compare_digest(expected, mac):
        raise HTTPException(status_code=401, detail={"error": "signature mismatch"})


def _dedupe(event_id: str) -> bool:
    with _SEEN_LOCK:
        if event_id in _SEEN_SET:
            return True
        _SEEN.append(event_id)
        _SEEN_SET.add(event_id)
        if len(_SEEN) == _SEEN.maxlen and len(_SEEN_SET) > _SEEN.maxlen:
            _SEEN_SET.intersection_update(_SEEN)
        return False


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
    if _dedupe(event_id):
        return {"ack": True, "deduped": True}
    try:
        payload = await request.json()
    except Exception:
        payload = {"raw": body.decode("utf-8", errors="replace")}
    bus.publish(Event(
        run_id="webhook",
        category="service",
        kind="webhook.received",
        payload={"provider": provider, "event_id": event_id, "body": payload},
    ))
    return {"ack": True}
