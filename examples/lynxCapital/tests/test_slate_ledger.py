"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Validates the Slate Ledger provider: bearer-token access, double-entry posting and reversal, asynchronous reconciliation, accrual schedules, trial balance, and gated fiscal-period close.
"""

from __future__ import annotations

import os

os.environ.setdefault("PROVIDERLAB_FAST", "1")

from fastapi.testclient import TestClient

from _mock.providerlab import catalog, credentials
from _mock.providerlab import netsim
from _mock.providerlab.app import build_app

import pytest


@pytest.fixture(autouse=True)
def _fresh_rate_limit():
    netsim._buckets.clear()
    yield


def _client() -> TestClient:
    return TestClient(build_app(catalog.get("slate-ledger")))


def _token() -> str:
    return credentials.load("slate-ledger").data["seed"]["bearerToken"]


def _api(c: TestClient, op: str, body: dict):
    return c.post(
        f"/api/{op}", json=body, headers={"Authorization": f"Bearer {_token()}"}
    )


def test_bearer_required():
    c = _client()
    assert c.post("/api/list_accounts", json={}).status_code == 401
    assert (
        c.post(
            "/api/list_accounts", json={}, headers={"Authorization": "Bearer nope"}
        ).status_code
        == 401
    )
    assert _api(c, "list_accounts", {}).status_code == 200


def test_chart_of_accounts_has_normal_balances():
    c = _client()
    body = _api(c, "list_accounts", {"type": "liability"}).json()["data"]
    assert body["total"] >= 4
    ap = _api(c, "get_account", {"accountId": "2000"}).json()["data"]
    assert ap["name"] == "Accounts Payable"
    assert ap["normalBalance"] == "credit" and ap["isControlAccount"] is True
    assert _api(c, "get_account", {"accountId": "0000"}).status_code == 404


def test_double_entry_posting_updates_balances():
    c = _client()
    before = _api(c, "get_account", {"accountId": "6200"}).json()["data"]["balance"]
    posted = _api(
        c,
        "post_entry",
        {
            "period": "2026-01",
            "description": "Cloud subscription",
            "lines": [
                {"accountNo": "6200", "debit": 5000},
                {"accountNo": "2000", "credit": 5000},
            ],
        },
    )
    assert posted.status_code == 200
    entry = posted.json()["data"]
    assert (
        entry["status"] == "posted"
        and entry["totalDebit"] == entry["totalCredit"] == 5000.0
    )
    after = _api(c, "get_account", {"accountId": "6200"}).json()["data"]["balance"]
    assert round(after - before, 2) == 5000.0


def test_post_entry_rejects_unbalanced_and_unknown_account():
    c = _client()
    bad = _api(c, "post_entry", {"lines": [{"debit": 10}, {"credit": 5}]})
    assert bad.status_code == 422 and bad.json()["error"] == "unbalanced"
    unknown = _api(
        c, "post_entry", {"lines": [{"accountNo": "9999", "debit": 5}, {"credit": 5}]}
    )
    assert unknown.status_code == 422 and unknown.json()["error"] == "invalid_account"


def test_reverse_entry_is_idempotent_per_original():
    c = _client()
    jid = _api(
        c,
        "post_entry",
        {
            "period": "2026-01",
            "lines": [
                {"accountNo": "6300", "debit": 1200},
                {"accountNo": "2100", "credit": 1200},
            ],
        },
    ).json()["data"]["journalId"]
    rev = _api(c, "reverse_entry", {"entryId": jid}).json()["data"]
    assert rev["type"] == "reversal" and rev["reversalOf"] == jid
    assert rev["totalDebit"] == 1200.0 and rev["lines"][0]["credit"] == 1200.0
    again = _api(c, "reverse_entry", {"entryId": jid})
    assert again.status_code == 409 and again.json()["error"] == "already_reversed"


def test_reconciliation_is_asynchronous():
    c = _client()
    started = _api(c, "reconcile_account", {"accountId": "1000"}).json()["data"]
    assert started["status"] == "in_progress" and "reconciliationId" in started
    settled = _api(
        c, "get_reconciliation", {"reconciliationId": started["reconciliationId"]}
    ).json()["data"]
    assert settled["status"] == "balanced" and settled["difference"] == 0.0

    diff = _api(
        c,
        "reconcile_account",
        {
            "accountId": "1000",
            "statementBalance": 1_000_000,
            "outstandingItems": [{"amount": 250.0, "type": "deposit_in_transit"}],
        },
    ).json()["data"]
    exc = _api(
        c, "get_reconciliation", {"reconciliationId": diff["reconciliationId"]}
    ).json()["data"]
    assert exc["status"] == "exception" and exc["outstandingTotal"] == 250.0


def test_accrual_schedule_amortizes():
    c = _client()
    acr = _api(
        c,
        "create_accrual",
        {"amount": 120000, "periods": 12, "description": "External audit"},
    ).json()["data"]
    assert acr["perPeriod"] == 10000.0 and acr["status"] == "active"
    assert _api(c, "create_accrual", {"amount": 1000, "periods": 0}).status_code == 422


def test_trial_balance_is_balanced():
    c = _client()
    tb = _api(c, "trial_balance", {}).json()["data"]
    assert tb["balanced"] is True and tb["totalDebit"] == tb["totalCredit"]
    assert any(row["accountNo"] == "2000" for row in tb["rows"])


def test_close_is_gated_then_locks_the_period():
    c = _client()
    pending = _api(
        c, "reconcile_account", {"accountId": "1020", "period": "2026-02"}
    ).json()["data"]
    blocked = _api(c, "close_period", {"period": "2026-02"})
    assert (
        blocked.status_code == 409
        and blocked.json()["error"] == "reconciliations_incomplete"
    )
    _api(c, "get_reconciliation", {"reconciliationId": pending["reconciliationId"]})

    closed = _api(c, "close_period", {"period": "2026-02"}).json()["data"]
    assert closed["status"] == "closed"
    assert all(task["status"] == "complete" for task in closed["checklist"])
    assert _api(c, "close_period", {"period": "2026-02"}).status_code == 409
    locked = _api(
        c, "post_entry", {"period": "2026-02", "lines": [{"debit": 1}, {"credit": 1}]}
    )
    assert locked.status_code == 409 and locked.json()["error"] == "period_closed"


def test_accounts_carry_realistic_master_fields():
    c = _client()
    cash = _api(c, "get_account", {"accountId": "1000"}).json()["data"]
    assert cash["classification"] == "balance_sheet"
    assert cash["isBankAccount"] is True and len(cash["bankAccountLast4"]) == 4
    assert cash["reconciliationRequired"] is True and "openingBalance" in cash
    accum = _api(c, "get_account", {"accountId": "1510"}).json()["data"]
    assert accum["parentAccountNo"] == "1500"


def test_post_entry_is_idempotent_on_key():
    c = _client()
    body = {
        "period": "2026-03",
        "idempotencyKey": "close-je-1",
        "lines": [
            {"accountNo": "6200", "debit": 800},
            {"accountNo": "2000", "credit": 800},
        ],
    }
    first = _api(c, "post_entry", body).json()["data"]
    again = _api(c, "post_entry", body).json()["data"]
    assert first["journalId"] == again["journalId"]
    balance = _api(c, "get_account", {"accountId": "6200"}).json()["data"]["balance"]
    third = _api(c, "post_entry", body)
    assert (
        _api(c, "get_account", {"accountId": "6200"}).json()["data"]["balance"]
        == balance
    )


def test_post_entry_rejects_line_with_debit_and_credit():
    c = _client()
    bad = _api(
        c,
        "post_entry",
        {
            "lines": [
                {"accountNo": "6200", "debit": 10, "credit": 10},
                {"accountNo": "2000", "credit": 10},
            ]
        },
    )
    assert bad.status_code == 422 and bad.json()["error"] == "invalid_line"


def test_draft_entry_routes_through_maker_checker():
    c = _client()
    before = _api(c, "get_account", {"accountId": "6300"}).json()["data"]["balance"]
    draft = _api(
        c,
        "post_entry",
        {
            "period": "2026-03",
            "status": "draft",
            "createdBy": "maker@lynx.test",
            "lines": [
                {"accountNo": "6300", "debit": 2000},
                {"accountNo": "2100", "credit": 2000},
            ],
        },
    ).json()["data"]
    assert (
        draft["status"] == "pending_approval" and draft["approvalStatus"] == "pending"
    )
    assert (
        _api(c, "get_account", {"accountId": "6300"}).json()["data"]["balance"]
        == before
    )
    self_appr = _api(
        c,
        "approve_entry",
        {"entryId": draft["journalId"], "approvedBy": "maker@lynx.test"},
    )
    assert self_appr.status_code == 409 and self_appr.json()["error"] == "self_approval"
    posted = _api(
        c,
        "approve_entry",
        {"entryId": draft["journalId"], "approvedBy": "checker@lynx.test"},
    ).json()["data"]
    assert posted["status"] == "posted" and posted["approvedBy"] == "checker@lynx.test"
    assert (
        round(
            _api(c, "get_account", {"accountId": "6300"}).json()["data"]["balance"]
            - before,
            2,
        )
        == 2000.0
    )


def test_draft_entry_blocks_close():
    c = _client()
    _api(
        c,
        "post_entry",
        {
            "period": "2026-03",
            "status": "draft",
            "createdBy": "maker@lynx.test",
            "lines": [
                {"accountNo": "6300", "debit": 50},
                {"accountNo": "2100", "credit": 50},
            ],
        },
    )
    blocked = _api(c, "close_period", {"period": "2026-03"})
    assert (
        blocked.status_code == 409 and blocked.json()["error"] == "entries_unapproved"
    )


def test_list_reconciliations_filters():
    c = _client()
    started = _api(
        c, "reconcile_account", {"accountId": "1000", "period": "2026-03"}
    ).json()["data"]
    listed = _api(c, "list_reconciliations", {"status": "in_progress"}).json()["data"]
    assert any(
        r["reconciliationId"] == started["reconciliationId"] for r in listed["items"]
    )
    assert all(r["status"] == "in_progress" for r in listed["items"])


def test_accrual_schedule_posts_and_advances():
    c = _client()
    accruals = _api(c, "list_accruals", {"status": "active"}).json()["data"]["items"]
    target = accruals[0]
    fetched = _api(c, "get_accrual", {"accrualId": target["accrualId"]}).json()["data"]
    assert fetched["accrualId"] == target["accrualId"] and "remainingAmount" in fetched
    posted = _api(
        c, "post_accrual", {"accrualId": target["accrualId"], "period": "2026-03"}
    ).json()["data"]
    assert (
        posted["entry"]["type"] == "accrual" and posted["entry"]["status"] == "posted"
    )
    assert posted["accrual"]["postedPeriods"] == fetched["postedPeriods"] + 1


def test_soft_close_then_reopen():
    c = _client()
    soft = _api(c, "close_period", {"period": "2026-05", "softClose": True}).json()[
        "data"
    ]
    assert soft["status"] == "soft_closed" and soft["closeType"] == "soft"
    assert (
        _api(
            c,
            "post_entry",
            {"period": "2026-05", "lines": [{"debit": 1}, {"credit": 1}]},
        ).status_code
        == 409
    )
    reopened = _api(c, "reopen_period", {"period": "2026-05"}).json()["data"]
    assert reopened["status"] == "open" and reopened["reopenedBy"]
    assert (
        _api(
            c,
            "post_entry",
            {
                "period": "2026-05",
                "lines": [
                    {"accountNo": "6200", "debit": 5},
                    {"accountNo": "2000", "credit": 5},
                ],
            },
        ).status_code
        == 200
    )


def test_hard_close_reopen_requires_force_and_locked_blocks():
    c = _client()
    _api(c, "close_period", {"period": "2026-06"})
    guarded = _api(c, "reopen_period", {"period": "2026-06"})
    assert guarded.status_code == 409 and guarded.json()["error"] == "hard_close_locked"
    forced = _api(c, "reopen_period", {"period": "2026-06", "force": True}).json()[
        "data"
    ]
    assert forced["status"] == "open"
    locked = _api(c, "reopen_period", {"period": "2025-11"})
    assert locked.status_code == 409 and locked.json()["error"] == "period_locked"
