"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Validates the Tallyhall Books provider: QuickBooks Online-style OAuth2 authorization code with offline refresh-token rotation, scoped accounting and payment operations, and the bookkeeping, A/P, A/R, and reporting domain flows.
"""

from __future__ import annotations

import os

os.environ.setdefault("PROVIDERLAB_FAST", "1")

from fastapi.testclient import TestClient

from _mock.providerlab import catalog, credentials
from _mock.providerlab.app import build_app

ACCOUNTING = "com.intuit.quickbooks.accounting"
PAYMENT = "com.intuit.quickbooks.payment"
REDIRECT = "http://127.0.0.1:8000/callback"


def _client() -> TestClient:
    return TestClient(build_app(catalog.get("tallyhall-books")))


def _seed() -> dict:
    return credentials.load("tallyhall-books").data["seed"]


def _authorize_code(c: TestClient, s: dict, scope: str) -> str:
    r = c.post(
        "/oauth/authorize",
        data={
            "client_id": s["clientId"],
            "redirect_uri": REDIRECT,
            "scope": scope,
            "state": "xyz",
        },
        follow_redirects=False,
    )
    return r.headers["location"].split("code=")[1].split("&")[0]


def _token_bundle(c: TestClient, scope: str = f"{ACCOUNTING} {PAYMENT}") -> dict:
    s = _seed()
    code = _authorize_code(c, s, scope)
    return c.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "client_id": s["clientId"],
            "client_secret": s["clientSecret"],
            "redirect_uri": REDIRECT,
        },
    ).json()


def _token(c: TestClient, scope: str = f"{ACCOUNTING} {PAYMENT}") -> str:
    return _token_bundle(c, scope)["access_token"]


def _api(c: TestClient, token: str, op: str, body: dict | None = None):
    return c.post(
        f"/api/{op}", json=body or {}, headers={"Authorization": f"Bearer {token}"}
    )


def _open_bill(c: TestClient, token: str) -> dict:
    body = _api(c, token, "list_bills", {"pageSize": 50}).json()
    return next(b for b in body["data"]["items"] if b["Balance"] > 0)


def _open_invoice(c: TestClient, token: str) -> dict:
    body = _api(c, token, "list_invoices", {"pageSize": 50}).json()
    return next(
        i for i in body["data"]["items"] if i["Balance"] > 0 and i["status"] != "Voided"
    )


def _active_vendor(c: TestClient, token: str) -> dict:
    body = _api(c, token, "list_vendors", {"active": True, "pageSize": 1}).json()
    return body["data"]["items"][0]


# --------------------------------------------------------------------------- #
# OAuth: discovery, authorization code, offline refresh-token rotation
# --------------------------------------------------------------------------- #
def test_discovery_advertises_authcode_and_refresh():
    doc = _client().get("/.well-known/oauth-authorization-server").json()
    assert doc["response_types_supported"] == ["code"]
    assert set(doc["grant_types_supported"]) == {"authorization_code", "refresh_token"}
    assert ACCOUNTING in doc["scopes_supported"]
    assert doc["authorization_endpoint"].endswith("/oauth/authorize")


def test_authorization_code_grants_offline_refresh_token():
    bundle = _token_bundle(_client())
    assert "access_token" in bundle and "refresh_token" in bundle


def test_refresh_token_is_single_use_and_rotates():
    c = _client()
    bundle = _token_bundle(c)
    first = c.post(
        "/oauth/token",
        data={"grant_type": "refresh_token", "refresh_token": bundle["refresh_token"]},
    ).json()
    assert "access_token" in first and first["refresh_token"] != bundle["refresh_token"]
    replay = c.post(
        "/oauth/token",
        data={"grant_type": "refresh_token", "refresh_token": bundle["refresh_token"]},
    )
    assert replay.status_code == 400
    chained = c.post(
        "/oauth/token",
        data={"grant_type": "refresh_token", "refresh_token": first["refresh_token"]},
    )
    assert chained.status_code == 200


def test_missing_token_is_rejected():
    assert _client().post("/api/list_vendors", json={}).status_code == 401


# --------------------------------------------------------------------------- #
# Scopes: accounting vs payment
# --------------------------------------------------------------------------- #
def test_accounting_scope_cannot_take_payment():
    c = _client()
    token = _token(c, ACCOUNTING)
    invoice = _open_invoice(c, token)
    res = _api(c, token, "record_payment", {"invoiceId": invoice["Id"]})
    assert res.status_code == 403 and res.json()["error"] == "insufficient_scope"


def test_payment_scope_settles_invoice():
    c = _client()
    token = _token(c)
    invoice = _open_invoice(c, token)
    res = _api(c, token, "record_payment", {"invoiceId": invoice["Id"]})
    assert res.status_code == 200
    assert res.json()["data"]["Line"][0]["LinkedTxn"][0]["TxnId"] == invoice["Id"]


# --------------------------------------------------------------------------- #
# Company file and chart of accounts
# --------------------------------------------------------------------------- #
def test_company_info_carries_realm_and_home_currency():
    c = _client()
    info = _api(c, _token(c), "get_company_info", {}).json()["data"]
    assert info["realmId"] and info["HomeCurrency"]["value"] == "USD"


def test_wrong_realm_is_rejected():
    c = _client()
    res = _api(c, _token(c), "get_company_info", {"realmId": "0000"})
    assert res.status_code == 401


def test_chart_of_accounts_has_ap_and_ar_controls():
    c = _client()
    accounts = _api(c, _token(c), "list_accounts", {"pageSize": 50}).json()["data"][
        "items"
    ]
    subtypes = {a["AccountSubType"] for a in accounts}
    assert {"AccountsPayable", "AccountsReceivable", "UndepositedFunds"} <= subtypes


def test_get_account_resolves_by_number():
    c = _client()
    acct = _api(c, _token(c), "get_account", {"accountId": "2000"}).json()["data"]
    assert acct["AccountSubType"] == "AccountsPayable"


# --------------------------------------------------------------------------- #
# Accounts payable: bills, matching, payment
# --------------------------------------------------------------------------- #
def test_create_bill_increases_ap_and_vendor_balance():
    c = _client()
    token = _token(c)
    vendor = _active_vendor(c, token)
    ap_before = _api(c, token, "get_account", {"accountId": "2000"}).json()["data"][
        "CurrentBalance"
    ]
    bill = _api(
        c,
        token,
        "create_bill",
        {
            "vendorId": vendor["Id"],
            "amount": 1000,
            "currency": vendor["CurrencyRef"]["value"],
        },
    ).json()["data"]
    assert bill["Balance"] == bill["TotalAmt"] and bill["status"] == "Open"
    ap_after = _api(c, token, "get_account", {"accountId": "2000"}).json()["data"][
        "CurrentBalance"
    ]
    assert round(ap_after - ap_before, 2) == bill["TotalAmt"]


def test_bill_currency_must_match_vendor():
    c = _client()
    token = _token(c)
    vendor = next(
        v
        for v in _api(c, token, "list_vendors", {"pageSize": 60}).json()["data"][
            "items"
        ]
        if v["CurrencyRef"]["value"] != "USD"
    )
    res = _api(
        c,
        token,
        "create_bill",
        {"vendorId": vendor["Id"], "amount": 10, "currency": "USD"},
    )
    assert res.status_code == 400 and res.json()["error"] == "CurrencyMismatch"


def test_duplicate_doc_number_is_rejected():
    c = _client()
    token = _token(c)
    vendor = _active_vendor(c, token)
    ccy = vendor["CurrencyRef"]["value"]
    _api(
        c,
        token,
        "create_bill",
        {"vendorId": vendor["Id"], "amount": 50, "currency": ccy, "docNumber": "DUP-1"},
    )
    res = _api(
        c,
        token,
        "create_bill",
        {"vendorId": vendor["Id"], "amount": 50, "currency": ccy, "docNumber": "DUP-1"},
    )
    assert res.status_code == 400 and res.json()["error"] == "DuplicateDocNum"


def test_match_then_pay_bill_clears_balance():
    c = _client()
    token = _token(c)
    vendor = _active_vendor(c, token)
    ccy = vendor["CurrencyRef"]["value"]
    bill = _api(
        c,
        token,
        "create_bill",
        {"vendorId": vendor["Id"], "amount": 800, "currency": ccy},
    ).json()["data"]
    matched = _api(
        c, token, "match_bill", {"billId": bill["Id"], "poRef": "PO-99"}
    ).json()["data"]
    assert any(t["TxnType"] == "PurchaseOrder" for t in matched["LinkedTxn"])
    payment = _api(c, token, "pay_bill", {"billId": bill["Id"]}).json()["data"]
    assert payment["TotalAmt"] == bill["TotalAmt"]
    after = _api(c, token, "get_bill", {"billId": bill["Id"]}).json()["data"]
    assert after["Balance"] == 0.0 and after["status"] == "Paid"


def test_overpaying_bill_is_rejected():
    c = _client()
    token = _token(c)
    bill = _open_bill(c, token)
    res = _api(
        c, token, "pay_bill", {"billId": bill["Id"], "amount": bill["Balance"] + 10_000}
    )
    assert res.status_code == 400 and res.json()["error"] == "AmountExceedsBalance"


# --------------------------------------------------------------------------- #
# Accounts receivable: invoices, send, payment, void
# --------------------------------------------------------------------------- #
def test_create_send_and_collect_invoice():
    c = _client()
    token = _token(c)
    customers = _api(
        c, token, "list_customers", {"active": True, "pageSize": 1}
    ).json()["data"]["items"]
    customer = customers[0]
    invoice = _api(
        c,
        token,
        "create_invoice",
        {
            "customerId": customer["Id"],
            "amount": 2400,
            "currency": customer["CurrencyRef"]["value"],
        },
    ).json()["data"]
    assert invoice["EmailStatus"] == "NeedToSend"
    sent = _api(c, token, "send_invoice", {"invoiceId": invoice["Id"]}).json()["data"]
    assert sent["EmailStatus"] == "EmailSent"
    paid = _api(c, token, "record_payment", {"invoiceId": invoice["Id"]}).json()["data"]
    assert paid["TotalAmt"] == invoice["TotalAmt"]
    after = _api(c, token, "get_invoice", {"invoiceId": invoice["Id"]}).json()["data"]
    assert after["Balance"] == 0.0 and after["status"] == "Paid"


def test_partial_payment_marks_invoice_partially_paid():
    c = _client()
    token = _token(c)
    invoice = _open_invoice(c, token)
    half = round(invoice["Balance"] / 2, 2)
    _api(c, token, "record_payment", {"invoiceId": invoice["Id"], "amount": half})
    after = _api(c, token, "get_invoice", {"invoiceId": invoice["Id"]}).json()["data"]
    assert after["status"] == "PartiallyPaid"


def test_void_invoice_blocked_when_payment_applied():
    c = _client()
    token = _token(c)
    invoice = _open_invoice(c, token)
    _api(c, token, "record_payment", {"invoiceId": invoice["Id"], "amount": 1})
    res = _api(c, token, "void_invoice", {"invoiceId": invoice["Id"]})
    assert res.status_code == 400 and res.json()["error"] == "VoidNotAllowed"


# --------------------------------------------------------------------------- #
# Expenses and journal entries
# --------------------------------------------------------------------------- #
def test_create_expense_posts_to_account():
    c = _client()
    token = _token(c)
    vendor = _active_vendor(c, token)
    expense = _api(
        c,
        token,
        "create_expense",
        {
            "vendorId": vendor["Id"],
            "amount": 320,
            "currency": vendor["CurrencyRef"]["value"],
            "account": "6200",
            "paymentType": "CreditCard",
        },
    ).json()["data"]
    assert expense["PaymentType"] == "CreditCard"
    assert expense["Line"][0]["AccountBasedExpenseLineDetail"]["AccountRef"]["name"]


def test_unbalanced_journal_entry_is_rejected():
    c = _client()
    token = _token(c)
    res = _api(
        c,
        token,
        "post_journal_entry",
        {
            "lines": [
                {"account": "6300", "debit": 500},
                {"account": "1000", "credit": 400},
            ]
        },
    )
    assert res.status_code == 400 and res.json()["error"] == "UnbalancedTransaction"


def test_balanced_journal_entry_posts():
    c = _client()
    token = _token(c)
    entry = _api(
        c,
        token,
        "post_journal_entry",
        {
            "lines": [
                {"account": "6300", "debit": 500, "memo": "legal"},
                {"account": "1000", "credit": 500},
            ]
        },
    ).json()["data"]
    assert entry["TotalAmt"] == 500.0
    assert {ln["JournalEntryLineDetail"]["PostingType"] for ln in entry["Line"]} == {
        "Debit",
        "Credit",
    }


# --------------------------------------------------------------------------- #
# Reports
# --------------------------------------------------------------------------- #
def test_profit_and_loss_report_shape():
    c = _client()
    report = _api(c, _token(c), "get_report", {"reportType": "ProfitAndLoss"}).json()[
        "data"
    ]
    assert report["Header"]["ReportName"] == "ProfitAndLoss"
    groups = {r.get("group") for r in report["Rows"]["Row"]}
    assert "NetIncome" in groups


def test_aged_payables_report_buckets():
    c = _client()
    report = _api(c, _token(c), "get_report", {"reportType": "AgedPayables"}).json()[
        "data"
    ]
    assert set(report["Summary"]["Buckets"]) == {
        "Current",
        "1-30",
        "31-60",
        "61-90",
        "91+",
    }
    assert report["Summary"]["Total"] >= 0


def test_unknown_report_is_rejected():
    c = _client()
    res = _api(c, _token(c), "get_report", {"reportType": "Nope"})
    assert res.status_code == 400 and res.json()["error"] == "InvalidReport"


# --------------------------------------------------------------------------- #
# LynxCapital reaches the provider through its bookkeeping tools
# --------------------------------------------------------------------------- #
def test_lynxcapital_quickbooks_tools_reach_tallyhall(providerlab):
    from app.agents import tools as tool_fns

    vendor = __import__("app.services.partners", fromlist=["call"]).call(
        "tallyhall-books", "list_vendors", {"active": True, "pageSize": 1}
    )["data"]["items"][0]
    report = tool_fns.quickbooks_run_report("r", "a", "BalanceSheet")
    assert report["provider"] == "tallyhall-books"
    assert report["data"]["Header"]["ReportName"] == "BalanceSheet"
    expense = tool_fns.quickbooks_record_expense(
        "r", "a", vendor["Id"], 150.0, vendor["CurrencyRef"]["value"]
    )
    assert (
        expense["provider"] == "tallyhall-books"
        and expense["operation"] == "create_expense"
    )


# --------------------------------------------------------------------------- #
# OAuth: realm binding and refresh-token lifetime
# --------------------------------------------------------------------------- #
def test_authorization_callback_carries_realm():
    c = _client()
    s = _seed()
    r = c.post(
        "/oauth/authorize",
        data={
            "client_id": s["clientId"],
            "redirect_uri": REDIRECT,
            "scope": ACCOUNTING,
            "state": "xyz",
        },
        follow_redirects=False,
    )
    location = r.headers["location"]
    realm = location.split("realmId=")[1].split("&")[0]
    assert realm == catalog.get("tallyhall-books").realm_id


def test_token_response_advertises_refresh_token_lifetime():
    bundle = _token_bundle(_client())
    assert "x_refresh_token_expires_in" in bundle
    # QBO refresh tokens carry a rolling ~100-day validity.
    assert bundle["x_refresh_token_expires_in"] > 80 * 24 * 3600


def test_expired_refresh_token_is_rejected():
    c = _client()
    bundle = _token_bundle(c)
    store = credentials.load("tallyhall-books")
    token = next(
        t
        for t in store.data["tokens"]
        if t.get("refreshToken") == bundle["refresh_token"]
    )
    token["refreshExpiresAt"] = credentials._now() - 1
    res = c.post(
        "/oauth/token",
        data={"grant_type": "refresh_token", "refresh_token": bundle["refresh_token"]},
    )
    assert res.status_code == 400


def test_lynxcapital_call_binds_company_realm(providerlab):
    import app.services.partners as partners

    info = partners.call("tallyhall-books", "get_company_info", {})["data"]
    assert info["realmId"] == catalog.get("tallyhall-books").realm_id
    sess = partners._SESSIONS["tallyhall-books"]
    assert sess.realm == catalog.get("tallyhall-books").realm_id


# --------------------------------------------------------------------------- #
# Entity-field realism
# --------------------------------------------------------------------------- #
def test_company_info_exposes_preferences():
    info = _api(_client(), _token(_client()), "get_company_info", {}).json()["data"]
    prefs = {nv["Name"] for nv in info["NameValue"]}
    assert {"AccountingMethod", "IndustryType"} <= prefs


def test_invoice_carries_qbo_presentation_fields():
    c = _client()
    token = _token(c)
    invoice = _open_invoice(c, token)
    assert invoice["PrintStatus"] in ("NeedToPrint", "NotSet")
    assert invoice["ApplyTaxAfterDiscount"] is False
    assert "TxnTaxCodeRef" in invoice["TxnTaxDetail"]
    assert "CustomerMemo" in invoice


def test_taxable_customer_has_default_tax_code():
    c = _client()
    token = _token(c)
    customers = _api(c, token, "list_customers", {"pageSize": 40}).json()["data"][
        "items"
    ]
    taxable = next(cu for cu in customers if cu["Taxable"])
    assert taxable["DefaultTaxCodeRef"]["value"] == "3"


def test_created_invoice_mirrors_seeded_tax_detail():
    c = _client()
    token = _token(c)
    customer = _api(c, token, "list_customers", {"active": True, "pageSize": 1}).json()[
        "data"
    ]["items"][0]
    invoice = _api(
        c,
        token,
        "create_invoice",
        {
            "customerId": customer["Id"],
            "amount": 1000,
            "currency": customer["CurrencyRef"]["value"],
        },
    ).json()["data"]
    assert "TxnTaxCodeRef" in invoice["TxnTaxDetail"]
    assert invoice["PrintStatus"] == "NeedToPrint"


# --------------------------------------------------------------------------- #
# Balance summary reports
# --------------------------------------------------------------------------- #
def test_customer_balance_report_ties_to_receivables():
    c = _client()
    token = _token(c)
    report = _api(c, token, "get_report", {"reportType": "CustomerBalance"}).json()[
        "data"
    ]
    assert report["Header"]["ReportName"] == "CustomerBalance"
    total = float(report["Summary"]["ColData"][1]["value"])
    ar = _api(c, token, "get_account", {"accountId": "1200"}).json()["data"][
        "CurrentBalance"
    ]
    assert round(total, 2) == round(ar, 2)


def test_vendor_balance_report_ties_to_payables():
    c = _client()
    token = _token(c)
    report = _api(c, token, "get_report", {"reportType": "VendorBalance"}).json()[
        "data"
    ]
    assert report["Header"]["ReportName"] == "VendorBalance"
    total = float(report["Summary"]["ColData"][1]["value"])
    ap = _api(c, token, "get_account", {"accountId": "2000"}).json()["data"][
        "CurrentBalance"
    ]
    assert round(total, 2) == round(ap, 2)
