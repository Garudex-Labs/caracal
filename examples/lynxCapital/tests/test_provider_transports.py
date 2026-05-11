"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

End-to-end provider transport tests: REST, async-job, SDK, SSE, gRPC, MCP,
and webhook delivery — each driven over a real local socket.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import os
import threading
import time
from hashlib import sha256

import httpx
import pytest

from app.services import registry


# ----- REST sync ----------------------------------------------------------

def test_rest_sync_balance(rest_url):
    registry.reset()
    r = registry.call("mercury-bank", "get_account_balance", {"vendor_id": "V1"})
    assert "balance" in r
    assert r["currency"] == "USD"


def test_rest_idempotent_replay(rest_url):
    registry.reset()
    a = registry.call("mercury-bank", "submit_payment",
                      {"vendor_id": "V1", "amount": 100, "currency": "USD",
                       "rail": "ACH", "reference": "ref-x"})
    b = registry.call("mercury-bank", "submit_payment",
                      {"vendor_id": "V1", "amount": 100, "currency": "USD",
                       "rail": "ACH", "reference": "ref-x"})
    assert a == b


def test_rest_unauthenticated(rest_url, monkeypatch):
    monkeypatch.setenv("LYNX_MERCURY_KEY", "")
    registry.reset()
    with pytest.raises(Exception):
        registry.call("mercury-bank", "get_account_balance", {"vendor_id": "V1"})
    monkeypatch.setenv("LYNX_MERCURY_KEY", "dev-mercury-bank-key")
    registry.reset()


# ----- REST async-job -----------------------------------------------------

def test_rest_async_job_completes(rest_url):
    registry.reset()
    r = registry.call("netsuite", "match_invoice",
                      {"vendor_id": "V1", "invoice_id": "INV-1",
                       "amount": 100, "currency": "USD"})
    assert r["matched"] in (True, False)
    assert "erp_ref" in r


def test_rest_async_job_ocr(rest_url):
    registry.reset()
    r = registry.call("ocr-vision", "extract_invoice",
                      {"invoice_id": "INV-1", "document_ref": "doc1"})
    assert "confidence" in r


# ----- SDK clients (Stripe + Tax) -----------------------------------------

def test_sdk_stripe_financial_account(rest_url):
    registry.reset()
    r = registry.call("stripe-treasury", "get_financial_account", {"vendor_id": "V1"})
    assert "financial_account_id" in r


def test_sdk_tax_withholding(rest_url):
    registry.reset()
    r = registry.call("tax-rules", "get_withholding_rate",
                      {"region": "US", "vendor_type": "service",
                       "amount": 1000, "currency": "USD"})
    assert "withholding_pct" in r


# ----- gRPC unary ---------------------------------------------------------

def test_grpc_treasury_unary(treasury_grpc):
    registry.reset()
    r = registry.call("treasury-ops", "get_cash_position", {"region": "us"})
    assert isinstance(r, dict)
    assert any(k in r for k in ("total_usd", "by_account", "balance_usd", "cash_usd"))


def test_grpc_treasury_unauth(treasury_grpc, monkeypatch):
    monkeypatch.setenv("LYNX_TREASURY_KEY", "")
    registry.reset()
    with pytest.raises(Exception):
        registry.call("treasury-ops", "get_cash_position", {"region": "us"})
    monkeypatch.setenv("LYNX_TREASURY_KEY", "dev-treasury-ops-key")
    registry.reset()


# ----- MCP ----------------------------------------------------------------

def test_mcp_vendor_portal(vendor_mcp):
    registry.reset()
    r = registry.call("vendor-portal", "get_vendor_profile", {"vendor_id": "V1"})
    assert isinstance(r, dict)


# ----- SSE streaming ------------------------------------------------------

def test_sse_fx_stream_resume(fx_stream_url):
    received: list[dict] = []
    done = threading.Event()

    def on_event(event: str, data: dict) -> None:
        if event == "rate":
            received.append(data)
            if len(received) >= 3:
                done.set()

    from app.services.transport.sse import SseConsumer
    sse = SseConsumer(
        provider="fx-rates",
        url=fx_stream_url,
        auth_header="X-API-Key",
        auth_env="LYNX_FX_KEY",
        on_event=on_event,
    )
    sse.start()
    assert done.wait(timeout=10.0), "SSE consumer received no events"
    sse.stop()
    assert all("pair" in r and "rate" in r for r in received[:3])


# ----- Webhook intake -----------------------------------------------------

def _sign_webhook(provider: str, body: bytes, secret: str) -> tuple[str, str]:
    ts = str(int(time.time()))
    mac = hmac.new(secret.encode(), f"{ts}.".encode() + body, sha256).hexdigest()
    return ts, f"t={ts},v1={mac}"


def test_webhook_intake_verifies_and_dedupes(monkeypatch):
    from fastapi import FastAPI

    from app.api.hooks import router as hooks_router

    app = FastAPI()
    app.include_router(hooks_router)

    monkeypatch.setenv("LYNX_MERCURY_HOOK_SECRET", "test-secret")
    body = json.dumps({"event": "payment.completed", "id": "TX-1"}).encode()
    _, sig = _sign_webhook("mercury-bank", body, "test-secret")

    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="http://app.test") as client:
            r1 = await client.post("/hooks/mercury-bank", content=body,
                                   headers={"X-Lynx-Signature": sig, "X-Lynx-Event-Id": "evt-1",
                                            "Content-Type": "application/json"})
            assert r1.status_code == 200, r1.text
            assert r1.json() == {"ack": True}

            r2 = await client.post("/hooks/mercury-bank", content=body,
                                   headers={"X-Lynx-Signature": sig, "X-Lynx-Event-Id": "evt-1",
                                            "Content-Type": "application/json"})
            assert r2.json().get("deduped") is True

            bad = await client.post("/hooks/mercury-bank", content=body,
                                    headers={"X-Lynx-Signature": "t=0,v1=deadbeef",
                                             "Content-Type": "application/json"})
            assert bad.status_code in (400, 401)

    asyncio.run(run())


# ----- Determinism --------------------------------------------------------

def test_rest_determinism(rest_url):
    registry.reset()
    payload = {"vendor_id": "V42"}
    first = registry.call("mercury-bank", "get_account_balance", payload)
    second = registry.call("mercury-bank", "get_account_balance", payload)
    assert first == second
