"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Validates the Core Billing provider: LynxCapital's internal accounts-receivable platform covering the invoice lifecycle, cash application and reversal, dunning, disputes, credit memos, collections cases, AR aging, statements, and the audit trail.
"""

from __future__ import annotations

import os

os.environ.setdefault("PROVIDERLAB_FAST", "1")

from fastapi.testclient import TestClient

from _mock.providerlab import catalog
from _mock.providerlab import netsim
from _mock.providerlab.app import build_app

import pytest


@pytest.fixture(autouse=True)
def _fresh_rate_limit():
    netsim._buckets.clear()
    yield


def _client() -> TestClient:
    return TestClient(build_app(catalog.get("core-billing")))


def _api(c: TestClient, op: str, body: dict | None = None):
    return c.post(f"/api/{op}", json=body or {})


def _active_customer(c: TestClient, *, country: str | None = None, **filters) -> dict:
    body = {"status": "active", "pageSize": 50, **filters}
    items = _api(c, "list_customers", body).json()["data"]["items"]
    items = [x for x in items if not x["creditHold"]]
    if country:
        items = [x for x in items if x["country"] == country]
    assert items, "no matching active customer in the seeded book"
    return items[0]


# --------------------------------------------------------------------------- #
# Internal access: no external credential, audited as the internal principal.
# --------------------------------------------------------------------------- #
def test_internal_access_requires_no_credential():
    c = _client()
    assert _api(c, "list_customers").status_code == 200


def test_unknown_operation_is_404():
    c = _client()
    assert _api(c, "not_a_real_op").status_code == 404


# --------------------------------------------------------------------------- #
# Customer master and AR rollups reconcile to invoice detail.
# --------------------------------------------------------------------------- #
def test_customer_master_carries_credit_and_risk_fields():
    c = _client()
    cust = _active_customer(c)
    for field in (
        "creditLimit",
        "paymentTerms",
        "paymentTermsDays",
        "riskRating",
        "dunningExempt",
        "collectionsStatus",
        "arBalance",
        "overdueBalance",
    ):
        assert field in cust


def test_get_customer_returns_ar_summary_and_aging():
    c = _client()
    cust = _active_customer(c)
    detail = _api(c, "get_customer", {"customerId": cust["customerId"]}).json()["data"]
    summary = detail["arSummary"]
    assert set(summary["aging"]) == {"current", "1-30", "31-60", "61-90", "90+"}
    assert summary["availableCredit"] == round(
        detail["creditLimit"] - detail["arBalance"], 2
    )
    bucket_total = round(sum(summary["aging"].values()), 2)
    assert bucket_total <= round(detail["arBalance"] + 0.01, 2)


def test_unknown_customer_is_404():
    c = _client()
    assert _api(c, "get_customer", {"customerId": "CUST-9999"}).status_code == 404


# --------------------------------------------------------------------------- #
# Invoice lifecycle: draft -> send -> open, with realistic tax and revenue GL.
# --------------------------------------------------------------------------- #
def test_create_draft_then_send_opens_the_balance():
    c = _client()
    cust = _active_customer(c, country="US")  # US is zero-rated for clean math
    draft = _api(
        c,
        "create_invoice",
        {
            "customerId": cust["customerId"],
            "amount": 5000,
            "status": "draft",
            "sku": "PLT-CORE",
        },
    ).json()["data"]
    assert draft["status"] == "draft" and draft["amountDue"] == 0.0
    assert draft["revenueAccount"] == "4000-SubscriptionRevenue"

    sent = _api(c, "send_invoice", {"invoiceId": draft["invoiceId"]}).json()["data"]
    assert sent["status"] == "open"
    assert sent["amountDue"] == sent["total"] == 5000.0
    assert sent["sentAt"] and sent["deliveryChannel"] == "email"


def test_send_rejects_non_draft_invoice():
    c = _client()
    cust = _active_customer(c)
    inv = _api(
        c, "create_invoice", {"customerId": cust["customerId"], "amount": 100}
    ).json()["data"]
    assert _api(c, "send_invoice", {"invoiceId": inv["invoiceId"]}).status_code == 409


def test_create_invoice_blocked_on_credit_hold_customer():
    c = _client()
    held = _api(c, "list_customers", {"creditHold": True, "pageSize": 1}).json()[
        "data"
    ]["items"]
    if not held:
        pytest.skip("no credit-hold customer in the seeded book")
    res = _api(
        c, "create_invoice", {"customerId": held[0]["customerId"], "amount": 100}
    )
    assert res.status_code == 409 and res.json()["error"] == "credit_hold"


# --------------------------------------------------------------------------- #
# Cash application: targeted, oldest-first, and reversal (NSF).
# --------------------------------------------------------------------------- #
def test_apply_payment_settles_and_marks_paid():
    c = _client()
    cust = _active_customer(c, country="US")
    inv = _api(
        c, "create_invoice", {"customerId": cust["customerId"], "amount": 800}
    ).json()["data"]
    res = _api(
        c, "apply_payment", {"invoiceId": inv["invoiceId"], "amount": 800}
    ).json()["data"]
    assert res["invoiceStatus"] == "paid" and res["remaining"] == 0.0


def test_record_payment_applies_oldest_first():
    c = _client()
    cust = _active_customer(c, country="US")
    cid = cust["customerId"]
    openish = [
        i
        for i in _api(c, "list_invoices", {"customerId": cid, "pageSize": 100}).json()[
            "data"
        ]["items"]
        if i["status"] in ("open", "overdue", "partiallyPaid")
    ]
    if len(openish) < 2:
        # Guarantee at least two open invoices with distinct due dates.
        _api(c, "create_invoice", {"customerId": cid, "amount": 300, "terms": "NET15"})
        _api(c, "create_invoice", {"customerId": cid, "amount": 300, "terms": "NET60"})
        openish = [
            i
            for i in _api(
                c, "list_invoices", {"customerId": cid, "pageSize": 100}
            ).json()["data"]["items"]
            if i["status"] in ("open", "overdue", "partiallyPaid")
        ]
    oldest = min(openish, key=lambda i: i["dueDate"])
    pay = _api(
        c, "record_payment", {"customerId": cid, "amount": oldest["amountDue"]}
    ).json()["data"]
    assert pay["allocations"][0]["invoiceId"] == oldest["invoiceId"]
    after = _api(c, "get_invoice", {"invoiceId": oldest["invoiceId"]}).json()["data"]
    assert after["status"] == "paid"


def test_overpayment_records_unapplied_credit():
    c = _client()
    cust = _active_customer(c, country="US")
    cid = cust["customerId"]
    _api(c, "create_invoice", {"customerId": cid, "amount": 100}).json()["data"]
    pay = _api(c, "record_payment", {"customerId": cid, "amount": 99_999_999}).json()[
        "data"
    ]
    assert pay["unappliedAmount"] > 0
    assert pay["status"] in ("partially_applied", "unapplied")


def test_reverse_payment_restores_invoice_balance():
    c = _client()
    cust = _active_customer(c, country="US")
    inv = _api(
        c, "create_invoice", {"customerId": cust["customerId"], "amount": 500}
    ).json()["data"]
    pay = _api(
        c, "apply_payment", {"invoiceId": inv["invoiceId"], "amount": 500}
    ).json()["data"]
    rev = _api(
        c, "reverse_payment", {"paymentId": pay["paymentId"], "reason": "nsf"}
    ).json()["data"]
    assert rev["payment"]["status"] == "reversed"
    restored = _api(c, "get_invoice", {"invoiceId": inv["invoiceId"]}).json()["data"]
    assert restored["status"] == "open" and restored["amountDue"] == 500.0
    assert (
        _api(c, "reverse_payment", {"paymentId": pay["paymentId"]}).status_code == 409
    )


# --------------------------------------------------------------------------- #
# Disputes: raise and resolve both ways.
# --------------------------------------------------------------------------- #
def test_dispute_then_credit_resolution_zeroes_balance():
    c = _client()
    cust = _active_customer(c, country="US")
    inv = _api(
        c, "create_invoice", {"customerId": cust["customerId"], "amount": 900}
    ).json()["data"]
    _api(
        c,
        "dispute_invoice",
        {"invoiceId": inv["invoiceId"], "reason": "duplicate_charge"},
    )
    out = _api(
        c, "resolve_dispute", {"invoiceId": inv["invoiceId"], "resolution": "credited"}
    ).json()["data"]
    assert out["invoice"]["status"] == "paid"
    assert out["creditMemo"]["status"] == "applied"
    assert out["invoice"]["disputeResolution"] == "credited"


def test_dispute_then_reinstate_keeps_receivable():
    c = _client()
    cust = _active_customer(c, country="US")
    inv = _api(
        c, "create_invoice", {"customerId": cust["customerId"], "amount": 700}
    ).json()["data"]
    _api(
        c,
        "dispute_invoice",
        {"invoiceId": inv["invoiceId"], "reason": "pricing_discrepancy"},
    )
    out = _api(
        c,
        "resolve_dispute",
        {"invoiceId": inv["invoiceId"], "resolution": "reinstated"},
    ).json()["data"]
    assert out["invoice"]["status"] in ("open", "overdue")
    assert out["invoice"]["amountDue"] == 700.0
    assert out["creditMemo"] is None


def test_dunning_blocked_on_disputed_invoice():
    c = _client()
    cust = _active_customer(c, country="US")
    inv = _api(
        c, "create_invoice", {"customerId": cust["customerId"], "amount": 100}
    ).json()["data"]
    _api(
        c,
        "dispute_invoice",
        {"invoiceId": inv["invoiceId"], "reason": "service_not_delivered"},
    )
    assert _api(c, "issue_dunning", {"invoiceId": inv["invoiceId"]}).status_code == 409


# --------------------------------------------------------------------------- #
# Credit memos: issue, apply, read.
# --------------------------------------------------------------------------- #
def test_credit_memo_issue_apply_and_list():
    c = _client()
    cust = _active_customer(c, country="US")
    cid = cust["customerId"]
    inv = _api(c, "create_invoice", {"customerId": cid, "amount": 1000}).json()["data"]
    memo = _api(
        c,
        "issue_credit_memo",
        {"customerId": cid, "amount": 400, "reason": "service_credit"},
    ).json()["data"]
    applied = _api(
        c,
        "apply_credit_memo",
        {"creditMemoId": memo["creditMemoId"], "invoiceId": inv["invoiceId"]},
    ).json()["data"]
    assert applied["applied"] == 400.0
    assert applied["invoice"]["amountDue"] == 600.0
    listed = _api(c, "list_credit_memos", {"customerId": cid}).json()["data"]
    assert any(m["creditMemoId"] == memo["creditMemoId"] for m in listed["items"])
    got = _api(c, "get_credit_memo", {"creditMemoId": memo["creditMemoId"]})
    assert got.status_code == 200


# --------------------------------------------------------------------------- #
# Dunning: escalation by aging and exemption handling.
# --------------------------------------------------------------------------- #
def test_run_dunning_cycle_reports_levels_and_exemptions():
    c = _client()
    out = _api(c, "run_dunning_cycle", {"minDaysPastDue": 1}).json()["data"]
    assert set(out["byLevel"]) == {"1", "2", "3"}
    assert "skippedExempt" in out
    assert out["sent"] == len(out["notices"])


def test_issue_dunning_blocked_for_exempt_customer():
    c = _client()
    exempt = [
        c0
        for c0 in _api(c, "list_customers", {"pageSize": 50}).json()["data"]["items"]
        if c0.get("dunningExempt")
    ]
    if not exempt:
        pytest.skip("no dunning-exempt customer seeded")
    cid = exempt[0]["customerId"]
    inv = _api(
        c, "list_invoices", {"customerId": cid, "overdue": True, "pageSize": 1}
    ).json()["data"]["items"]
    if not inv:
        inv = [
            _api(c, "create_invoice", {"customerId": cid, "amount": 100}).json()["data"]
        ]
    res = _api(c, "issue_dunning", {"invoiceId": inv[0]["invoiceId"]})
    assert res.status_code == 409 and res.json()["error"] in (
        "dunning_exempt",
        "invalid_state",
        "already_paid",
    )


# --------------------------------------------------------------------------- #
# Collections case lifecycle.
# --------------------------------------------------------------------------- #
def test_collection_case_note_and_close_lifecycle():
    c = _client()
    case = _api(c, "list_collections", {"pageSize": 1}).json()["data"]["items"][0]
    cid = case["caseId"]
    noted = _api(
        c,
        "add_collection_note",
        {
            "caseId": cid,
            "note": "Spoke with AP.",
            "promiseToPayDate": "2026-01-20",
            "promiseAmount": 5000,
        },
    ).json()["data"]
    assert (
        noted["status"] == "in_progress" and noted["promiseToPayDate"] == "2026-01-20"
    )
    closed = _api(
        c, "close_collection_case", {"caseId": cid, "resolution": "settled"}
    ).json()["data"]
    assert closed["status"] == "resolved" and closed["resolution"] == "settled"
    assert (
        _api(c, "add_collection_note", {"caseId": cid, "note": "late"}).status_code
        == 409
    )


def test_open_collection_case_requires_qualifying_invoices():
    c = _client()
    current = [
        c0
        for c0 in _api(
            c, "list_customers", {"collectionsStatus": "current", "pageSize": 50}
        ).json()["data"]["items"]
    ]
    if not current:
        pytest.skip("no fully current customer seeded")
    res = _api(c, "open_collection_case", {"customerId": current[0]["customerId"]})
    assert res.status_code == 409 and res.json()["error"] == "no_qualifying_invoices"


# --------------------------------------------------------------------------- #
# Reporting: aging, summary, statement, audit trail.
# --------------------------------------------------------------------------- #
def test_ar_aging_buckets_and_total_reconcile():
    c = _client()
    aging = _api(c, "get_ar_aging").json()["data"]
    assert set(aging["buckets"]) == {"current", "1-30", "31-60", "61-90", "90+"}
    assert aging["total"] == round(sum(aging["buckets"].values()), 2)


def test_ar_summary_exposes_management_metrics():
    c = _client()
    s = _api(c, "get_ar_summary").json()["data"]
    for field in (
        "daysSalesOutstanding",
        "overduePct",
        "badDebtRatio",
        "unappliedCash",
        "creditMemoOutstanding",
        "topOverdueCustomers",
        "openCollectionCases",
    ):
        assert field in s
    assert isinstance(s["topOverdueCustomers"], list)
    if s["topOverdueCustomers"]:
        assert (
            s["topOverdueCustomers"][0]["overdue"]
            >= s["topOverdueCustomers"][-1]["overdue"]
        )


def test_customer_statement_lists_documents_and_aging():
    c = _client()
    cust = _active_customer(c)
    st = _api(c, "get_customer_statement", {"customerId": cust["customerId"]}).json()[
        "data"
    ]
    for field in (
        "openingDocuments",
        "payments",
        "aging",
        "closingBalance",
        "availableCredit",
    ):
        assert field in st
    assert st["closingBalance"] == cust["arBalance"]


def test_audit_trail_filters_by_entity():
    c = _client()
    cust = _active_customer(c)
    inv = _api(
        c, "create_invoice", {"customerId": cust["customerId"], "amount": 250}
    ).json()["data"]
    trail = _api(c, "get_audit_trail", {"entityId": inv["invoiceId"]}).json()["data"]
    assert trail["total"] >= 1
    assert all(e["entityId"] == inv["invoiceId"] for e in trail["items"])
    assert any(
        e["action"] in ("invoice.issued", "invoice.drafted") for e in trail["items"]
    )
