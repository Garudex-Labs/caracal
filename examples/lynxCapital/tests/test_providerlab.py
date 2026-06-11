"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Validates the twenty-provider mock ecosystem: taxonomy, per-category authentication, domain behavior, and isolation boundaries.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import time
import uuid
from pathlib import Path

os.environ.setdefault("PROVIDERLAB_FAST", "1")

import caracalai_identity
import caracalai_identity.verify
import pytest
from fastapi.testclient import TestClient

from _mock.providerlab import catalog, credentials, mandate, partnership
from _mock.providerlab.app import build_app

LYNX_ROOT = Path(__file__).resolve().parents[1]


def client(provider_id: str) -> TestClient:
    return TestClient(build_app(catalog.get(provider_id)))


def seed(provider_id: str) -> dict:
    return credentials.load(provider_id).data["seed"]


# --------------------------------------------------------------------------- #
# Taxonomy completeness
# --------------------------------------------------------------------------- #
def test_taxonomy_complete():
    assert catalog.taxonomy_complete()
    assert len(catalog.CATALOG) == 20


def test_every_category_covered():
    expected = {
        "api_key",
        "bearer_token",
        "oauth2_client_credentials",
        "oauth2_authorization_code",
        "caracal_mandate",
        "none",
        "mcp",
        "sdk",
    }
    assert {p.category for p in catalog.CATALOG} == expected
    for category in expected:
        assert len(catalog.BY_CATEGORY[category]) >= 1


def test_every_protocol_covered():
    for proto in ("rest", "grpc", "mcp", "sse", "sdk"):
        assert catalog.BY_PROTOCOL[proto], f"protocol {proto} missing"


def test_ports_unique_and_local_range():
    ports = [p.port for p in catalog.CATALOG]
    assert len(ports) == len(set(ports))
    assert all(9400 <= port <= 9419 for port in ports)


# --------------------------------------------------------------------------- #
# api_key (header and query)
# --------------------------------------------------------------------------- #
def test_api_key_header_accept_and_reject():
    c = client("meridian-pay")
    key = seed("meridian-pay")["apiKey"]
    assert c.post("/api/get_balance", headers={"X-Api-Key": key}).status_code == 200
    assert c.post("/api/get_balance", headers={"X-Api-Key": "bad"}).status_code == 401
    assert c.post("/api/get_balance").status_code == 401


def test_api_key_query_accept_and_reject():
    c = client("inkwell-ocr")
    key = seed("inkwell-ocr")["apiKey"]
    r = c.post(f"/api/submit_document?api_key={key}", json={"fileName": "invoice.pdf"})
    assert r.status_code == 200 and r.json()["data"]["status"] == "processing"
    assert (
        c.post("/api/submit_document?api_key=bad", json={"fileName": "x"}).status_code
        == 401
    )


# --------------------------------------------------------------------------- #
# gRPC (Keystone Treasury) — metadata-token auth, service surface, treasury flows
# --------------------------------------------------------------------------- #
def _keystone():
    c = client("keystone-treasury")
    return c, {seed("keystone-treasury")["field"]: seed("keystone-treasury")["apiKey"]}


def test_grpc_metadata_token_accept_and_reject():
    c, md = _keystone()
    assert seed("keystone-treasury")["field"] == "x-api-key"
    assert (
        c.post("/api/get_position", json={"currency": "USD"}, headers=md).status_code
        == 200
    )
    assert (
        c.post(
            "/api/get_position", json={"currency": "USD"}, headers={"x-api-key": "bad"}
        ).status_code
        == 401
    )
    assert c.post("/api/get_position", json={"currency": "USD"}).status_code == 401


def test_grpc_service_descriptor_registered():
    from _mock.providerlab.providers import base

    descriptor = base.GRPC_SERVICES["keystone-treasury"]
    assert descriptor["package"] == "keystone.treasury.v1"
    rpc_ops = {
        rpc["operation"] for svc in descriptor["services"] for rpc in svc["rpcs"]
    }
    assert set(catalog.get("keystone-treasury").operations) == rpc_ops
    streaming = {
        rpc["operation"]
        for svc in descriptor["services"]
        for rpc in svc["rpcs"]
        if rpc.get("server_streaming")
    }
    assert streaming == {"watch_positions"}


def test_grpc_position_aggregates_accounts():
    c, md = _keystone()
    body = c.post("/api/get_position", json={"currency": "USD"}, headers=md).json()[
        "data"
    ]
    assert body["currency"] == "USD" and body["accountCount"] >= 1
    assert body["availableBalance"] <= body["ledgerBalance"]
    assert body["reportingCurrency"] == "USD"
    assert (
        c.post("/api/get_position", json={"currency": "ZZZ"}, headers=md).status_code
        == 422
    )
    assert (
        c.post("/api/get_position", json={"currency": "CHF"}, headers=md).status_code
        == 404
    )


def test_grpc_forecast_scenarios_and_validation():
    c, md = _keystone()
    ok = c.post(
        "/api/forecast_liquidity",
        json={"currency": "USD", "horizonDays": 30, "scenario": "stress"},
        headers=md,
    )
    assert ok.status_code == 200 and ok.json()["data"]["scenario"] == "stress"
    assert ok.json()["data"]["points"]
    assert (
        c.post(
            "/api/forecast_liquidity",
            json={"currency": "USD", "horizonDays": 0},
            headers=md,
        ).status_code
        == 422
    )
    assert (
        c.post(
            "/api/forecast_liquidity",
            json={"currency": "USD", "horizonDays": 30, "scenario": "wild"},
            headers=md,
        ).status_code
        == 422
    )


def test_grpc_hedge_lifecycle():
    c, md = _keystone()
    placed = c.post(
        "/api/place_hedge",
        json={
            "pair": "EUR/USD",
            "notional": 1_000_000,
            "side": "buy",
            "instrument": "forward",
            "tenorDays": 90,
        },
        headers=md,
    )
    assert placed.status_code == 200
    hedge = placed.json()["data"]
    assert hedge["status"] == "booked" and hedge["notionalCurrency"] == "EUR"
    hid = hedge["hedgeId"]
    cancelled = c.post("/api/cancel_hedge", json={"hedgeId": hid}, headers=md).json()[
        "data"
    ]
    assert cancelled["status"] == "cancelled"
    assert (
        c.post(
            "/api/place_hedge",
            json={"pair": "EUR/USD", "notional": 1_000_000, "side": "hold"},
            headers=md,
        ).status_code
        == 422
    )
    assert (
        c.post(
            "/api/place_hedge",
            json={"pair": "USDUSD", "notional": 1, "side": "buy"},
            headers=md,
        ).status_code
        == 422
    )
    assert (
        c.post("/api/get_hedge", json={"hedgeId": "missing"}, headers=md).status_code
        == 404
    )


def test_grpc_transfer_and_insufficient_liquidity():
    c, md = _keystone()
    ok = c.post(
        "/api/transfer_funds",
        json={"currency": "USD", "amount": 25_000, "destination": "DE"},
        headers=md,
    )
    assert ok.status_code == 200
    transfer = ok.json()["data"]
    assert transfer["type"] == "intercompany" and transfer["status"] == "executed"
    fetched = c.post(
        "/api/get_transfer", json={"transferId": transfer["transferId"]}, headers=md
    )
    assert fetched.status_code == 200
    broke = c.post(
        "/api/transfer_funds",
        json={"currency": "USD", "amount": 9_999_999_999, "destination": "DE"},
        headers=md,
    )
    assert broke.status_code == 402


def test_grpc_exposure_and_streaming():
    c, md = _keystone()
    exposure = c.post("/api/get_exposure", json={"currency": "EUR"}, headers=md)
    assert exposure.status_code == 200
    data = exposure.json()["data"]
    assert {"netExposure", "hedgedAmount", "unhedgedAmount", "hedgeRatio"} <= set(data)
    stream = c.post(
        "/api/watch_positions", json={"currency": "USD", "snapshots": 4}, headers=md
    )
    assert stream.status_code == 200
    payload = stream.json()["data"]
    assert payload["streaming"] is True and len(payload["updates"]) == 4


# --------------------------------------------------------------------------- #
# SSE market data (Pulse Market Data) — quotes, bars, fixings, subscriptions, stream
# --------------------------------------------------------------------------- #
def _pulse():
    c = client("pulse-market")
    return c, {"X-Api-Key": seed("pulse-market")["apiKey"]}


def _pulse_data(c, h, op, body=None):
    return c.post(f"/api/{op}", json=body or {}, headers=h).json()["data"]


def test_pulse_api_key_accept_and_reject():
    c, h = _pulse()
    assert c.post("/api/get_market_status", headers=h).status_code == 200
    assert (
        c.post("/api/get_market_status", headers={"X-Api-Key": "bad"}).status_code
        == 401
    )
    assert c.post("/api/get_market_status").status_code == 401


def test_pulse_instruments_reference_metadata():
    c, h = _pulse()
    listing = _pulse_data(c, h, "list_instruments")
    assert listing["total"] >= 10
    inst = _pulse_data(c, h, "get_instrument", {"symbol": "USD/JPY"})
    for field in (
        "symbol",
        "ticker",
        "baseCurrency",
        "quoteCurrency",
        "assetClass",
        "mid",
        "pip",
        "priceDecimals",
        "spreadBps",
        "contractSize",
        "venue",
    ):
        assert field in inst, field
    # Yen crosses follow the three-decimal market convention.
    assert (
        inst["quoteCurrency"] == "JPY"
        and inst["priceDecimals"] == 3
        and inst["pip"] == 0.01
    )
    eur = _pulse_data(c, h, "get_instrument", {"symbol": "USD/EUR"})
    assert eur["priceDecimals"] == 5 and eur["pip"] == 0.0001
    assert (
        c.post("/api/get_instrument", json={"symbol": "ZZZ/YYY"}, headers=h).status_code
        == 404
    )


def test_pulse_snapshot_and_batch_quotes():
    c, h = _pulse()
    snap = _pulse_data(c, h, "get_snapshot", {"symbol": "USD/EUR"})
    for field in (
        "bid",
        "ask",
        "mid",
        "spread",
        "spreadBps",
        "dayOpen",
        "dayHigh",
        "dayLow",
        "prevClose",
        "change",
        "changePct",
        "volume",
        "timestamp",
    ):
        assert field in snap, field
    assert snap["bid"] < snap["mid"] < snap["ask"]
    assert snap["dayLow"] <= snap["mid"] <= snap["dayHigh"]

    batch = _pulse_data(c, h, "get_quotes", {"symbols": "USD/EUR,USD/JPY,GBP/JPY"})
    assert batch["count"] == 3 and {q["symbol"] for q in batch["quotes"]} == {
        "USD/EUR",
        "USD/JPY",
        "GBP/JPY",
    }
    nf = c.post("/api/get_quotes", json={"symbols": ["USD/EUR", "ZZZ/YYY"]}, headers=h)
    assert nf.status_code == 404 and nf.json()["error"] == "instrument_not_found"
    too_many = c.post("/api/get_quotes", json={"symbols": ["USD/EUR"] * 26}, headers=h)
    assert (
        too_many.status_code == 422 and too_many.json()["error"] == "too_many_symbols"
    )


def test_pulse_bars_resolution_and_range():
    c, h = _pulse()
    bars = _pulse_data(
        c, h, "get_bars", {"symbol": "USD/JPY", "resolution": "5m", "count": 12}
    )
    assert (
        bars["resolution"] == "5m" and bars["count"] == 12 and len(bars["bars"]) == 12
    )
    first = bars["bars"][0]
    assert {"t", "open", "high", "low", "close", "volume"} <= set(first)
    assert first["high"] >= max(first["open"], first["close"])
    assert first["low"] <= min(first["open"], first["close"])
    assert bars["bars"][0]["t"] < bars["bars"][-1]["t"]
    bad_res = c.post(
        "/api/get_bars", json={"symbol": "USD/EUR", "resolution": "2m"}, headers=h
    )
    assert (
        bad_res.status_code == 422 and bad_res.json()["error"] == "invalid_resolution"
    )
    too_long = c.post(
        "/api/get_bars", json={"symbol": "USD/EUR", "count": 5000}, headers=h
    )
    assert too_long.status_code == 422 and too_long.json()["error"] == "range_too_large"


def test_pulse_reference_fixings():
    c, h = _pulse()
    listing = _pulse_data(c, h, "list_reference_rates", {"symbol": "USD/EUR"})
    assert listing["total"] >= 1
    assert all(r["symbol"] == "USD/EUR" for r in listing["items"])
    # Sorted newest-first by fixing date.
    dates = [r["fixingDate"] for r in listing["items"]]
    assert dates == sorted(dates, reverse=True)
    latest = _pulse_data(c, h, "get_reference_rate", {"symbol": "USD/EUR"})
    assert latest["fixingDate"] == dates[0]
    assert latest["source"] == "PULSE_REF" and latest["session"] == "EOD"
    missing = c.post(
        "/api/get_reference_rate",
        json={"symbol": "USD/EUR", "fixingDate": "1999-01-01"},
        headers=h,
    )
    assert (
        missing.status_code == 404
        and missing.json()["error"] == "reference_rate_not_found"
    )


def test_pulse_subscription_lifecycle():
    c, h = _pulse()
    sub = _pulse_data(
        c,
        h,
        "create_subscription",
        {"symbols": ["USD/EUR", "USD/JPY"], "channel": "quotes"},
    )
    assert sub["status"] == "active" and sub["deliveryProtocol"] == "sse"
    assert sub["channel"] == "quotes" and sub["symbols"] == ["USD/EUR", "USD/JPY"]
    sub_id = sub["subscriptionId"]
    assert (
        _pulse_data(c, h, "get_subscription", {"subscriptionId": sub_id})["status"]
        == "active"
    )
    listing = _pulse_data(c, h, "list_subscriptions", {"status": "active"})
    assert any(s["subscriptionId"] == sub_id for s in listing["items"])
    cancelled = _pulse_data(c, h, "cancel_subscription", {"subscriptionId": sub_id})
    assert cancelled["status"] == "cancelled" and cancelled["cancelledAt"]
    # Cancelling again is idempotent.
    assert (
        _pulse_data(c, h, "cancel_subscription", {"subscriptionId": sub_id})["status"]
        == "cancelled"
    )
    bad_channel = c.post(
        "/api/create_subscription",
        json={"symbols": ["USD/EUR"], "channel": "options"},
        headers=h,
    )
    assert (
        bad_channel.status_code == 422
        and bad_channel.json()["error"] == "invalid_channel"
    )
    assert (
        c.post(
            "/api/get_subscription", json={"subscriptionId": "sub_missing"}, headers=h
        ).status_code
        == 404
    )


def test_pulse_stream_emits_typed_events():
    c, h = _pulse()
    with c.stream(
        "GET", "/stream", params={"symbol": "USD/EUR", "ticks": 6}, headers=h
    ) as r:
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        events = []
        for line in r.iter_lines():
            if line.startswith("event:"):
                events.append(line.split(":", 1)[1].strip())
            if len(events) >= 8:
                break
    assert events[0] == "subscribed"
    assert "tick" in events and "heartbeat" in events
    assert c.get("/stream", params={"symbol": "USD/EUR"}).status_code == 401


def test_bearer_standard_header():
    c = client("slate-ledger")
    token = seed("slate-ledger")["bearerToken"]
    body = {"lines": [{"debit": 10}, {"credit": 10}]}
    assert (
        c.post(
            "/api/post_entry", json=body, headers={"Authorization": f"Bearer {token}"}
        ).status_code
        == 200
    )
    assert (
        c.post(
            "/api/post_entry", json=body, headers={"Authorization": "Bearer no"}
        ).status_code
        == 401
    )


def test_bearer_custom_header_scheme():
    c = client("vela-notify")
    token = seed("vela-notify")["bearerToken"]
    body = {"channel": "email", "to": "ops@lynx.example", "template": "remittance"}
    accepted = c.post(
        "/api/send_message", json=body, headers={"X-Vela-Token": f"Token {token}"}
    )
    assert accepted.status_code in (200, 404)  # auth passes; template may be unseeded
    assert (
        c.post(
            "/api/send_message", json=body, headers={"Authorization": f"Bearer {token}"}
        ).status_code
        == 401
    )


# --------------------------------------------------------------------------- #
# oauth2_client_credentials (basic and post)
# --------------------------------------------------------------------------- #
def test_oauth_client_credentials_basic():
    c = client("cordoba-fx")
    s = seed("cordoba-fx")
    basic = base64.b64encode(f"{s['clientId']}:{s['clientSecret']}".encode()).decode()
    tok = c.post(
        "/oauth/token",
        data={"grant_type": "client_credentials", "scope": "fx.read"},
        headers={"Authorization": "Basic " + basic},
    )
    assert tok.status_code == 200
    access = tok.json()["access_token"]
    quote = {"buy_currency": "EUR", "sell_currency": "USD", "amount": 100}
    assert (
        c.post(
            "/api/get_quote", json=quote, headers={"Authorization": f"Bearer {access}"}
        ).status_code
        == 200
    )
    assert (
        c.post(
            "/api/get_quote", json=quote, headers={"Authorization": "Bearer no"}
        ).status_code
        == 401
    )


def test_oauth_client_credentials_post_and_bad_secret():
    c = client("ironbark-erp")
    s = seed("ironbark-erp")
    tok = c.post(
        "/oauth/token",
        data={
            "grant_type": "client_credentials",
            "client_id": s["clientId"],
            "client_secret": s["clientSecret"],
            "scope": "erp.read",
        },
    )
    assert tok.status_code == 200
    bad = c.post(
        "/oauth/token",
        data={
            "grant_type": "client_credentials",
            "client_id": s["clientId"],
            "client_secret": "wrong",
        },
    )
    assert bad.status_code == 401


def _cordoba_token(c, scope: str = "fx.read fx.convert fx.transfer") -> dict:
    s = seed("cordoba-fx")
    basic = base64.b64encode(f"{s['clientId']}:{s['clientSecret']}".encode()).decode()
    access = c.post(
        "/oauth/token",
        data={"grant_type": "client_credentials", "scope": scope},
        headers={"Authorization": "Basic " + basic},
    ).json()["access_token"]
    return {"Authorization": f"Bearer {access}"}


def test_cordoba_quote_schema_and_spread():
    c = client("cordoba-fx")
    h = _cordoba_token(c)
    quote = c.post(
        "/api/get_quote",
        json={
            "buy_currency": "EUR",
            "sell_currency": "USD",
            "amount": 100,
            "fixed_side": "sell",
        },
        headers=h,
    ).json()["data"]
    assert quote["currency_pair"] == "EURUSD"
    assert {
        "client_buy_amount",
        "client_sell_amount",
        "client_rate",
        "mid_market_rate",
        "quote_expiry_time",
    } <= quote.keys()
    # The client rate is worse than mid-market by the spread.
    assert float(quote["client_rate"]) < float(quote["mid_market_rate"])
    # Amounts are decimal strings, as FX platforms emit them.
    assert quote["client_sell_amount"] == "100.00"


def test_cordoba_settlement_lifecycle_end_to_end():
    c = client("cordoba-fx")
    h = _cordoba_token(c)
    conv = c.post(
        "/api/create_conversion",
        json={
            "buy_currency": "EUR",
            "sell_currency": "USD",
            "amount": 5000,
            "fixed_side": "buy",
            "term_agreement": True,
        },
        headers=h,
    ).json()["data"]
    assert conv["status"] == "awaiting_funds" and conv["short_reference"][:8].isdigit()

    ben = c.post(
        "/api/create_beneficiary",
        json={
            "bank_account_holder_name": "Granite Industries",
            "bank_country": "DE",
            "currency": "EUR",
            "iban": "DE89370400440532013000",
            "beneficiary_entity_type": "company",
        },
        headers=h,
    ).json()["data"]
    assert ben["status"] == "enabled" and ben["beneficiary_entity_type"] == "company"

    pay = c.post(
        "/api/create_payment",
        json={
            "currency": "EUR",
            "amount": 5000,
            "beneficiary_id": ben["id"],
            "conversion_id": conv["id"],
            "reference": "INV-9001",
        },
        headers=h,
    ).json()["data"]
    assert pay["status"] == "ready_to_send" and pay["conversion_id"] == conv["id"]

    # Polling advances the payment toward completion.
    after = c.post(
        "/api/get_payment", json={"payment_id": pay["id"]}, headers=h
    ).json()["data"]
    assert after["status"] == "submitted"
    final = c.post(
        "/api/get_payment", json={"payment_id": pay["id"]}, headers=h
    ).json()["data"]
    assert final["status"] == "completed"


def test_cordoba_realistic_validation_errors():
    c = client("cordoba-fx")
    h = _cordoba_token(c)
    no_terms = c.post(
        "/api/create_conversion",
        json={"buy_currency": "EUR", "sell_currency": "USD", "amount": 5000},
        headers=h,
    )
    assert (
        no_terms.status_code == 422
        and no_terms.json()["error"] == "term_agreement_required"
    )

    below = c.post(
        "/api/create_conversion",
        json={
            "buy_currency": "EUR",
            "sell_currency": "USD",
            "amount": 5,
            "fixed_side": "sell",
            "term_agreement": True,
        },
        headers=h,
    )
    assert below.status_code == 422 and below.json()["error"] == "amount_below_minimum"

    unsupported = c.post(
        "/api/get_quote",
        json={"buy_currency": "XAU", "sell_currency": "USD", "amount": 100},
        headers=h,
    )
    assert (
        unsupported.status_code == 422
        and unsupported.json()["error"] == "currency_pair_not_supported"
    )

    missing = c.post(
        "/api/create_payment",
        json={"currency": "EUR", "amount": 100, "beneficiary_id": "ben_missing"},
        headers=h,
    )
    assert (
        missing.status_code == 404
        and missing.json()["error"] == "beneficiary_not_found"
    )


def test_cordoba_seeded_book_present():
    c = client("cordoba-fx")
    h = _cordoba_token(c)
    balances = c.post("/api/list_balances", json={}, headers=h).json()["data"]
    assert balances["total"] >= 1 and all("amount" in b for b in balances["balances"])
    beneficiaries = c.post(
        "/api/list_beneficiaries", json={"currency": "GBP"}, headers=h
    ).json()["data"]
    assert beneficiaries["total"] >= 1
    assert all(b["currency"] == "GBP" for b in beneficiaries["items"])


# --------------------------------------------------------------------------- #
# oauth2_authorization_code (PKCE and refresh)
# --------------------------------------------------------------------------- #
def _authorize_code(
    c: TestClient, s: dict, scope: str, challenge: str | None = None
) -> str:
    data = {
        "client_id": s["clientId"],
        "redirect_uri": "http://127.0.0.1:8000/callback",
        "scope": scope,
        "state": "xyz",
    }
    if challenge:
        data["code_challenge"] = challenge
    r = c.post("/oauth/authorize", data=data, follow_redirects=False)
    return r.headers["location"].split("code=")[1].split("&")[0]


def test_oauth_authorization_code_pkce():
    c = client("halcyon-bank")
    s = seed("halcyon-bank")
    verifier = "verifier-abc123verifier-abc123verifier-xyz"
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        .rstrip(b"=")
        .decode()
    )
    code = _authorize_code(c, s, "accounts.read", challenge)
    tok = c.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "client_id": s["clientId"],
            "client_secret": s["clientSecret"],
            "code_verifier": verifier,
            "redirect_uri": "http://127.0.0.1:8000/callback",
        },
    )
    assert tok.status_code == 200 and "access_token" in tok.json()

    code2 = _authorize_code(c, s, "accounts.read", challenge)
    bad = c.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "code": code2,
            "client_id": s["clientId"],
            "client_secret": s["clientSecret"],
            "code_verifier": "WRONG",
            "redirect_uri": "http://127.0.0.1:8000/callback",
        },
    )
    assert bad.status_code == 400


def test_oauth_authorization_code_refresh():
    c = client("tallyhall-books")
    s = seed("tallyhall-books")
    code = _authorize_code(c, s, "com.intuit.quickbooks.accounting")
    tok = c.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "client_id": s["clientId"],
            "client_secret": s["clientSecret"],
            "redirect_uri": "http://127.0.0.1:8000/callback",
        },
    ).json()
    assert "refresh_token" in tok
    refreshed = c.post(
        "/oauth/token",
        data={
            "grant_type": "refresh_token",
            "refresh_token": tok["refresh_token"],
        },
    )
    assert refreshed.status_code == 200 and "access_token" in refreshed.json()
    # The refresh token is single-use: replaying the consumed one is rejected.
    replay = c.post(
        "/oauth/token",
        data={
            "grant_type": "refresh_token",
            "refresh_token": tok["refresh_token"],
        },
    )
    assert replay.status_code == 400


# --------------------------------------------------------------------------- #
# Halcyon Bank — realistic open-banking authorization and domain scenarios
# --------------------------------------------------------------------------- #
def _halcyon_token(c: TestClient, s: dict, scope: str) -> str:
    verifier = "verifier-abc123verifier-abc123verifier-xyz"
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        .rstrip(b"=")
        .decode()
    )
    code = _authorize_code(c, s, scope, challenge)
    return c.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "client_id": s["clientId"],
            "client_secret": s["clientSecret"],
            "code_verifier": verifier,
            "redirect_uri": "http://127.0.0.1:8000/callback",
        },
    ).json()["access_token"]


def test_halcyon_discovery_metadata_is_complete():
    meta = client("halcyon-bank").get("/.well-known/oauth-authorization-server").json()
    assert meta["response_types_supported"] == ["code"]
    assert meta["code_challenge_methods_supported"] == ["S256"]
    assert meta["token_endpoint"].endswith("/oauth/token")
    assert meta["revocation_endpoint"].endswith("/oauth/revoke")
    assert meta["introspection_endpoint"].endswith("/oauth/introspect")
    assert "client_secret_basic" in meta["token_endpoint_auth_methods_supported"]


def test_halcyon_pkce_required_and_redirect_validated():
    c, s = client("halcyon-bank"), seed("halcyon-bank")
    missing = c.post(
        "/oauth/authorize",
        data={
            "client_id": s["clientId"],
            "redirect_uri": "http://127.0.0.1:8000/callback",
            "scope": "accounts.read",
            "state": "x",
        },
        follow_redirects=False,
    )
    assert missing.status_code == 400 and missing.json()["error"] == "invalid_request"
    bad_redirect = c.post(
        "/oauth/authorize",
        data={
            "client_id": s["clientId"],
            "redirect_uri": "http://attacker.example/cb",
            "scope": "accounts.read",
            "state": "x",
            "code_challenge": "abc",
        },
        follow_redirects=False,
    )
    assert (
        bad_redirect.status_code == 400
        and bad_redirect.json()["error"] == "invalid_redirect_uri"
    )


def test_halcyon_introspection_and_revocation():
    c, s = client("halcyon-bank"), seed("halcyon-bank")
    token = _halcyon_token(c, s, "accounts.read payments.write")
    auth = {"client_id": s["clientId"], "client_secret": s["clientSecret"]}
    active = c.post("/oauth/introspect", data={"token": token, **auth}).json()
    assert active["active"] is True and active["client_id"] == s["clientId"]
    assert c.post("/oauth/revoke", data={"token": token, **auth}).status_code == 200
    assert (
        c.post("/oauth/introspect", data={"token": token, **auth}).json()["active"]
        is False
    )
    assert (
        c.post(
            "/api/list_accounts", json={}, headers={"Authorization": f"Bearer {token}"}
        ).status_code
        == 401
    )


def test_halcyon_account_and_transaction_schema():
    c, s = client("halcyon-bank"), seed("halcyon-bank")
    h = {"Authorization": f"Bearer {_halcyon_token(c, s, 'accounts.read')}"}
    account = c.post("/api/list_accounts", json={}, headers=h).json()["data"]["items"][
        0
    ]
    for field in (
        "accountId",
        "accountType",
        "accountSubType",
        "status",
        "currency",
        "identification",
        "servicer",
        "balances",
    ):
        assert field in account, field
    assert {"available", "booked", "currency"} <= set(account["balances"])
    txn = c.post(
        "/api/list_transactions", json={"accountId": account["accountId"]}, headers=h
    ).json()["data"]["items"][0]
    assert txn["creditDebitIndicator"] in ("Credit", "Debit")
    assert txn["status"] in ("Booked", "Pending")
    for field in (
        "bookingDateTime",
        "valueDateTime",
        "merchantCategoryCode",
        "bankTransactionCode",
    ):
        assert field in txn, field


def test_halcyon_payment_lifecycle_and_idempotency():
    c, s = client("halcyon-bank"), seed("halcyon-bank")
    h = {
        "Authorization": f"Bearer {_halcyon_token(c, s, 'accounts.read payments.write')}"
    }
    account = c.post(
        "/api/list_accounts", json={"status": "Enabled"}, headers=h
    ).json()["data"]["items"][0]
    body = {
        "fromAccount": account["accountId"],
        "amount": 125.50,
        "creditor": "Northwind Holdings",
        "rail": "ACH",
        "reference": "INV-7781",
        "idempotencyKey": "idem-1",
    }
    first = c.post("/api/initiate_payment", json=body, headers=h).json()["data"]
    assert first["status"] == "AcceptedSettlementInProgress"
    assert first["instructedAmount"] == {
        "amount": 125.5,
        "currency": account["currency"],
    }
    replay = c.post("/api/initiate_payment", json=body, headers=h).json()["data"]
    assert replay["paymentId"] == first["paymentId"]
    settled = c.post(
        "/api/get_payment", json={"paymentId": first["paymentId"]}, headers=h
    ).json()["data"]
    assert settled["status"] == "AcceptedSettlementCompleted"


def test_halcyon_payment_edge_cases():
    c, s = client("halcyon-bank"), seed("halcyon-bank")
    h = {
        "Authorization": f"Bearer {_halcyon_token(c, s, 'accounts.read payments.write')}"
    }
    account = c.post(
        "/api/list_accounts", json={"status": "Enabled"}, headers=h
    ).json()["data"]["items"][0]
    aid, currency = account["accountId"], account["currency"]
    missing = c.post(
        "/api/initiate_payment",
        json={"fromAccount": "ACC-9999", "amount": 10, "creditor": "x"},
        headers=h,
    )
    assert missing.status_code == 404 and missing.json()["error"] == "account_not_found"
    negative = c.post(
        "/api/initiate_payment",
        json={"fromAccount": aid, "amount": -5, "creditor": "x"},
        headers=h,
    )
    assert negative.status_code == 422 and negative.json()["error"] == "invalid_amount"
    wrong_ccy = "EUR" if currency != "EUR" else "USD"
    mismatch = c.post(
        "/api/initiate_payment",
        json={"fromAccount": aid, "amount": 10, "creditor": "x", "currency": wrong_ccy},
        headers=h,
    )
    assert (
        mismatch.status_code == 422 and mismatch.json()["error"] == "currency_mismatch"
    )
    overdraw = c.post(
        "/api/initiate_payment",
        json={"fromAccount": aid, "amount": 10**12, "creditor": "x"},
        headers=h,
    )
    assert (
        overdraw.status_code == 402 and overdraw.json()["error"] == "insufficient_funds"
    )


def test_halcyon_statement_resource():
    c, s = client("halcyon-bank"), seed("halcyon-bank")
    h = {"Authorization": f"Bearer {_halcyon_token(c, s, 'accounts.read')}"}
    aid = c.post("/api/list_accounts", json={}, headers=h).json()["data"]["items"][0][
        "accountId"
    ]
    data = c.post("/api/get_statement", json={"accountId": aid}, headers=h).json()[
        "data"
    ]
    latest = data["latest"]
    for field in (
        "statementId",
        "openingBalance",
        "closingBalance",
        "totalCredits",
        "totalDebits",
    ):
        assert field in latest, field
    one = c.post(
        "/api/get_statement",
        json={"accountId": aid, "statementId": latest["statementId"]},
        headers=h,
    ).json()["data"]
    assert one["statementId"] == latest["statementId"]
    assert (
        c.post(
            "/api/get_statement", json={"accountId": "ACC-9999"}, headers=h
        ).status_code
        == 404
    )


def _mint(provider_id: str, **overrides) -> str:
    store = credentials.load(provider_id)
    provider = catalog.get(provider_id)
    base = dict(
        zone=store.data["zone"],
        resource=provider.id,
        scopes=list(provider.scopes),
        subject="lynx-agent",
        session_id="sid_test",
        root_session_id="root_test",
        agent_session_id="agent_test" if provider.require_delegation else None,
        delegation_edge_id="edge_test" if provider.require_delegation else None,
        ttl_seconds=300,
    )
    base.update(overrides)
    claims = mandate.MandateClaims(**base)
    return mandate.sign(claims, store.data["signing_key"])


def test_mandate_valid_and_seed():
    c = client("aegis-screening")
    token = seed("aegis-screening")["mandate"]
    r = c.post(
        "/api/screen_party",
        json={"name": "Acme Trading"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200
    assert (
        c.post(
            "/api/screen_party",
            json={"name": "Acme Trading"},
            headers={"Authorization": "Bearer junk"},
        ).status_code
        == 401
    )


def test_seed_mandate_reissued_when_persisted_token_expires():
    store = credentials.load("aegis-screening")
    stale = _mint("aegis-screening", subject="lynx-bootstrap", ttl_seconds=-10)
    store.data["seed"]["mandate"] = stale
    store._save()
    credentials._cache.pop("aegis-screening", None)
    reloaded = seed("aegis-screening")["mandate"]
    assert reloaded != stale
    c = client("aegis-screening")
    r = c.post(
        "/api/screen_party",
        json={"name": "Acme Trading"},
        headers={"Authorization": f"Bearer {reloaded}"},
    )
    assert r.status_code == 200


def test_mandate_zone_mismatch_rejected():
    c = client("aegis-screening")
    token = _mint("aegis-screening", zone="wrong-zone")
    r = c.post(
        "/api/screen_party",
        json={"name": "x"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 403
    assert r.json()["error"] == "invalid_zone"


def test_mandate_insufficient_scope_rejected():
    c = client("aegis-screening")
    token = _mint("aegis-screening", scopes=[])
    r = c.post(
        "/api/screen_party",
        json={"name": "x"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 403
    assert r.json()["error"] == "insufficient_scope"


def test_mandate_delegation_required_rejected():
    c = client("verafin-monitor")
    token = _mint("verafin-monitor", agent_session_id=None, delegation_edge_id=None)
    r = c.post(
        "/api/monitor_transaction",
        json={"transactionId": "t1", "amount": 10},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 403
    assert r.json()["error"] == "delegation_required"


def test_mandate_revocation_anchor():
    c = client("aegis-screening")
    anchor = f"sid_{uuid.uuid4().hex[:12]}"
    token = _mint("aegis-screening", session_id=anchor)
    assert (
        c.post(
            "/api/screen_party",
            json={"name": "y"},
            headers={"Authorization": f"Bearer {token}"},
        ).status_code
        == 200
    )
    credentials.load("aegis-screening").revoke_mandate_anchor(anchor)
    r = c.post(
        "/api/screen_party",
        json={"name": "y"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 403
    assert r.json()["error"] == "session_revoked"


def test_mandate_resource_use_claim_enforced():
    """The mock verifier mirrors the SDK's required_use=resource check."""
    c = client("aegis-screening")
    session_token = _mint("aegis-screening", use=mandate.USE_SESSION)
    r = c.post(
        "/api/screen_party",
        json={"name": "x"},
        headers={"Authorization": f"Bearer {session_token}"},
    )
    assert r.status_code == 401
    assert r.json()["error"] == "invalid_token"


# --------------------------------------------------------------------------- #
# Caracal STS-issued (ES256) mandates verify through the verifier kit
# --------------------------------------------------------------------------- #
_STS = "http://sts.lab.test"
_ZONE = "lynx-zone"


class _StubJwks:
    def __init__(self, keys: list[dict]):
        self.keys = keys

    async def get_keys(self, issuer: str, zone_id: str | None = None) -> list[dict]:
        return self.keys


@pytest.fixture
def caracal_zone(monkeypatch):
    """A Caracal zone the lab is partnered with: STS keys served from a stub JWKS,
    partnership terms derived from the tenancy model, and a mint helper."""
    import jwt as pyjwt
    from cryptography.hazmat.primitives.asymmetric import ec

    from app import tenancy

    private_key = ec.generate_private_key(ec.SECP256R1())
    jwk = json.loads(pyjwt.algorithms.ECAlgorithm.to_jwk(private_key.public_key()))
    jwk.update({"kid": "sts-key-1", "alg": "ES256", "use": "sig"})
    monkeypatch.setattr(caracalai_identity.verify, "_cache", _StubJwks([jwk]))
    monkeypatch.setenv("CARACAL_STS_URL", _STS)
    monkeypatch.setenv("CARACAL_STS_ISSUER", _STS)
    monkeypatch.setenv("CARACAL_ZONE_ID", _ZONE)
    monkeypatch.setenv(
        partnership.ENV,
        json.dumps(tenancy.partnership_manifest()),
    )

    def mint(audience: str, scope: str, **overrides) -> str:
        now = int(time.time())
        claims = {
            "iss": _STS,
            "aud": audience,
            "sub": "lynx-agent",
            "zone_id": _ZONE,
            "client_id": "app-compliance",
            "sid": f"sid_{uuid.uuid4().hex[:12]}",
            "root_sid": f"root_{uuid.uuid4().hex[:12]}",
            "use": "resource",
            "sub_type": "application",
            "jti": uuid.uuid4().hex,
            "scope": scope,
            "target": [audience],
            "iat": now,
            "exp": now + 300,
        }
        claims.update(overrides)
        claims = {k: v for k, v in claims.items() if v is not None}
        return pyjwt.encode(claims, private_key, algorithm="ES256", headers={"kid": "sts-key-1"})

    return mint


def _caracal_call(provider_id: str, operation: str, token: str, body: dict | None = None):
    return client(provider_id).post(
        f"/api/{operation}", json=body or {}, headers={"Authorization": f"Bearer {token}"}
    )


def test_caracal_mandate_grants_only_partnered_operations(caracal_zone):
    token = caracal_zone("resource://compliance-aegis", "aegis:screen")
    ok = _caracal_call("aegis-screening", "screen_party", token, {"name": "Acme Trading"})
    assert ok.status_code == 200
    blocked = _caracal_call("aegis-screening", "assign_case", token,
                            {"caseId": "c1", "assignee": "x"})
    assert blocked.status_code == 403
    assert blocked.json()["error"] == "insufficient_scope"


def test_caracal_mandate_requires_partnership_terms(caracal_zone, monkeypatch):
    monkeypatch.delenv(partnership.ENV)
    token = caracal_zone("resource://compliance-aegis", "aegis:screen")
    r = _caracal_call("aegis-screening", "screen_party", token, {"name": "x"})
    assert r.status_code == 503
    assert r.json()["error"] == "partnership_unconfigured"


def test_caracal_mandate_audience_pinned_to_partnered_views(caracal_zone):
    token = caracal_zone("resource://ops-relay", "aegis:screen")
    r = _caracal_call("aegis-screening", "screen_party", token, {"name": "x"})
    assert r.status_code == 401
    assert r.json()["error"] == "invalid_token"


def test_caracal_mandate_issuer_pinned(caracal_zone):
    token = caracal_zone("resource://compliance-aegis", "aegis:screen",
                         iss="https://rogue-sts.test")
    r = _caracal_call("aegis-screening", "screen_party", token, {"name": "x"})
    assert r.status_code == 401
    assert r.json()["error"] == "invalid_token"


def test_caracal_mandate_zone_pinned(caracal_zone):
    token = caracal_zone("resource://compliance-aegis", "aegis:screen",
                         zone_id="other-zone")
    r = _caracal_call("aegis-screening", "screen_party", token, {"name": "x"})
    assert r.status_code == 403
    assert r.json()["error"] == "invalid_zone"


def test_caracal_mandate_revocation_enforced(caracal_zone):
    anchor = f"sid_{uuid.uuid4().hex[:12]}"
    token = caracal_zone("resource://compliance-aegis", "aegis:screen", sid=anchor)
    assert _caracal_call("aegis-screening", "screen_party", token,
                         {"name": "y"}).status_code == 200
    credentials.load("aegis-screening").revoke_mandate_anchor(anchor)
    r = _caracal_call("aegis-screening", "screen_party", token, {"name": "y"})
    assert r.status_code == 403
    assert r.json()["error"] == "session_revoked"


def test_caracal_mandate_delegation_requires_edge(caracal_zone):
    undelegated = caracal_zone("resource://compliance-verafin", "verafin:monitor",
                               agent_session_id=f"agent_{uuid.uuid4().hex[:12]}")
    r = _caracal_call("verafin-monitor", "monitor_transaction", undelegated,
                      {"transactionId": "t1", "amount": 10})
    assert r.status_code == 403
    assert r.json()["error"] == "delegation_required"

    delegated = caracal_zone("resource://compliance-verafin", "verafin:monitor",
                             agent_session_id=f"agent_{uuid.uuid4().hex[:12]}",
                             delegation_edge_id=f"edge_{uuid.uuid4().hex[:12]}")
    ok = _caracal_call("verafin-monitor", "monitor_transaction", delegated,
                       {"transactionId": "t1", "amount": 10})
    assert ok.status_code == 200


def test_caracal_mandate_scopes_gate_mcp_provider_operations(caracal_zone):
    reader = caracal_zone(
        "resource://ops-relay", "relay:read",
        agent_session_id=f"agent_{uuid.uuid4().hex[:12]}",
        delegation_edge_id=f"edge_{uuid.uuid4().hex[:12]}",
    )
    assert _caracal_call("relay-automation", "list_workflows", reader).status_code == 200
    blocked = _caracal_call("relay-automation", "start_execution", reader,
                            {"workflowId": "wf1"})
    assert blocked.status_code == 403
    assert blocked.json()["error"] == "insufficient_scope"


def _aegis_client() -> tuple[TestClient, dict]:
    c = client("aegis-screening")
    return c, {"Authorization": f"Bearer {seed('aegis-screening')['mandate']}"}


def _aegis_data(c: TestClient, h: dict, op: str, body: dict) -> dict:
    r = c.post(f"/api/{op}", json=body, headers=h)
    assert r.status_code == 200, (op, r.status_code, r.text)
    return r.json()["data"]


def test_aegis_screening_decisions_and_scoring():
    c, h = _aegis_client()
    clean = _aegis_data(
        c,
        h,
        "screen_party",
        {"name": "Harbor Freight Partners", "type": "organization", "country": "US"},
    )
    assert (
        clean["decision"] == "clear"
        and clean["matchCount"] == 0
        and clean["riskBand"] == "low"
    )

    blocked = _aegis_data(
        c,
        h,
        "screen_party",
        {"name": "Oblast Holdings LLC", "type": "organization", "country": "RU"},
    )
    assert blocked["decision"] == "block"
    assert blocked["riskBand"] == "critical" and blocked["caseId"]
    assert blocked["matches"] and blocked["riskFactors"]
    assert blocked["recommendedAction"] == "reject_and_escalate_edd"

    fuzzy = _aegis_data(c, h, "screen_party", {"name": "Oblast Holdings"})
    assert fuzzy["decision"] in ("review", "block") and fuzzy["matchCount"] >= 1


def test_aegis_case_lifecycle_and_audit_chain():
    c, h = _aegis_client()
    blocked = _aegis_data(
        c,
        h,
        "screen_party",
        {"name": "Rubicon Maritime Trading", "type": "organization", "country": "IR"},
    )
    case_id = blocked["caseId"]

    _aegis_data(c, h, "assign_case", {"caseId": case_id, "assignee": "analyst@aegis"})
    _aegis_data(
        c,
        h,
        "add_case_note",
        {"caseId": case_id, "note": "checking secondary identifiers"},
    )
    trail = _aegis_data(c, h, "get_audit_trail", {"caseId": case_id})
    assert trail["chainIntact"] is True and trail["eventCount"] >= 3

    resolved = _aegis_data(
        c,
        h,
        "resolve_case",
        {"caseId": case_id, "disposition": "true_match", "reason": "confirmed"},
    )
    assert resolved["status"] == "resolved" and resolved["disposition"] == "true_match"

    again = c.post(
        "/api/resolve_case",
        json={"caseId": case_id, "disposition": "true_match"},
        headers=h,
    )
    assert again.status_code == 409
    bad = c.post(
        "/api/resolve_case", json={"caseId": case_id, "disposition": "nope"}, headers=h
    )
    assert bad.status_code == 422


def test_aegis_kyb_and_batch_and_monitoring():
    c, h = _aegis_client()
    kyb = _aegis_data(
        c,
        h,
        "verify_business",
        {
            "legalName": "Northwind Trading Co",
            "country": "US",
            "beneficialOwners": [{"name": "Dana Whitfield", "ownershipPercent": 100}],
        },
    )
    assert kyb["verificationStatus"] in ("verified", "manual_review", "failed")
    assert kyb["entity"]["beneficialOwners"] is not None

    batch = _aegis_data(
        c,
        h,
        "screen_batch",
        {
            "parties": [
                "Harbor Freight Partners",
                {"name": "Crimson Star Logistics", "country": "KP"},
            ]
        },
    )
    assert batch["submitted"] == 2
    assert batch["summary"]["block"] >= 1

    entity_id = kyb["entity"]["entityId"]
    monitor = _aegis_data(
        c, h, "create_monitor", {"entityId": entity_id, "frequency": "weekly"}
    )
    assert monitor["status"] == "active"
    fetched = _aegis_data(c, h, "get_monitor", {"monitorId": monitor["monitorId"]})
    assert fetched["monitorId"] == monitor["monitorId"]
    rescreen = _aegis_data(c, h, "rescreen_entity", {"entityId": entity_id})
    assert "decision" in rescreen and "changed" in rescreen


def test_aegis_reference_listing_and_not_found():
    c, h = _aegis_client()
    watchlists = _aegis_data(c, h, "list_watchlists", {})["watchlists"]
    assert any(w["type"] == "sanctions" for w in watchlists)

    cases = _aegis_data(c, h, "list_cases", {})
    assert cases["total"] >= 1 and "items" in cases
    assert _aegis_data(c, h, "list_screenings", {})["total"] >= 1

    assert (
        c.post("/api/get_case", json={"caseId": "case_missing"}, headers=h).status_code
        == 404
    )
    assert (
        c.post(
            "/api/get_entity", json={"entityId": "ent_missing"}, headers=h
        ).status_code
        == 404
    )


def test_aegis_scope_step_up_enforced():
    """A read-only mandate cannot run a screening."""
    c = client("aegis-screening")
    read_only = _mint("aegis-screening", scopes=["screening.read", "cases.read"])
    r = c.post(
        "/api/screen_party",
        json={"name": "x"},
        headers={"Authorization": f"Bearer {read_only}"},
    )
    assert r.status_code == 403
    assert r.json()["error"] == "insufficient_scope"


# --------------------------------------------------------------------------- #
# none (internal)
# --------------------------------------------------------------------------- #
def test_internal_provider_needs_no_credential():
    c = client("core-billing")
    r = c.post("/api/get_ar_aging", json={})
    assert r.status_code == 200
    assert seed("lumen-identity")["credential"] is None


def _cb(c: TestClient, op: str, payload: dict | None = None):
    return c.post(f"/api/{op}", json=payload or {})


def test_core_billing_aging_reconciles_with_invoices():
    c = client("core-billing")
    aging = _cb(c, "get_ar_aging").json()["data"]
    assert set(aging["buckets"]) == {"current", "1-30", "31-60", "61-90", "90+"}
    invoices, page = [], 1
    while True:
        body = _cb(c, "list_invoices", {"page": page, "pageSize": 100}).json()["data"]
        invoices.extend(body["items"])
        if not body["hasMore"]:
            break
        page += 1
    open_due = round(
        sum(
            i["amountDue"]
            for i in invoices
            if i["status"] in ("open", "overdue", "partiallyPaid", "disputed")
        ),
        2,
    )
    assert open_due == pytest.approx(aging["total"], abs=0.05)


def test_core_billing_invoice_lifecycle_and_cash_application():
    c = client("core-billing")
    cust = _cb(c, "list_customers", {"status": "active", "pageSize": 1}).json()["data"][
        "items"
    ][0]
    cid = cust["customerId"]
    inv = _cb(c, "create_invoice", {"customerId": cid, "amount": 1000}).json()["data"]
    assert inv["status"] == "open" and inv["amountDue"] == inv["total"]

    partial = _cb(
        c, "apply_payment", {"invoiceId": inv["invoiceId"], "amount": 400}
    ).json()["data"]
    assert partial["invoiceStatus"] == "partiallyPaid" and partial[
        "remaining"
    ] == round(inv["total"] - 400, 2)

    settle = _cb(
        c,
        "apply_payment",
        {"invoiceId": inv["invoiceId"], "amount": partial["remaining"]},
    ).json()["data"]
    assert settle["invoiceStatus"] == "paid" and settle["remaining"] == 0.0

    # A paid invoice cannot be dunned or re-paid.
    assert _cb(c, "issue_dunning", {"invoiceId": inv["invoiceId"]}).status_code == 409
    assert (
        _cb(
            c, "apply_payment", {"invoiceId": inv["invoiceId"], "amount": 1}
        ).status_code
        == 409
    )


def test_core_billing_record_payment_oldest_first():
    c = client("core-billing")
    # Find a customer carrying two or more open invoices.
    customers = _cb(c, "list_customers", {"pageSize": 100}).json()["data"]["items"]
    target = None
    for cust in customers:
        body = _cb(
            c, "list_invoices", {"customerId": cust["customerId"], "overdue": True}
        ).json()["data"]
        if body["total"] >= 2:
            target = (cust["customerId"], body["items"])
            break
    assert target, "expected a customer with multiple overdue invoices in the seed"
    cid, _ = target
    pay = _cb(c, "record_payment", {"customerId": cid, "amount": 250}).json()["data"]
    assert pay["allocations"] and pay["appliedAmount"] == pytest.approx(250, abs=0.05)
    oldest = min(pay["allocations"], key=lambda a: a["invoiceId"])
    assert oldest["amount"] > 0


def test_core_billing_dispute_blocks_dunning_then_credit_memo():
    c = client("core-billing")
    overdue = _cb(c, "list_invoices", {"overdue": True, "pageSize": 5}).json()["data"][
        "items"
    ]
    inv = overdue[0]
    disputed = _cb(
        c,
        "dispute_invoice",
        {"invoiceId": inv["invoiceId"], "reason": "service_outage"},
    ).json()["data"]
    assert disputed["status"] == "disputed"
    assert _cb(c, "issue_dunning", {"invoiceId": inv["invoiceId"]}).status_code == 409

    memo = _cb(
        c,
        "issue_credit_memo",
        {"customerId": inv["customerId"], "amount": 50, "reason": "goodwill"},
    ).json()["data"]
    # Credit memo requires the invoice not be in a closed state; dispute is still open.
    applied = _cb(
        c,
        "apply_credit_memo",
        {"creditMemoId": memo["creditMemoId"], "invoiceId": inv["invoiceId"]},
    ).json()["data"]
    assert applied["applied"] > 0


def test_core_billing_summary_and_audit_trail():
    c = client("core-billing")
    summary = _cb(c, "get_ar_summary").json()["data"]
    for key in (
        "totalReceivable",
        "overdueReceivable",
        "daysSalesOutstanding",
        "invoicesByStatus",
        "writtenOffAmount",
        "openCollectionCases",
    ):
        assert key in summary
    assert summary["totalReceivable"] >= summary["overdueReceivable"]

    # Issuing an invoice writes an audit event discoverable by entity.
    cust = _cb(c, "list_customers", {"status": "active", "pageSize": 1}).json()["data"][
        "items"
    ][0]
    inv = _cb(
        c, "create_invoice", {"customerId": cust["customerId"], "amount": 500}
    ).json()["data"]
    trail = _cb(c, "get_audit_trail", {"entityId": inv["invoiceId"]}).json()["data"]
    assert any(e["action"] == "invoice.issued" for e in trail["items"])


# --------------------------------------------------------------------------- #
# mcp (bearer and mandate guarded)
# --------------------------------------------------------------------------- #
def _mcp_call(
    c: TestClient, method: str, headers: dict, params: dict | None = None
) -> dict:
    body = {"jsonrpc": "2.0", "id": 1, "method": method}
    if params is not None:
        body["params"] = params
    return c.post("/mcp", json=body, headers=headers)


def test_mcp_bearer_guarded():
    c = client("atlas-vendor")
    token = seed("atlas-vendor")["bearerToken"]
    assert (
        _mcp_call(c, "tools/list", {"Authorization": f"Bearer {token}"}).status_code
        == 200
    )
    assert _mcp_call(c, "tools/list", {"Authorization": "Bearer no"}).status_code == 401


def test_mcp_tool_call_runs_domain():
    c = client("atlas-vendor")
    token = seed("atlas-vendor")["bearerToken"]
    r = _mcp_call(
        c,
        "tools/call",
        {"Authorization": f"Bearer {token}"},
        {"name": "search_vendors", "arguments": {"query": "a"}},
    )
    result = r.json()["result"]
    assert result["isError"] is False
    assert "items" in result["structuredContent"]
    assert result["content"][0]["type"] == "text"


def test_mcp_initialize_advertises_capabilities():
    c = client("atlas-vendor")
    token = seed("atlas-vendor")["bearerToken"]
    result = _mcp_call(c, "initialize", {"Authorization": f"Bearer {token}"}).json()[
        "result"
    ]
    assert result["protocolVersion"] == "2025-06-18"
    assert result["serverInfo"]["title"] == "Atlas Vendor Network"
    assert "tools" in result["capabilities"] and "resources" in result["capabilities"]
    assert "instructions" in result


def test_mcp_tools_list_carries_schemas():
    c = client("atlas-vendor")
    token = seed("atlas-vendor")["bearerToken"]
    tools = _mcp_call(c, "tools/list", {"Authorization": f"Bearer {token}"}).json()[
        "result"
    ]["tools"]
    by_name = {t["name"]: t for t in tools}
    register = by_name["register_vendor"]
    assert register["inputSchema"]["required"] == ["country"]
    assert by_name["get_vendor_profile"]["annotations"]["readOnlyHint"] is True
    assert by_name["set_vendor_status"]["annotations"]["destructiveHint"] is True


def test_mcp_resources_discoverable():
    c = client("atlas-vendor")
    token = seed("atlas-vendor")["bearerToken"]
    headers = {"Authorization": f"Bearer {token}"}
    resources = _mcp_call(c, "resources/list", headers).json()["result"]["resources"]
    uris = {r["uri"] for r in resources}
    assert "atlas://onboarding/queue" in uris
    read = _mcp_call(
        c, "resources/read", headers, {"uri": "atlas://vendors/directory"}
    ).json()["result"]
    assert read["contents"][0]["uri"] == "atlas://vendors/directory"


def test_mcp_tool_error_is_structured():
    c = client("atlas-vendor")
    token = seed("atlas-vendor")["bearerToken"]
    r = _mcp_call(
        c,
        "tools/call",
        {"Authorization": f"Bearer {token}"},
        {"name": "get_vendor_profile", "arguments": {"vendorId": "VEND-99999"}},
    )
    result = r.json()["result"]
    assert result["isError"] is True
    assert "vendor_not_found" in result["content"][0]["text"]


def test_mcp_onboarding_lifecycle():
    c = client("atlas-vendor")
    token = seed("atlas-vendor")["bearerToken"]
    headers = {"Authorization": f"Bearer {token}"}

    def call(name, args):
        return _mcp_call(
            c, "tools/call", headers, {"name": name, "arguments": args}
        ).json()["result"]["structuredContent"]

    created = call(
        "register_vendor", {"legalName": "Northwind Robotics", "country": "US"}
    )
    vid = created["id"]
    assert created["status"] == "pending_review"
    for step in ("tax", "kyb", "banking", "documents", "approval"):
        progress = call("advance_onboarding", {"vendorId": vid, "step": step})
    assert progress["onboarding"]["status"] == "completed"
    profile = call("get_vendor_profile", {"vendorId": vid})
    assert profile["status"] == "active"


def test_mcp_mandate_guarded():
    c = client("relay-automation")
    token = seed("relay-automation")["mandate"]
    assert (
        _mcp_call(c, "tools/list", {"Authorization": f"Bearer {token}"}).status_code
        == 200
    )
    assert _mcp_call(c, "tools/list", {}).status_code == 401


def _relay():
    c = client("relay-automation")
    headers = {"Authorization": f"Bearer {seed('relay-automation')['mandate']}"}

    def call(name, args=None):
        result = _mcp_call(
            c, "tools/call", headers, {"name": name, "arguments": args or {}}
        ).json()["result"]
        if result.get("isError"):
            return {"_error": result["content"][0]["text"]}
        return result["structuredContent"]

    return c, headers, call


def test_relay_catalog_and_resources():
    c, headers, call = _relay()
    tools = _mcp_call(c, "tools/list", headers).json()["result"]["tools"]
    names = {t["name"] for t in tools}
    assert {
        "start_execution",
        "get_execution",
        "signal_execution",
        "retry_execution",
        "cancel_execution",
        "get_execution_audit",
    } <= names
    by_name = {t["name"]: t for t in tools}
    assert by_name["cancel_execution"]["annotations"]["destructiveHint"] is True
    assert by_name["list_workflows"]["annotations"]["readOnlyHint"] is True

    workflows = call("list_workflows")
    assert workflows["total"] == 6
    assert workflows["items"][0]["stepCount"] >= 4

    resources = {
        r["uri"]
        for r in _mcp_call(c, "resources/list", headers).json()["result"]["resources"]
    }
    assert "relay://executions/active" in resources


def test_relay_execution_traceable_to_mandate():
    _, _, call = _relay()
    ex = call(
        "start_execution",
        {"workflowId": "statement_reconciliation", "input": {"day": "2026-06-01"}},
    )
    audit = call("get_execution_audit", {"executionId": ex["executionId"]})
    # The dispatching mandate subject and delegation edge are recorded for traceability.
    assert audit["trigger"]["subject"] == "lynx-bootstrap"
    assert audit["trigger"]["delegationEdgeId"]
    assert audit["events"][0]["type"] == "execution_queued"
    assert audit["chainIntact"] is True


def test_relay_idempotent_dispatch():
    _, _, call = _relay()
    a = call(
        "start_execution", {"workflowId": "dunning_cycle", "idempotencyKey": "run-77"}
    )
    b = call(
        "start_execution", {"workflowId": "dunning_cycle", "idempotencyKey": "run-77"}
    )
    assert a["executionId"] == b["executionId"]
    assert b["idempotentReplay"] is True


def test_relay_approval_signal_resumes_run():
    _, _, call = _relay()
    ex = call(
        "start_execution", {"workflowId": "payout_release", "input": {"batch": "B-1"}}
    )
    eid = ex["executionId"]
    # Drive the run to its human-approval gate, retrying past any injected transient
    # fault that lands before the approval step.
    status = ex["status"]
    for _ in range(20):
        if status == "waiting_signal":
            break
        if status in ("failed", "timed_out"):
            status = call("retry_execution", {"executionId": eid})["status"]
            continue
        status = call("get_execution", {"executionId": eid})["status"]
    assert status == "waiting_signal"
    resumed = call(
        "signal_execution", {"executionId": eid, "signal": "approve", "note": "ok"}
    )
    assert resumed["status"] in ("running", "succeeded")
    for _ in range(20):
        g = call("get_execution", {"executionId": eid})
        if g["status"] in ("succeeded", "cancelled"):
            break
        if g["status"] in ("failed", "timed_out"):
            call("retry_execution", {"executionId": eid})
    logs = call("get_execution_logs", {"executionId": eid})
    approval = next(s for s in logs["steps"] if s["type"] == "approval")
    assert approval["status"] == "completed"


def test_relay_failed_execution_can_retry():
    _, _, call = _relay()
    failed = call("list_executions", {"status": "failed"})
    assert failed["total"] >= 1
    fid = failed["items"][0]["executionId"]
    retried = call("retry_execution", {"executionId": fid})
    assert retried["status"] == "running"
    assert retried["attempt"] == 2


def test_relay_cancel_terminal_rejected():
    _, _, call = _relay()
    done = call("list_executions", {"status": "succeeded"})
    eid = done["items"][0]["executionId"]
    assert (
        "execution_terminal" in call("cancel_execution", {"executionId": eid})["_error"]
    )


def test_relay_queue_concurrency_reported():
    _, _, call = _relay()
    queues = {q["queue"]: q for q in call("list_queues")["items"]}
    assert queues["payments"]["concurrencyLimit"] == 1
    assert "payout_release" in queues["payments"]["workflows"]
    assert call("get_execution", {"executionId": "exec_missing"})["_error"].startswith(
        "execution_not_found"
    )


# --------------------------------------------------------------------------- #
# sdk (first-party SDK shim over HTTP: api-key or bearer secret per provider)
# --------------------------------------------------------------------------- #
def test_sdk_providers_authenticate():
    cases = {
        "sabre-tax": (
            "calculate_tax",
            {
                "addresses": {"shipTo": {"country": "US", "region": "CA"}},
                "lines": [{"number": "1", "amount": 100.0}],
            },
            {"X-Api-Key": seed("sabre-tax")["apiKey"]},
            {"X-Api-Key": "bad"},
        ),
        "quetzal-payouts": (
            "get_quote",
            {"amount": 100.0, "sourceCurrency": "USD", "targetCurrency": "EUR"},
            {"Authorization": f"Bearer {seed('quetzal-payouts')['bearerToken']}"},
            {"Authorization": "Bearer bad"},
        ),
    }
    for pid, (op, body, good, bad) in cases.items():
        c = client(pid)
        assert c.post(f"/api/{op}", json=body, headers=good).status_code == 200
        assert c.post(f"/api/{op}", json=body, headers=bad).status_code == 401


# --------------------------------------------------------------------------- #
# Within-type pairs cover distinct realistic cases
# --------------------------------------------------------------------------- #
def test_api_key_pair_distinct_cases():
    # Meridian Pay: synchronous write with idempotent replay.
    pay = client("meridian-pay")
    h = {"X-Api-Key": seed("meridian-pay")["apiKey"]}
    body = {
        "amount": 100,
        "currency": "USD",
        "source": "tok_visa",
        "idempotencyKey": "idem-1",
    }
    first = pay.post("/api/create_charge", json=body, headers=h).json()["data"]
    second = pay.post("/api/create_charge", json=body, headers=h).json()["data"]
    assert first["chargeId"] == second["chargeId"]
    bad = pay.post(
        "/api/create_charge",
        json={"amount": -5, "currency": "USD", "source": "s"},
        headers=h,
    )
    assert bad.status_code == 422 and bad.json()["error"] == "invalid_amount"
    # Inkwell OCR: asynchronous extraction lifecycle (processing -> extracted).
    ocr = client("inkwell-ocr")
    okey = seed("inkwell-ocr")["apiKey"]
    started = ocr.post(
        f"/api/submit_document?api_key={okey}", json={"fileName": "a.pdf"}
    ).json()["data"]
    assert started["status"] == "processing"
    done = ocr.post(
        f"/api/get_extraction?api_key={okey}",
        json={"documentId": started["documentId"]},
    ).json()["data"]
    assert done["status"] == "extracted" and "fields" in done


def test_meridian_card_decline_and_capture_flow():
    pay = client("meridian-pay")
    h = {"X-Api-Key": seed("meridian-pay")["apiKey"]}
    # A canonical decline token is rejected the way a real card gateway would (402).
    declined = pay.post(
        "/api/create_charge",
        json={"amount": 80, "currency": "USD", "source": "tok_chargeDeclined"},
        headers=h,
    )
    assert declined.status_code == 402 and declined.json()["error"] == "card_declined"
    # Authorize-then-capture: an uncaptured charge settles on explicit capture.
    auth = pay.post(
        "/api/create_charge",
        json={
            "amount": 250.0,
            "currency": "usd",
            "source": "tok_visa",
            "capture": False,
        },
        headers=h,
    ).json()["data"]
    assert auth["status"] == "requires_capture" and auth["paid"] is False
    assert auth["paymentMethodDetails"]["card"]["brand"] == "visa"
    captured = pay.post(
        "/api/capture_charge", json={"chargeId": auth["chargeId"]}, headers=h
    ).json()["data"]
    assert captured["status"] == "succeeded" and captured["net"] < captured["amount"]


def test_meridian_settlement_links_payout_and_dispute_evidence():
    pay = client("meridian-pay")
    h = {"X-Api-Key": seed("meridian-pay")["apiKey"]}
    settlements = pay.post("/api/list_settlements", json={}, headers=h).json()["data"][
        "items"
    ]
    assert settlements, "seeded settlements expected"
    settlement = settlements[0]
    payout = pay.post(
        "/api/get_payout", json={"payoutId": settlement["payoutId"]}, headers=h
    ).json()["data"]
    assert payout["settlementId"] == settlement["settlementId"]
    assert settlement["netAmount"] == round(
        settlement["grossAmount"]
        - settlement["feeAmount"]
        - settlement["refundAmount"],
        2,
    )
    # An open dispute accepts evidence and transitions to review.
    disputes = pay.post("/api/list_disputes", json={}, headers=h).json()["data"][
        "items"
    ]
    openable = next(
        (
            d
            for d in disputes
            if d["status"] in ("warning_needs_response", "needs_response")
        ),
        None,
    )
    if openable is not None:
        reviewed = pay.post(
            "/api/submit_dispute_evidence",
            json={
                "disputeId": openable["disputeId"],
                "evidence": {"customerCommunication": "emails attached"},
            },
            headers=h,
        ).json()["data"]
        assert (
            reviewed["status"] == "under_review"
            and reviewed["evidenceDetails"]["hasEvidence"] is True
        )


def test_bearer_pair_distinct_cases():
    # Slate Ledger: double-entry validation rejects an unbalanced entry.
    ldg = client("slate-ledger")
    h = {"Authorization": f"Bearer {seed('slate-ledger')['bearerToken']}"}
    bad = ldg.post(
        "/api/post_entry", json={"lines": [{"debit": 10}, {"credit": 5}]}, headers=h
    )
    assert bad.status_code == 422 and bad.json()["error"] == "unbalanced"
    good = ldg.post(
        "/api/post_entry", json={"lines": [{"debit": 10}, {"credit": 10}]}, headers=h
    )
    assert good.json()["data"]["status"] == "posted"
    # Vela Notify: custom-scheme bearer, channel validation.
    mail = client("vela-notify")
    mh = {"X-Vela-Token": f"Token {seed('vela-notify')['bearerToken']}"}
    bad_ch = mail.post(
        "/api/send_message",
        json={"channel": "fax", "to": "x", "template": "t"},
        headers=mh,
    )
    assert bad_ch.status_code == 422 and bad_ch.json()["error"] == "invalid_channel"


def test_oauth_cc_pair_distinct_cases():
    # Cordoba FX: scope step-up — fx.read token cannot convert.
    c = client("cordoba-fx")
    s = seed("cordoba-fx")
    read = c.post(
        "/oauth/token",
        data={
            "grant_type": "client_credentials",
            "client_id": s["clientId"],
            "client_secret": s["clientSecret"],
            "scope": "fx.read",
        },
    ).json()["access_token"]
    h = {"Authorization": f"Bearer {read}"}
    assert (
        c.post(
            "/api/get_quote",
            json={"buy_currency": "EUR", "sell_currency": "USD", "amount": 1},
            headers=h,
        ).status_code
        == 200
    )
    denied = c.post(
        "/api/create_conversion",
        json={
            "buy_currency": "EUR",
            "sell_currency": "USD",
            "amount": 100,
            "term_agreement": True,
        },
        headers=h,
    )
    assert denied.status_code == 403 and denied.json()["error"] == "insufficient_scope"
    # Ironbark ERP: post-auth token, vendor not-found case.
    e = client("ironbark-erp")
    es = seed("ironbark-erp")
    tok = e.post(
        "/oauth/token",
        data={
            "grant_type": "client_credentials",
            "client_id": es["clientId"],
            "client_secret": es["clientSecret"],
            "scope": "erp.read",
        },
    ).json()["access_token"]
    nf = e.post(
        "/api/get_vendor",
        json={"vendorId": "V-DOES-NOT-EXIST"},
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert nf.status_code == 404


def test_oauth_ac_pair_distinct_cases():
    # Halcyon Bank: accounts.read token cannot initiate a payment (needs payments.write).
    c = client("halcyon-bank")
    s = seed("halcyon-bank")
    verifier = "verifier-abc123verifier-abc123verifier-xyz"
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        .rstrip(b"=")
        .decode()
    )
    code = _authorize_code(c, s, "accounts.read", challenge)
    tok = c.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "client_id": s["clientId"],
            "client_secret": s["clientSecret"],
            "code_verifier": verifier,
            "redirect_uri": "http://127.0.0.1:8000/callback",
        },
    ).json()["access_token"]
    h = {"Authorization": f"Bearer {tok}"}
    assert c.post("/api/list_accounts", json={}, headers=h).status_code == 200
    denied = c.post(
        "/api/initiate_payment",
        json={"fromAccount": "ACC-1", "amount": 10, "creditor": "x"},
        headers=h,
    )
    assert denied.status_code == 403 and denied.json()["error"] == "insufficient_scope"
    # Beacon CRM: refresh-capable auth-code provider issues a usable token.
    lc = client("beacon-crm")
    ls = seed("beacon-crm")
    lcode = _authorize_code(lc, ls, "contacts.read")
    ltok = lc.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "code": lcode,
            "client_id": ls["clientId"],
            "client_secret": ls["clientSecret"],
            "redirect_uri": "http://127.0.0.1:8000/callback",
        },
    ).json()
    assert "access_token" in ltok and "refresh_token" in ltok


def test_internal_pair_distinct_cases():
    # Core Billing: invoice not-found.
    b = client("core-billing")
    assert b.post("/api/get_invoice", json={"invoiceId": "missing"}).status_code == 404
    # Lumen Identity: pagination over the directory.
    idn = client("lumen-identity")
    page1 = idn.post("/api/list_users", json={"page": 1, "pageSize": 10}).json()["data"]
    assert page1["page"] == 1 and len(page1["items"]) <= 10


def test_lumen_identity_directory_model():
    idn = client("lumen-identity")

    # Employee records carry enterprise identity fields and resolve to an org node.
    ceo = idn.post("/api/get_user", json={"userId": "EMP-1001"}).json()["data"]
    for field in (
        "username",
        "userPrincipalName",
        "displayName",
        "status",
        "employmentType",
        "jobTitle",
        "departmentId",
        "teamId",
        "costCenter",
        "roleIds",
        "groupIds",
        "mfaEnabled",
        "hireDate",
    ):
        assert field in ceo, f"missing employee field {field}"
    assert ceo["managerId"] is None  # CEO sits at the top of the chart

    # Users are resolvable by username / email, not only by id.
    by_email = idn.post("/api/get_user", json={"userId": ceo["workEmail"]}).json()[
        "data"
    ]
    assert by_email["id"] == ceo["id"]
    assert (
        idn.post("/api/get_user", json={"userId": "EMP-does-not-exist"}).status_code
        == 404
    )

    # Effective access resolves directly-assigned and group-derived roles into permissions.
    access = idn.post("/api/get_user_access", json={"userId": "EMP-1001"}).json()[
        "data"
    ]
    assert "directory:read" in access["permissions"]
    assert access["privileged"] is True

    # Org chart: manager chain walks up to the CEO; direct reports resolve downward.
    chain = idn.post("/api/get_manager_chain", json={"userId": "EMP-1002"}).json()[
        "data"
    ]
    assert chain["chain"] and chain["chain"][-1]["id"] == "EMP-1001"
    reports = idn.post(
        "/api/list_direct_reports", json={"managerId": "EMP-1001"}
    ).json()["data"]
    assert reports["count"] >= 1

    # RBAC roles expose permission grants and category; lookups 404 cleanly.
    role = idn.post("/api/get_role", json={"roleId": "ROLE-treasury-manager"}).json()[
        "data"
    ]
    assert (
        "payments:approve" in role["permissions"] and role["category"] == "privileged"
    )
    assert idn.post("/api/get_role", json={"roleId": "ROLE-nope"}).status_code == 404

    # Groups, teams, and departments are first-class and cross-referenced.
    grp = idn.post("/api/get_group", json={"groupId": "GRP-treasury-operators"}).json()[
        "data"
    ]
    assert grp["type"] == "access" and grp["members"] and grp["roleIds"]
    team = idn.post("/api/get_team", json={"teamId": "TEAM-ap"}).json()["data"]
    assert team["managerId"] and team["memberIds"]
    dept = idn.post(
        "/api/get_department", json={"departmentId": "DEPT-finance"}
    ).json()["data"]
    assert dept["headEmployeeId"] and dept["teamIds"]

    # Service accounts are governed: owner, roles, scopes, environment, rotation.
    svc = idn.post(
        "/api/get_service_account", json={"serviceAccountId": "SVC-ap-bot"}
    ).json()["data"]
    for field in (
        "ownerTeamId",
        "ownerEmployeeId",
        "roleIds",
        "scopes",
        "environment",
        "status",
        "secretRotatedAt",
        "secretExpiresAt",
    ):
        assert field in svc, f"missing service-account field {field}"
    assert (
        idn.post(
            "/api/get_service_account", json={"serviceAccountId": "SVC-nope"}
        ).status_code
        == 404
    )


def test_lumen_identity_filters_and_listing():
    idn = client("lumen-identity")

    # Listing is filterable on enterprise dimensions.
    finance = idn.post(
        "/api/list_users", json={"departmentId": "DEPT-finance", "pageSize": 100}
    ).json()["data"]
    assert finance["total"] >= 1
    assert all(u["departmentId"] == "DEPT-finance" for u in finance["items"])

    active = idn.post(
        "/api/list_users", json={"status": "active", "pageSize": 100}
    ).json()["data"]
    assert all(u["status"] == "active" for u in active["items"])

    # Privileged-role catalog and access-group views.
    priv = idn.post("/api/list_roles", json={"category": "privileged"}).json()["data"]
    assert priv["items"] and all(r["category"] == "privileged" for r in priv["items"])
    access_groups = idn.post("/api/list_groups", json={"type": "access"}).json()["data"]
    assert all(g["type"] == "access" for g in access_groups["items"])

    prod_svc = idn.post(
        "/api/list_service_accounts", json={"environment": "production"}
    ).json()["data"]
    assert prod_svc["items"] and all(
        s["environment"] == "production" for s in prod_svc["items"]
    )

    # Free-text lookup over the directory.
    hit = idn.post("/api/lookup_user", json={"query": "@lynxcapital.example"}).json()[
        "data"
    ]
    assert hit["total"] >= 1


def test_sdk_pair_distinct_cases():
    # Sabre Tax: multi-jurisdiction determination, treaty withholding, and not-found.
    t = client("sabre-tax")
    tk = {"X-Api-Key": seed("sabre-tax")["apiKey"]}
    calc = t.post(
        "/api/calculate_tax",
        json={
            "addresses": {"shipTo": {"country": "US", "region": "NY"}},
            "lines": [
                {"number": "1", "amount": 1000, "taxCode": "P0000000"},
                {"number": "2", "amount": 200, "taxCode": "NT"},
            ],
        },
        headers=tk,
    ).json()["data"]
    assert calc["status"] == "Saved" and calc["totalTax"] > 0
    assert calc["totalExempt"] == 200.0 and any(
        s["jurisType"] == "City" for s in calc["summary"]
    )
    # A booked transaction can be retrieved, committed, and voided.
    got = t.post("/api/get_transaction", json={"code": calc["code"]}, headers=tk)
    assert got.status_code == 200
    assert (
        t.post(
            "/api/commit_transaction", json={"code": calc["code"]}, headers=tk
        ).json()["data"]["status"]
        == "Committed"
    )
    # Treaty withholding: Germany royalties drop to 0%, treaty-less Brazil stays statutory 30%.
    de = t.post(
        "/api/determine_withholding",
        json={
            "paymentType": "royalties",
            "grossAmount": 10000,
            "payee": {
                "country": "DE",
                "documentationType": "W-8BEN",
                "treatyClaim": True,
            },
        },
        headers=tk,
    ).json()["data"]
    assert de["withholdingRate"] == 0.0 and de["isTreatyApplicable"]
    br = t.post(
        "/api/determine_withholding",
        json={
            "paymentType": "royalties",
            "payee": {
                "country": "BR",
                "documentationType": "W-8BEN",
                "treatyClaim": True,
            },
        },
        headers=tk,
    ).json()["data"]
    assert br["withholdingRate"] == pytest.approx(0.30)
    # Tax-ID validation and an unresolvable jurisdiction.
    vat = t.post(
        "/api/validate_tax_id",
        json={"taxId": "DE123456789", "country": "DE"},
        headers=tk,
    ).json()["data"]
    assert vat["isValid"] and vat["businessName"]
    nf = t.post(
        "/api/resolve_jurisdiction", json={"address": {"country": "ZZ"}}, headers=tk
    )
    assert nf.status_code == 404
    # Quetzal Payouts: unverified recipient is blocked; KYC verification unlocks the
    # payout, which then advances through its delivery lifecycle on status reads.
    q = client("quetzal-payouts")
    qk = {"Authorization": f"Bearer {seed('quetzal-payouts')['bearerToken']}"}
    rec = q.post(
        "/api/create_recipient",
        json={"name": "R", "currency": "EUR", "method": "bank"},
        headers=qk,
    ).json()["data"]
    blocked = q.post(
        "/api/create_payout",
        json={"recipientId": rec["id"], "amount": 100, "currency": "USD"},
        headers=qk,
    )
    assert (
        blocked.status_code == 403 and blocked.json()["error"] == "recipient_unverified"
    )
    verified = q.post(
        "/api/verify_recipient", json={"recipientId": rec["id"]}, headers=qk
    ).json()["data"]
    assert verified["verified"] is True
    payout = q.post(
        "/api/create_payout",
        json={
            "recipientId": rec["id"],
            "amount": 100,
            "currency": "USD",
            "purpose": "supplier invoice",
        },
        headers=qk,
    ).json()["data"]
    assert payout["status"] == "processing" and payout["purposeCode"] == "SUPP"
    tracked = q.post(
        "/api/get_payout", json={"payoutId": payout["payoutId"]}, headers=qk
    ).json()["data"]
    assert tracked["status"] in ("in_transit", "paid")


def test_mandate_pair_distinct_cases():
    # Aegis Screening: returns a decision.
    a = client("aegis-screening")
    h = {"Authorization": f"Bearer {seed('aegis-screening')['mandate']}"}
    dec = a.post(
        "/api/screen_party", json={"name": "Oblast Holdings"}, headers=h
    ).json()["data"]
    assert dec["decision"] in ("clear", "review", "block")
    # Verafin Monitor: scope step-up — monitoring token cannot prepare a filing.
    v = client("verafin-monitor")
    mon_only = _mint("verafin-monitor", scopes=["monitoring.run"])
    denied = v.post(
        "/api/prepare_filing",
        json={"alertId": "a1", "filingType": "SAR"},
        headers={"Authorization": f"Bearer {mon_only}"},
    )
    assert denied.status_code == 403


# --------------------------------------------------------------------------- #
# Credential lifecycle
# --------------------------------------------------------------------------- #
def test_api_key_lifecycle_create_and_revoke():
    store = credentials.load("meridian-pay")
    rec = store.create_api_key("ci-temp")
    assert store.valid_api_key(rec["apiKey"])
    assert store.revoke("apiKey", rec["keyId"])
    assert not store.valid_api_key(rec["apiKey"])


def test_control_ui_create_credential_via_form():
    c = client("meridian-pay")
    r = c.post(
        "/__lab/api/create-credential",
        data={"kind": "apiKey", "label": "ui-temp"},
        follow_redirects=False,
    )
    assert r.status_code == 303
    store = credentials.load("meridian-pay")
    created = [k for k in store.data["apiKeys"] if k["label"] == "ui-temp"]
    assert created and store.valid_api_key(created[0]["apiKey"])


def test_api_key_rotate_supersedes_old():
    store = credentials.load("meridian-pay")
    original = store.create_api_key("rotate-me")
    fresh = store.rotate("apiKey", original["keyId"])
    assert fresh is not None
    assert fresh["apiKey"] != original["apiKey"]
    assert fresh["rotatedFrom"] == original["keyId"]
    assert fresh["label"] == "rotate-me"
    assert store.valid_api_key(fresh["apiKey"])
    assert not store.valid_api_key(original["apiKey"])
    history_ids = {h["id"] for h in store.revoked_history()}
    assert original["keyId"] in history_ids


def test_rotate_via_form_endpoint():
    c = client("slate-ledger")
    store = credentials.load("slate-ledger")
    rec = store.create_bearer("form-rotate")
    r = c.post(
        "/__lab/api/rotate",
        data={"kind": "bearer", "id": rec["tokenId"]},
        follow_redirects=False,
    )
    assert r.status_code == 303
    assert not store.valid_bearer(rec["accessToken"])


def test_validate_endpoint_reports_validity():
    c = client("meridian-pay")
    store = credentials.load("meridian-pay")
    rec = store.create_api_key("validate-me")
    good = c.post(
        "/__lab/api/validate", data={"kind": "apiKey", "secret": rec["apiKey"]}
    )
    assert good.json()["valid"] is True
    bad = c.post(
        "/__lab/api/validate", data={"kind": "apiKey", "secret": "ak_not_real"}
    )
    assert bad.json()["valid"] is False


def test_usage_telemetry_recorded_on_call():
    c = client("meridian-pay")
    seed_key = seed("meridian-pay")["apiKey"]
    c.post("/api/get_balance", headers={"X-Api-Key": seed_key}, json={})
    store = credentials.load("meridian-pay")
    used = [k for k in store.data["apiKeys"] if k["apiKey"] == seed_key]
    assert used and used[0].get("useCount", 0) >= 1


def test_oauth_client_usage_telemetry_recorded_on_call():
    c = client("cordoba-fx")
    c.post("/api/get_quote",
           json={"buy_currency": "EUR", "sell_currency": "USD", "amount": 100},
           headers=_cordoba_token(c))
    store = credentials.load("cordoba-fx")
    used = [r for r in store.data["clients"] if r["clientId"] == seed("cordoba-fx")["clientId"]]
    assert used and used[0].get("useCount", 0) >= 1
    assert used[0].get("lastUsedAt")


def test_overview_shows_configuration_and_status():
    c = client("cordoba-fx")
    body = c.get("/").text
    assert "Configuration" in body
    assert "Token endpoint" in body
    assert "Status" in body
    assert "operational" in body


def test_secrets_masked_in_credentials_ui():
    c = client("meridian-pay")
    body = c.get("/__lab/credentials").text
    assert "toggleSecret" in body
    assert 'class="secret"' in body
    seed_key = seed("meridian-pay")["apiKey"]
    # the live value is only carried for reveal-on-click, never shown as bare text
    assert f"<span>{seed_key}</span>" not in body
    assert f'data-value="{seed_key}"' in body


# --------------------------------------------------------------------------- #
# UI pages render
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "path", ["/", "/__lab/credentials", "/__lab/clients", "/__lab/api-clients"]
)
def test_ui_pages_render(path):
    c = client("cordoba-fx")
    r = c.get(path)
    assert r.status_code == 200
    assert "Cordoba FX" in r.text


# --------------------------------------------------------------------------- #
# External-feel network behavior
# --------------------------------------------------------------------------- #
def test_responses_carry_request_id_header():
    c = client("meridian-pay")
    r = c.post(
        "/api/get_balance", headers={"X-Api-Key": seed("meridian-pay")["apiKey"]}
    )
    assert "X-Request-Id" in r.headers


# --------------------------------------------------------------------------- #
# Isolation boundaries
# --------------------------------------------------------------------------- #
def _app_python_files() -> list[Path]:
    return list((LYNX_ROOT / "app").rglob("*.py"))


def test_no_mock_logic_leaks_outside_mock():
    for path in _app_python_files():
        text = path.read_text(encoding="utf-8")
        assert "providerlab" not in text, f"mock reference leaked into {path}"
        assert "from _mock" not in text and "import _mock" not in text, (
            f"_mock import in {path}"
        )


def test_caracal_sdk_usage_confined_to_seam():
    seam = LYNX_ROOT / "app" / "caracal.py"
    forbidden = re.compile(r"from caracalai|import caracalai")
    for path in _app_python_files():
        if path == seam:
            continue
        assert not forbidden.search(path.read_text(encoding="utf-8")), (
            f"Direct SDK import outside app/caracal.py in {path}"
        )


def test_caracal_sdk_pinned_in_dependencies():
    text = (LYNX_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    assert "caracalai-sdk==0.1.5rc2" in text
    assert "caracalai-identity==0.1.5rc2" in text
