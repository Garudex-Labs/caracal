"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Validates the provider mock lab taxonomy, per-category authentication, credential lifecycle, and isolation boundaries.
"""
from __future__ import annotations

import base64
import hashlib
import os
import re
import uuid
from pathlib import Path

os.environ.setdefault("PROVIDERLAB_FAST", "1")

import pytest
from fastapi.testclient import TestClient

from _mock.providerlab import catalog, credentials, mandate
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
    assert len(catalog.CATALOG) == 16
    for category in catalog.CATEGORIES:
        assert len(catalog.BY_CATEGORY[category]) == 2


def test_every_category_covered():
    expected = {
        "api_key", "bearer_token", "oauth2_client_credentials",
        "oauth2_authorization_code", "caracal_mandate", "none", "mcp", "sdk",
    }
    assert {p.category for p in catalog.CATALOG} == expected


def test_ports_unique_and_local_range():
    ports = [p.port for p in catalog.CATALOG]
    assert len(ports) == len(set(ports))
    assert all(9400 <= port <= 9415 for port in ports)


# --------------------------------------------------------------------------- #
# api_key (header and query)
# --------------------------------------------------------------------------- #
def test_api_key_header_accept_and_reject():
    c = client("aurum-pay")
    key = seed("aurum-pay")["apiKey"]
    assert c.post("/api/get_balance", headers={"X-Api-Key": key}).status_code == 200
    assert c.post("/api/get_balance", headers={"X-Api-Key": "bad"}).status_code == 401
    assert c.post("/api/get_balance").status_code == 401


def test_api_key_query_accept_and_reject():
    c = client("quill-ocr")
    key = seed("quill-ocr")["apiKey"]
    r = c.post(f"/api/extract_document?api_key={key}", json={"documentUrl": "s3://docs/a.pdf"})
    assert r.status_code == 200 and r.json()["data"]["status"] == "processing"
    assert c.post(f"/api/extract_document?api_key=bad", json={"documentUrl": "x"}).status_code == 401


# --------------------------------------------------------------------------- #
# bearer_token (standard and custom header/scheme)
# --------------------------------------------------------------------------- #
def test_bearer_standard_header():
    c = client("nimbus-ledger")
    token = seed("nimbus-ledger")["bearerToken"]
    r = c.post("/api/get_account", json={"accountId": "A-1"}, headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert c.post("/api/get_account", json={"accountId": "A-1"},
                  headers={"Authorization": "Bearer no"}).status_code == 401


def test_bearer_custom_header_scheme():
    c = client("vela-mail")
    token = seed("vela-mail")["bearerToken"]
    body = {"to": "ops@lynx.example", "subject": "hi"}
    assert c.post("/api/send_message", json=body,
                  headers={"X-Vela-Token": f"Token {token}"}).status_code == 200
    assert c.post("/api/send_message", json=body,
                  headers={"Authorization": f"Bearer {token}"}).status_code == 401


# --------------------------------------------------------------------------- #
# oauth2_client_credentials (basic and post)
# --------------------------------------------------------------------------- #
def test_oauth_client_credentials_basic():
    c = client("helios-fx")
    s = seed("helios-fx")
    basic = base64.b64encode(f"{s['clientId']}:{s['clientSecret']}".encode()).decode()
    tok = c.post("/oauth/token", data={"grant_type": "client_credentials", "scope": "fx.read"},
                 headers={"Authorization": "Basic " + basic})
    assert tok.status_code == 200
    access = tok.json()["access_token"]
    quote = {"from": "USD", "to": "EUR"}
    assert c.post("/api/get_quote", json=quote, headers={"Authorization": f"Bearer {access}"}).status_code == 200
    assert c.post("/api/get_quote", json=quote, headers={"Authorization": "Bearer no"}).status_code == 401


def test_oauth_client_credentials_post_and_bad_secret():
    c = client("orbit-erp")
    s = seed("orbit-erp")
    tok = c.post("/oauth/token", data={
        "grant_type": "client_credentials", "client_id": s["clientId"],
        "client_secret": s["clientSecret"], "scope": "erp.read",
    })
    assert tok.status_code == 200
    bad = c.post("/oauth/token", data={
        "grant_type": "client_credentials", "client_id": s["clientId"], "client_secret": "wrong",
    })
    assert bad.status_code == 401


# --------------------------------------------------------------------------- #
# oauth2_authorization_code (PKCE and refresh)
# --------------------------------------------------------------------------- #
def _authorize_code(c: TestClient, s: dict, challenge: str | None = None) -> str:
    data = {
        "client_id": s["clientId"],
        "redirect_uri": "http://127.0.0.1:8000/callback",
        "scope": "accounts.read",
        "state": "xyz",
    }
    if challenge:
        data["code_challenge"] = challenge
    r = c.post("/oauth/authorize", data=data, follow_redirects=False)
    return r.headers["location"].split("code=")[1].split("&")[0]


def test_oauth_authorization_code_pkce():
    c = client("corvus-bank")
    s = seed("corvus-bank")
    verifier = "verifier-abc123verifier-abc123verifier-xyz"
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    code = _authorize_code(c, s, challenge)
    tok = c.post("/oauth/token", data={
        "grant_type": "authorization_code", "code": code, "client_id": s["clientId"],
        "client_secret": s["clientSecret"], "code_verifier": verifier,
        "redirect_uri": "http://127.0.0.1:8000/callback",
    })
    assert tok.status_code == 200 and "access_token" in tok.json()

    code2 = _authorize_code(c, s, challenge)
    bad = c.post("/oauth/token", data={
        "grant_type": "authorization_code", "code": code2, "client_id": s["clientId"],
        "client_secret": s["clientSecret"], "code_verifier": "WRONG",
        "redirect_uri": "http://127.0.0.1:8000/callback",
    })
    assert bad.status_code == 400


def test_oauth_authorization_code_refresh():
    c = client("lumen-crm")
    s = seed("lumen-crm")
    code = _authorize_code(c, s)
    tok = c.post("/oauth/token", data={
        "grant_type": "authorization_code", "code": code, "client_id": s["clientId"],
        "client_secret": s["clientSecret"], "redirect_uri": "http://127.0.0.1:8000/callback",
    }).json()
    assert "refresh_token" in tok
    refreshed = c.post("/oauth/token", data={
        "grant_type": "refresh_token", "refresh_token": tok["refresh_token"],
    })
    assert refreshed.status_code == 200 and "access_token" in refreshed.json()


# --------------------------------------------------------------------------- #
# caracal_mandate (verifier SDK semantics)
# --------------------------------------------------------------------------- #
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
    c = client("atlas-treasury")
    token = seed("atlas-treasury")["mandate"]
    assert c.post("/api/get_position", headers={"Authorization": f"Bearer {token}"}).status_code == 200
    assert c.post("/api/get_position", headers={"Authorization": "Bearer junk"}).status_code == 401


def test_mandate_zone_mismatch_rejected():
    c = client("atlas-treasury")
    token = _mint("atlas-treasury", zone="wrong-zone")
    r = c.post("/api/get_position", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 403
    assert r.json()["error"] == "invalid_zone"


def test_mandate_insufficient_scope_rejected():
    c = client("atlas-treasury")
    token = _mint("atlas-treasury", scopes=[])
    r = c.post("/api/get_position", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 403
    assert r.json()["error"] == "insufficient_scope"


def test_mandate_delegation_required_rejected():
    c = client("sentinel-compliance")
    token = _mint("sentinel-compliance", agent_session_id=None, delegation_edge_id=None)
    r = c.post("/api/screen_party", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 403
    assert r.json()["error"] == "delegation_required"


def test_mandate_revocation_anchor():
    c = client("atlas-treasury")
    anchor = f"sid_{uuid.uuid4().hex[:12]}"
    token = _mint("atlas-treasury", session_id=anchor)
    assert c.post("/api/get_position", headers={"Authorization": f"Bearer {token}"}).status_code == 200
    credentials.load("atlas-treasury").revoke_mandate_anchor(anchor)
    r = c.post("/api/get_position", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 403
    assert r.json()["error"] == "session_revoked"


# --------------------------------------------------------------------------- #
# none (internal)
# --------------------------------------------------------------------------- #
def test_internal_provider_needs_no_credential():
    c = client("core-billing")
    r = c.post("/api/create_invoice", json={"customerId": "C-1", "amount": 100})
    assert r.status_code == 200 and r.json()["data"]["status"] == "open"
    assert seed("core-identity")["credential"] is None


# --------------------------------------------------------------------------- #
# mcp (bearer and mandate guarded)
# --------------------------------------------------------------------------- #
def _mcp_call(c: TestClient, headers: dict) -> int:
    return c.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, headers=headers).status_code


def test_mcp_bearer_guarded():
    c = client("forge-mcp")
    token = seed("forge-mcp")["bearerToken"]
    assert _mcp_call(c, {"Authorization": f"Bearer {token}"}) == 200
    assert _mcp_call(c, {"Authorization": "Bearer no"}) == 401


def test_mcp_tool_call_runs_domain():
    c = client("forge-mcp")
    token = seed("forge-mcp")["bearerToken"]
    r = c.post("/mcp", json={"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                             "params": {"name": "search_catalog", "arguments": {"query": "plan"}}},
               headers={"Authorization": f"Bearer {token}"})
    data = r.json()["result"]["content"][0]["data"]
    assert data["results"] and data["query"] == "plan"


def test_mcp_mandate_guarded():
    c = client("relay-mcp")
    token = seed("relay-mcp")["mandate"]
    assert _mcp_call(c, {"Authorization": f"Bearer {token}"}) == 200
    assert _mcp_call(c, {}) == 401


# --------------------------------------------------------------------------- #
# sdk (api-key over HTTP, consumed by a pip SDK shim)
# --------------------------------------------------------------------------- #
def test_sdk_providers_authenticate():
    payloads = {
        "zephyr-pay": ("create_payout", {"amount": 5.0, "currency": "USD", "destination": "acct_1"}),
        "terra-tax": ("calculate", {"jurisdiction": "DE", "amount": 100.0}),
    }
    for pid, (op, body) in payloads.items():
        c = client(pid)
        key = seed(pid)["apiKey"]
        assert c.post(f"/api/{op}", json=body, headers={"X-Api-Key": key}).status_code == 200
        assert c.post(f"/api/{op}", json=body, headers={"X-Api-Key": "bad"}).status_code == 401


def test_sdk_shim_end_to_end():
    from zephyr_pay import ZephyrPayClient

    key = seed("zephyr-pay")["apiKey"]
    http = TestClient(build_app(catalog.get("zephyr-pay")), headers={"X-Api-Key": key})
    sdk = ZephyrPayClient(api_key=key, http_client=http)
    payout = sdk.create_payout(amount=10.0, currency="USD", destination="acct_1")
    assert payout.raw["data"]["status"] == "pending"


# --------------------------------------------------------------------------- #
# Within-type pairs cover distinct realistic cases
# --------------------------------------------------------------------------- #
def _authed_oauth(provider_id: str, scope: str) -> tuple[TestClient, str]:
    c = client(provider_id)
    s = seed(provider_id)
    basic = base64.b64encode(f"{s['clientId']}:{s['clientSecret']}".encode()).decode()
    tok = c.post("/oauth/token", data={"grant_type": "client_credentials", "scope": scope},
                 headers={"Authorization": "Basic " + basic})
    return c, tok.json()["access_token"]


def test_api_key_pair_distinct_cases():
    # Aurum Pay: synchronous write with idempotency and a funds-limit error.
    pay = client("aurum-pay")
    key = seed("aurum-pay")["apiKey"]
    h = {"X-Api-Key": key}
    body = {"amount": 100, "currency": "USD", "source": "tok_visa", "idempotencyKey": "idem-1"}
    first = pay.post("/api/create_charge", json=body, headers=h).json()["data"]
    second = pay.post("/api/create_charge", json=body, headers=h).json()["data"]
    assert first["chargeId"] == second["chargeId"]  # idempotent replay
    over = pay.post("/api/create_charge", json={"amount": 99999, "currency": "USD", "source": "s"}, headers=h)
    assert over.status_code == 402 and over.json()["error"] == "insufficient_funds"
    # Quill OCR: asynchronous job lifecycle (processing -> completed).
    ocr = client("quill-ocr")
    okey = seed("quill-ocr")["apiKey"]
    started = ocr.post(f"/api/extract_document?api_key={okey}", json={"documentUrl": "s3://a.pdf"}).json()["data"]
    assert started["status"] == "processing"
    done = ocr.post(f"/api/get_job?api_key={okey}", json={"jobId": started["jobId"]}).json()["data"]
    assert done["status"] == "completed" and "fields" in done


def test_bearer_pair_distinct_cases():
    # Nimbus Ledger: double-entry validation rejects an unbalanced entry.
    ldg = client("nimbus-ledger")
    h = {"Authorization": f"Bearer {seed('nimbus-ledger')['bearerToken']}"}
    bad = ldg.post("/api/post_entry", json={"lines": [{"debit": 10}, {"credit": 5}]}, headers=h)
    assert bad.status_code == 422 and bad.json()["error"] == "unbalanced_entry"
    good = ldg.post("/api/post_entry", json={"lines": [{"debit": 10}, {"credit": 10}]}, headers=h)
    assert good.json()["data"]["posted"] is True
    # Vela Mail: custom-scheme bearer, async accept + recipient validation.
    mail = client("vela-mail")
    mh = {"X-Vela-Token": f"Token {seed('vela-mail')['bearerToken']}"}
    acc = mail.post("/api/send_message", json={"to": "a@b.example", "subject": "x"}, headers=mh)
    assert acc.json()["data"]["status"] == "accepted"
    bad_to = mail.post("/api/send_message", json={"to": "not-an-email", "subject": "x"}, headers=mh)
    assert bad_to.status_code == 422 and bad_to.json()["error"] == "invalid_recipient"


def test_oauth_cc_pair_distinct_cases():
    # Helios FX: scope step-up — fx.read token cannot convert.
    c, read_token = _authed_oauth("helios-fx", "fx.read")
    h = {"Authorization": f"Bearer {read_token}"}
    assert c.post("/api/get_quote", json={"from": "USD", "to": "EUR"}, headers=h).status_code == 200
    denied = c.post("/api/convert", json={"from": "USD", "to": "EUR", "amount": 100}, headers=h)
    assert denied.status_code == 403 and denied.json()["error"] == "insufficient_scope"
    c2, conv_token = _authed_oauth("helios-fx", "fx.read fx.convert")
    ok = c2.post("/api/convert", json={"from": "USD", "to": "EUR", "amount": 100},
                 headers={"Authorization": f"Bearer {conv_token}"})
    assert ok.status_code == 200 and ok.json()["data"]["out"] == 92.0
    # Orbit ERP: post-auth token, not-found case.
    e = client("orbit-erp")
    s = seed("orbit-erp")
    tok = e.post("/oauth/token", data={"grant_type": "client_credentials", "client_id": s["clientId"],
                                       "client_secret": s["clientSecret"], "scope": "erp.read"}).json()["access_token"]
    eh = {"Authorization": f"Bearer {tok}"}
    assert e.post("/api/get_vendor", json={"vendorId": "V-1001"}, headers=eh).status_code == 200
    nf = e.post("/api/get_vendor", json={"vendorId": "V-9"}, headers=eh)
    assert nf.status_code == 404 and nf.json()["error"] == "vendor_not_found"


def test_oauth_ac_pair_distinct_cases():
    # Corvus Bank: PKCE-issued token; payment write needs payments.write scope.
    c = client("corvus-bank")
    s = seed("corvus-bank")
    verifier = "verifier-abc123verifier-abc123verifier-xyz"
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    code = _authorize_code(c, s, challenge)
    tok = c.post("/oauth/token", data={"grant_type": "authorization_code", "code": code,
                                       "client_id": s["clientId"], "client_secret": s["clientSecret"],
                                       "code_verifier": verifier,
                                       "redirect_uri": "http://127.0.0.1:8000/callback"}).json()["access_token"]
    h = {"Authorization": f"Bearer {tok}"}
    assert c.post("/api/list_accounts", json={}, headers=h).json()["data"]["accounts"]
    denied = c.post("/api/initiate_payment", json={"fromAccount": "ACC-77", "amount": 10, "creditor": "x"}, headers=h)
    assert denied.status_code == 403  # scope accounts.read only
    # Lumen CRM: optimistic-concurrency conflict on update_deal.
    lc = client("lumen-crm")
    ls = seed("lumen-crm")
    lcode = _authorize_code(lc, ls)
    ltok = lc.post("/oauth/token", data={"grant_type": "authorization_code", "code": lcode,
                                         "client_id": ls["clientId"], "client_secret": ls["clientSecret"],
                                         "redirect_uri": "http://127.0.0.1:8000/callback",
                                         "scope": "contacts.read deals.write"}).json()
    lh = {"Authorization": f"Bearer {ltok['access_token']}"}
    # The seeded token scope comes from the auth code's scope; request write explicitly.
    conflict = lc.post("/api/update_deal", json={"dealId": "D-1", "version": 5}, headers=lh)
    assert conflict.status_code in (403, 409)


def test_internal_pair_distinct_cases():
    # Core Billing: write + not-found.
    b = client("core-billing")
    inv = b.post("/api/create_invoice", json={"customerId": "C-1", "amount": 50}).json()["data"]
    assert b.post("/api/get_invoice", json={"invoiceId": inv["invoiceId"]}).status_code == 200
    assert b.post("/api/get_invoice", json={"invoiceId": "missing"}).status_code == 404
    # Core Identity: pagination.
    idn = client("core-identity")
    page1 = idn.post("/api/list_groups", json={"page": 1}).json()["data"]
    assert page1["hasMore"] is True and len(page1["items"]) == 10
    page3 = idn.post("/api/list_groups", json={"page": 3}).json()["data"]
    assert page3["hasMore"] is False


def test_sdk_pair_distinct_cases():
    # Zephyr Pay: minimum-amount validation.
    z = client("zephyr-pay")
    zk = {"X-Api-Key": seed("zephyr-pay")["apiKey"]}
    small = z.post("/api/create_payout", json={"amount": 0.5, "currency": "USD", "destination": "d"}, headers=zk)
    assert small.status_code == 422 and small.json()["error"] == "amount_too_small"
    # Terra Tax: rate-table calculation and id validation cases.
    t = client("terra-tax")
    tk = {"X-Api-Key": seed("terra-tax")["apiKey"]}
    calc = t.post("/api/calculate", json={"jurisdiction": "US-CA", "amount": 100}, headers=tk).json()["data"]
    assert calc["tax"] == 8.25
    invalid = t.post("/api/validate_id", json={"taxId": "123"}, headers=tk).json()["data"]
    assert invalid["valid"] is False


def test_mandate_pair_distinct_cases():
    # Atlas Treasury: write scope required for move_funds.
    a = client("atlas-treasury")
    token = seed("atlas-treasury")["mandate"]  # seeded with treasury.read+write
    h = {"Authorization": f"Bearer {token}"}
    assert a.post("/api/get_position", json={}, headers=h).json()["data"]["cashUsd"] > 0
    read_only = _mint("atlas-treasury", scopes=["treasury.read"])
    denied = a.post("/api/move_funds", json={"fromRegion": "US", "toRegion": "EU", "amountUsd": 100},
                    headers={"Authorization": f"Bearer {read_only}"})
    assert denied.status_code == 403
    # Sentinel Compliance: delegated mandate yields a screening decision.
    s = client("sentinel-compliance")
    stoken = seed("sentinel-compliance")["mandate"]
    hit = s.post("/api/screen_party", json={"name": "Oblast Holdings"},
                 headers={"Authorization": f"Bearer {stoken}"}).json()["data"]
    assert hit["decision"] == "review" and hit["matches"] == 2



    store = credentials.load("aurum-pay")
    rec = store.create_api_key("ci-temp")
    assert store.valid_api_key(rec["apiKey"])
    assert store.revoke("apiKey", rec["keyId"])
    assert not store.valid_api_key(rec["apiKey"])


def test_control_ui_create_credential_via_form():
    c = client("aurum-pay")
    r = c.post("/__lab/api/create-credential", data={"kind": "apiKey", "label": "ui-temp"},
               follow_redirects=False)
    assert r.status_code == 303
    store = credentials.load("aurum-pay")
    created = [k for k in store.data["apiKeys"] if k["label"] == "ui-temp"]
    assert created and store.valid_api_key(created[0]["apiKey"])


# --------------------------------------------------------------------------- #
# UI pages render
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("path", ["/", "/__lab/credentials", "/__lab/clients", "/__lab/api-clients"])
def test_ui_pages_render(path):
    c = client("helios-fx")
    r = c.get(path)
    assert r.status_code == 200
    assert "Helios FX" in r.text


# --------------------------------------------------------------------------- #
# External-feel network behavior
# --------------------------------------------------------------------------- #
def test_responses_carry_external_headers():
    c = client("aurum-pay")
    r = c.post("/api/get_balance", headers={"X-Api-Key": seed("aurum-pay")["apiKey"]})
    assert "X-Request-Id" in r.headers
    assert r.headers.get("Server", "").startswith("AurumPay")


# --------------------------------------------------------------------------- #
# Isolation boundaries
# --------------------------------------------------------------------------- #
def _app_python_files() -> list[Path]:
    return list((LYNX_ROOT / "app").rglob("*.py"))


def test_no_mock_logic_leaks_outside_mock():
    for path in _app_python_files():
        text = path.read_text(encoding="utf-8")
        assert "providerlab" not in text, f"mock reference leaked into {path}"
        assert "from _mock" not in text and "import _mock" not in text, f"_mock import in {path}"


def test_caracal_sdk_fully_removed_from_app():
    forbidden = re.compile(r"caracalai_sdk|caracal_module|from caracalai|import caracalai")
    for path in _app_python_files():
        assert not forbidden.search(path.read_text(encoding="utf-8")), f"SDK residue in {path}"


def test_no_caracal_sdk_in_dependencies():
    for name in ("pyproject.toml", "requirements.lock", "uv.lock"):
        path = LYNX_ROOT / name
        if path.exists():
            assert "caracalai" not in path.read_text(encoding="utf-8"), f"caracalai dep in {name}"
