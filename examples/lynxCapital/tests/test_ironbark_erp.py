"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Validates the Ironbark ERP provider: audience-scoped OAuth2 client credentials, the procure-to-pay flow, three-way match, and general-ledger posting rules.
"""

from __future__ import annotations

import os

os.environ.setdefault("PROVIDERLAB_FAST", "1")

from fastapi.testclient import TestClient

from _mock.providerlab import catalog, credentials
from _mock.providerlab.app import build_app

AUDIENCE = "https://api.ironbark-erp.test"


def _client() -> TestClient:
    return TestClient(build_app(catalog.get("ironbark-erp")))


def _seed() -> dict:
    return credentials.load("ironbark-erp").data["seed"]


def _token(
    c: TestClient, scope: str = "erp.read erp.write", resource: str = AUDIENCE
) -> str:
    s = _seed()
    data = {
        "grant_type": "client_credentials",
        "client_id": s["clientId"],
        "client_secret": s["clientSecret"],
        "scope": scope,
    }
    if resource is not None:
        data["resource"] = resource
    return c.post("/oauth/token", data=data).json()["access_token"]


def _api(c: TestClient, token: str, op: str, body: dict):
    return c.post(f"/api/{op}", json=body, headers={"Authorization": f"Bearer {token}"})


def _active_vendor(c: TestClient, token: str) -> dict:
    body = _api(c, token, "list_vendors", {"status": "active", "pageSize": 1}).json()
    return body["data"]["items"][0]


# --------------------------------------------------------------------------- #
# Audience-based authorization (RFC 8707 resource indicators)
# --------------------------------------------------------------------------- #
def test_metadata_advertises_resource_indicator():
    doc = _client().get("/.well-known/oauth-authorization-server").json()
    assert doc["resource"] == AUDIENCE
    assert doc["resource_indicators_supported"] is True
    assert doc["grant_types_supported"] == ["client_credentials"]


def test_audience_scoped_token_is_accepted():
    c = _client()
    token = _token(c, scope="erp.read")
    assert _api(c, token, "list_accounts", {}).status_code == 200


def test_unknown_resource_is_rejected_at_token_endpoint():
    c = _client()
    s = _seed()
    bad = c.post(
        "/oauth/token",
        data={
            "grant_type": "client_credentials",
            "client_id": s["clientId"],
            "client_secret": s["clientSecret"],
            "scope": "erp.read",
            "resource": "https://api.someone-else.test",
        },
    )
    assert bad.status_code == 400 and bad.json()["error"] == "invalid_target"


def test_resource_server_rejects_foreign_audience_token():
    c = _client()
    s = _seed()
    foreign = credentials.load("ironbark-erp").issue_token(
        s["clientId"], "erp.read", audience="https://api.someone-else.test"
    )
    resp = _api(c, foreign["accessToken"], "list_accounts", {})
    assert resp.status_code == 403 and resp.json()["error"] == "invalid_audience"


def test_scope_beyond_grant_is_rejected():
    c = _client()
    s = _seed()
    bad = c.post(
        "/oauth/token",
        data={
            "grant_type": "client_credentials",
            "client_id": s["clientId"],
            "client_secret": s["clientSecret"],
            "scope": "erp.admin",
        },
    )
    assert bad.status_code == 400 and bad.json()["error"] == "invalid_scope"


def test_read_token_cannot_write():
    c = _client()
    token = _token(c, scope="erp.read")
    vendor = _active_vendor(c, token)
    denied = _api(
        c,
        token,
        "create_purchase_order",
        {"vendorId": vendor["id"], "lines": [{"item": "x", "quantity": 1, "rate": 10}]},
    )
    assert denied.status_code == 403 and denied.json()["error"] == "insufficient_scope"


# --------------------------------------------------------------------------- #
# Procure-to-pay: vendor -> purchase order -> vendor bill -> three-way match
# --------------------------------------------------------------------------- #
def test_purchase_order_to_bill_and_match_flow():
    c = _client()
    token = _token(c)
    vendor = _active_vendor(c, token)

    po = _api(
        c,
        token,
        "create_purchase_order",
        {
            "vendorId": vendor["id"],
            "department": "Engineering",
            "lines": [
                {
                    "item": "Cloud compute",
                    "quantity": 10,
                    "rate": 100.0,
                    "account": "6200",
                }
            ],
        },
    ).json()["data"]
    assert po["status"] == "pendingReceipt" and po["tranId"].startswith("PO-2026-")
    assert po["total"] >= po["subtotal"]

    bill = _api(
        c,
        token,
        "create_bill",
        {
            "vendorId": vendor["id"],
            "purchaseOrderId": po["id"],
            "amount": po["subtotal"],
            "currency": vendor["currency"],
            "referenceNumber": "ACME-INV-1",
        },
    ).json()["data"]
    assert bill["status"] == "open" and bill["amountRemaining"] == bill["total"]

    dup = _api(
        c,
        token,
        "create_bill",
        {
            "vendorId": vendor["id"],
            "amount": 50,
            "currency": vendor["currency"],
            "referenceNumber": "ACME-INV-1",
        },
    )
    assert dup.status_code == 409 and dup.json()["error"] == "duplicate_bill"

    queued = _api(
        c,
        token,
        "match_invoice",
        {
            "invoiceId": "ACME-INV-1",
            "vendorId": vendor["id"],
            "amount": po["total"],
            "purchaseOrderId": po["id"],
        },
    ).json()["data"]
    assert queued["status"] == "processing"
    resolved = _api(
        c,
        token,
        "match_invoice",
        {
            "invoiceId": "ACME-INV-1",
            "vendorId": vendor["id"],
            "amount": po["total"],
            "purchaseOrderId": po["id"],
        },
    ).json()["data"]
    assert resolved["status"] == "matched" and resolved["matchType"] == "threeWay"


def test_three_way_match_flags_price_variance():
    c = _client()
    token = _token(c)
    vendor = _active_vendor(c, token)
    po = _api(
        c,
        token,
        "create_purchase_order",
        {
            "vendorId": vendor["id"],
            "lines": [{"item": "Hardware", "quantity": 2, "rate": 500.0}],
        },
    ).json()["data"]
    args = {
        "invoiceId": "VAR-1",
        "vendorId": vendor["id"],
        "amount": po["total"] * 2,
        "purchaseOrderId": po["id"],
    }
    _api(c, token, "match_invoice", args)
    rec = _api(c, token, "match_invoice", args).json()["data"]
    assert rec["status"] == "exception" and rec["reason"] == "price_variance"


def test_on_hold_vendor_cannot_be_billed():
    c = _client()
    token = _token(c)
    on_hold = next(
        (
            v
            for v in _api(
                c, token, "list_vendors", {"status": "onHold", "pageSize": 1}
            ).json()["data"]["items"]
        ),
        None,
    )
    if on_hold is None:
        return
    denied = _api(
        c,
        token,
        "create_bill",
        {"vendorId": on_hold["id"], "amount": 100, "currency": on_hold["currency"]},
    )
    assert denied.status_code == 409 and denied.json()["error"] == "vendor_on_hold"


# --------------------------------------------------------------------------- #
# General ledger posting rules
# --------------------------------------------------------------------------- #
def test_journal_entry_posting_rules():
    c = _client()
    token = _token(c)
    ok = _api(
        c,
        token,
        "post_journal_entry",
        {
            "postingPeriod": "Mar 2026",
            "lines": [
                {"account": "6200", "debit": 500},
                {"account": "2000", "credit": 500},
            ],
        },
    )
    assert ok.status_code == 200 and ok.json()["data"]["status"] == "posted"

    unbalanced = _api(
        c,
        token,
        "post_journal_entry",
        {
            "lines": [
                {"account": "6200", "debit": 500},
                {"account": "2000", "credit": 400},
            ]
        },
    )
    assert (
        unbalanced.status_code == 422
        and unbalanced.json()["error"] == "unbalanced_entry"
    )

    closed = _api(
        c,
        token,
        "post_journal_entry",
        {
            "postingPeriod": "Dec 2025",
            "lines": [
                {"account": "6200", "debit": 1},
                {"account": "2000", "credit": 1},
            ],
        },
    )
    assert closed.status_code == 422 and closed.json()["error"] == "period_closed"

    invalid = _api(
        c,
        token,
        "post_journal_entry",
        {"lines": [{"account": "9999", "debit": 1}, {"account": "2000", "credit": 1}]},
    )
    assert invalid.status_code == 422 and invalid.json()["error"] == "invalid_account"


def test_account_lookup_accepts_bare_and_prefixed_ids():
    c = _client()
    token = _token(c, scope="erp.read")
    assert (
        _api(c, token, "get_account", {"accountId": "2000"}).json()["data"]["acctName"]
        == "Accounts Payable"
    )
    assert _api(c, token, "get_account", {"accountId": "ACCT-2000"}).status_code == 200
    assert _api(c, token, "get_account", {"accountId": "0001"}).status_code == 404


# --------------------------------------------------------------------------- #
# LynxCapital exercises the back-office surface through its agent tools
# --------------------------------------------------------------------------- #
def test_lynxcapital_back_office_tools_reach_ironbark(providerlab):
    from app.agents import tools as tool_fns

    token = _token(_client(), scope="erp.read")
    vendor = _active_vendor(_client(), token)

    po = tool_fns.netsuite_create_purchase_order(
        "run", "agent", vendor["id"], "Managed security", 4, 2500.0, "Finance"
    )
    assert po["provider"] == "ironbark-erp" and po["data"]["status"] == "pendingReceipt"

    bill = tool_fns.netsuite_record_vendor_bill(
        "run",
        "agent",
        vendor["id"],
        po["data"]["subtotal"],
        vendor["currency"],
        "BO-REF-1",
        po["data"]["id"],
    )
    assert (
        bill["provider"] == "ironbark-erp"
        and bill["data"]["amountRemaining"] == bill["data"]["total"]
    )

    listed = tool_fns.netsuite_list_open_bills("run", "agent", vendor["id"])
    assert listed["data"]["total"] >= 1

    je = tool_fns.netsuite_post_journal_entry(
        "run", "agent", "6300", "2000", 9000.0, "USD", "Apr 2026"
    )
    assert je["data"]["status"] == "posted"

    ap = tool_fns.netsuite_get_ap_account("run", "agent")
    assert ap["data"]["acctNumber"] == "2000"
