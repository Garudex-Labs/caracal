"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Validates the Beacon CRM provider: OAuth2 authorization code with offline refresh-token rotation, granular per-object scopes, and the accounts, contacts, deal pipeline, activity, note, and relationship domain flows.
"""

from __future__ import annotations

import os

os.environ.setdefault("PROVIDERLAB_FAST", "1")

from fastapi.testclient import TestClient

from _mock.providerlab import catalog, credentials
from _mock.providerlab.app import build_app

REDIRECT = "http://127.0.0.1:8000/callback"
ALL_SCOPES = (
    "contacts.read contacts.write accounts.read "
    "deals.read deals.write activities.read activities.write owners.read"
)


def _client() -> TestClient:
    return TestClient(build_app(catalog.get("beacon-crm")))


def _seed() -> dict:
    return credentials.load("beacon-crm").data["seed"]


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


def _token_bundle(c: TestClient, scope: str = ALL_SCOPES) -> dict:
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


def _token(c: TestClient, scope: str = ALL_SCOPES) -> str:
    return _token_bundle(c, scope)["access_token"]


def _api(c: TestClient, token: str, op: str, body: dict | None = None):
    return c.post(
        f"/api/{op}", json=body or {}, headers={"Authorization": f"Bearer {token}"}
    )


def _open_deal(c: TestClient, token: str) -> dict:
    body = _api(c, token, "list_deals", {"status": "open", "pageSize": 50}).json()
    return body["data"]["items"][0]


# --------------------------------------------------------------------------- #
# OAuth: discovery, authorization code, offline refresh-token rotation
# --------------------------------------------------------------------------- #
def test_discovery_advertises_authcode_and_refresh():
    doc = _client().get("/.well-known/oauth-authorization-server").json()
    assert doc["response_types_supported"] == ["code"]
    assert set(doc["grant_types_supported"]) == {"authorization_code", "refresh_token"}
    assert "contacts.read" in doc["scopes_supported"]
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


def test_refresh_preserves_granted_scope():
    c = _client()
    bundle = _token_bundle(c, "contacts.read deals.read")
    refreshed = c.post(
        "/oauth/token",
        data={"grant_type": "refresh_token", "refresh_token": bundle["refresh_token"]},
    ).json()
    assert refreshed["scope"] == "contacts.read deals.read"


# --------------------------------------------------------------------------- #
# Scope enforcement (granular per-object scopes)
# --------------------------------------------------------------------------- #
def test_read_scope_cannot_write_deal():
    c = _client()
    token = _token(c, "deals.read")
    deal = _open_deal(c, token)
    denied = _api(c, token, "update_deal", {"dealId": deal["id"], "stage": "qualified"})
    assert denied.status_code == 403 and denied.json()["error"] == "insufficient_scope"


def test_contact_scope_does_not_grant_accounts():
    c = _client()
    token = _token(c, "contacts.read")
    denied = _api(c, token, "list_accounts", {})
    assert denied.status_code == 403 and denied.json()["error"] == "insufficient_scope"


# --------------------------------------------------------------------------- #
# Contacts
# --------------------------------------------------------------------------- #
def test_contact_shape_is_realistic():
    c = _client()
    token = _token(c)
    contact = _api(c, token, "get_contact", {"contactId": "CONT-00001"}).json()["data"]
    for field in (
        "firstName",
        "lastName",
        "email",
        "jobTitle",
        "accountId",
        "lifecycleStage",
        "leadStatus",
        "ownerId",
        "createdAt",
    ):
        assert field in contact


def test_list_contacts_filters_and_paginates():
    c = _client()
    token = _token(c)
    page = _api(
        c, token, "list_contacts", {"lifecycleStage": "customer", "pageSize": 5}
    ).json()["data"]
    assert page["pageSize"] == 5
    assert all(ct["lifecycleStage"] == "customer" for ct in page["items"])


def test_create_contact_rejects_duplicate_email():
    c = _client()
    token = _token(c)
    existing = _api(c, token, "get_contact", {"contactId": "CONT-00001"}).json()["data"]
    dup = _api(
        c,
        token,
        "create_contact",
        {"firstName": "Test", "lastName": "User", "email": existing["email"]},
    )
    assert dup.status_code == 409 and dup.json()["error"] == "duplicate_contact"


def test_create_contact_then_fetch():
    c = _client()
    token = _token(c)
    created = _api(
        c,
        token,
        "create_contact",
        {
            "firstName": "Ada",
            "lastName": "Lovelace",
            "email": "ada.lovelace@newco.example",
            "jobTitle": "CFO",
        },
    ).json()["data"]
    fetched = _api(c, token, "get_contact", {"contactId": created["id"]}).json()["data"]
    assert fetched["email"] == "ada.lovelace@newco.example"
    assert fetched["lifecycleStage"] == "lead"


def test_get_contact_not_found():
    c = _client()
    token = _token(c)
    assert (
        _api(c, token, "get_contact", {"contactId": "CONT-99999999"}).status_code == 404
    )


# --------------------------------------------------------------------------- #
# Accounts
# --------------------------------------------------------------------------- #
def test_account_shape_and_filter():
    c = _client()
    token = _token(c)
    page = _api(c, token, "list_accounts", {"tier": "enterprise"}).json()["data"]
    assert all(a["tier"] == "enterprise" for a in page["items"])
    if page["items"]:
        account = page["items"][0]
        for field in (
            "industry",
            "domain",
            "employeeCount",
            "annualRevenue",
            "accountType",
        ):
            assert field in account


# --------------------------------------------------------------------------- #
# Deal pipeline
# --------------------------------------------------------------------------- #
def test_update_deal_advances_stage_and_probability():
    c = _client()
    token = _token(c)
    deal = _open_deal(c, token)
    updated = _api(
        c, token, "update_deal", {"dealId": deal["id"], "stage": "negotiation"}
    ).json()["data"]
    assert updated["stage"] == "negotiation"
    assert updated["probability"] == 70
    assert updated["status"] == "open"


def test_update_deal_to_lost_requires_reason():
    c = _client()
    token = _token(c)
    deal = _open_deal(c, token)
    missing = _api(c, token, "update_deal", {"dealId": deal["id"], "stage": "lost"})
    assert (
        missing.status_code == 422 and missing.json()["error"] == "lost_reason_required"
    )
    closed = _api(
        c,
        token,
        "update_deal",
        {"dealId": deal["id"], "stage": "lost", "lostReason": "budget"},
    ).json()["data"]
    assert closed["status"] == "lost" and closed["lostReason"] == "budget"


def test_closed_deal_cannot_be_modified():
    c = _client()
    token = _token(c)
    deal = _open_deal(c, token)
    _api(c, token, "update_deal", {"dealId": deal["id"], "stage": "won"})
    again = _api(c, token, "update_deal", {"dealId": deal["id"], "stage": "qualified"})
    assert again.status_code == 409 and again.json()["error"] == "deal_closed"


def test_update_deal_invalid_stage():
    c = _client()
    token = _token(c)
    deal = _open_deal(c, token)
    bad = _api(c, token, "update_deal", {"dealId": deal["id"], "stage": "frozen"})
    assert bad.status_code == 422 and bad.json()["error"] == "invalid_stage"


# --------------------------------------------------------------------------- #
# Activities, notes, relationships
# --------------------------------------------------------------------------- #
def test_log_activity_validates_type():
    c = _client()
    token = _token(c)
    bad = _api(
        c, token, "log_activity", {"contactId": "CONT-00001", "type": "smoke_signal"}
    )
    assert bad.status_code == 422 and bad.json()["error"] == "invalid_activity_type"


def test_log_activity_and_list():
    c = _client()
    token = _token(c)
    logged = _api(
        c,
        token,
        "log_activity",
        {"contactId": "CONT-00001", "type": "call", "note": "Discussed renewal."},
    ).json()["data"]
    assert logged["type"] == "call" and logged["direction"] == "outbound"
    listed = _api(c, token, "list_activities", {"contactId": "CONT-00001"}).json()[
        "data"
    ]
    assert any(a["activityId"] == logged["activityId"] for a in listed["items"])


def test_add_note_requires_association():
    c = _client()
    token = _token(c)
    bad = _api(c, token, "add_note", {"body": "orphan note"})
    assert bad.status_code == 422 and bad.json()["error"] == "missing_association"
    good = _api(
        c, token, "add_note", {"contactId": "CONT-00001", "body": "Followed up."}
    )
    assert good.status_code == 200 and good.json()["data"]["body"] == "Followed up."


def test_list_relationships_for_account():
    c = _client()
    token = _token(c)
    account_id = _api(c, token, "list_accounts", {"pageSize": 1}).json()["data"][
        "items"
    ][0]["id"]
    rels = _api(c, token, "list_relationships", {"accountId": account_id}).json()[
        "data"
    ]
    assert all(r["accountId"] == account_id for r in rels["items"])


# --------------------------------------------------------------------------- #
# Enriched object fields (real-CRM shapes)
# --------------------------------------------------------------------------- #
def test_account_carries_lifecycle_address_and_rollups():
    c = _client()
    token = _token(c)
    account = _api(c, token, "list_accounts", {"pageSize": 1}).json()["data"]["items"][
        0
    ]
    for field in (
        "lifecycleStage",
        "billingAddress",
        "linkedinUrl",
        "contactCount",
        "openDealCount",
        "lastActivityAt",
    ):
        assert field in account
    assert {"city", "state", "country", "postalCode"} <= set(account["billingAddress"])


def test_contact_carries_marketing_and_seniority_fields():
    c = _client()
    token = _token(c)
    contact = _api(c, token, "get_contact", {"contactId": "CONT-00001"}).json()["data"]
    for field in (
        "mobilePhone",
        "marketingStatus",
        "optedOut",
        "seniority",
        "linkedinUrl",
        "lastContactedAt",
    ):
        assert field in contact
    assert contact["marketingStatus"] in ("subscribed", "unsubscribed", "non_marketing")


def test_deal_carries_forecast_and_weighted_amount():
    c = _client()
    token = _token(c)
    deal = _open_deal(c, token)
    assert {"dealType", "forecastCategory", "weightedAmount", "priority"} <= set(deal)
    assert deal["weightedAmount"] == round(
        deal["amount"] * deal["probability"] / 100, 2
    )


# --------------------------------------------------------------------------- #
# Pipelines (discoverable stage metadata)
# --------------------------------------------------------------------------- #
def test_list_pipelines_exposes_ordered_stages():
    c = _client()
    token = _token(c)
    pipelines = _api(c, token, "list_pipelines", {}).json()["data"]["items"]
    sales = next(p for p in pipelines if p["id"] == "sales")
    stages = sales["stages"]
    assert [s["id"] for s in stages] == [
        "prospect",
        "qualified",
        "proposal",
        "negotiation",
        "won",
        "lost",
    ]
    won = next(s for s in stages if s["id"] == "won")
    assert won["isClosed"] and won["isWon"] and won["probability"] == 100


# --------------------------------------------------------------------------- #
# Owners (CRM portal users)
# --------------------------------------------------------------------------- #
def test_list_owners_filters_active_and_team():
    c = _client()
    token = _token(c)
    page = _api(c, token, "list_owners", {"active": True, "pageSize": 50}).json()[
        "data"
    ]
    assert page["items"] and all(o["active"] for o in page["items"])
    assert all("portalId" in o and "@" in o["email"] for o in page["items"])


def test_get_owner_resolves_deal_owner():
    c = _client()
    token = _token(c)
    deal = _open_deal(c, token)
    owner = _api(c, token, "get_owner", {"ownerId": deal["ownerId"]}).json()["data"]
    assert owner["id"] == deal["ownerId"] and owner["role"]


def test_get_owner_not_found():
    c = _client()
    token = _token(c)
    assert _api(c, token, "get_owner", {"ownerId": "USR-999"}).status_code == 404


def test_owners_require_owners_scope():
    c = _client()
    token = _token(c, "deals.read")
    denied = _api(c, token, "list_owners", {})
    assert denied.status_code == 403 and denied.json()["error"] == "insufficient_scope"


# --------------------------------------------------------------------------- #
# Deal creation
# --------------------------------------------------------------------------- #
def test_create_deal_opens_pipeline_entry():
    c = _client()
    token = _token(c)
    account = _api(c, token, "list_accounts", {"pageSize": 1}).json()["data"]["items"][
        0
    ]
    before = _api(c, token, "get_account", {"accountId": account["id"]}).json()["data"][
        "openDealCount"
    ]
    created = _api(
        c,
        token,
        "create_deal",
        {
            "accountId": account["id"],
            "title": "Managed Services Renewal",
            "amount": 48000,
            "dealType": "renewal",
        },
    ).json()["data"]
    assert created["status"] == "open" and created["stage"] == "prospect"
    assert created["probability"] == 10 and created["forecastCategory"] == "pipeline"
    assert created["weightedAmount"] == 4800.0
    after = _api(c, token, "get_account", {"accountId": account["id"]}).json()["data"][
        "openDealCount"
    ]
    assert after == before + 1


def test_create_deal_validates_account_and_stage():
    c = _client()
    token = _token(c)
    missing = _api(
        c, token, "create_deal", {"accountId": "ACC-9999", "title": "x", "amount": 1000}
    )
    assert missing.status_code == 404 and missing.json()["error"] == "account_not_found"
    account = _api(c, token, "list_accounts", {"pageSize": 1}).json()["data"]["items"][
        0
    ]
    bad_stage = _api(
        c,
        token,
        "create_deal",
        {"accountId": account["id"], "title": "x", "amount": 1000, "stage": "won"},
    )
    assert bad_stage.status_code == 422 and bad_stage.json()["error"] == "invalid_stage"


def test_create_deal_requires_write_scope():
    c = _client()
    token = _token(c, "deals.read accounts.read")
    account = _api(c, token, "list_accounts", {"pageSize": 1}).json()["data"]["items"][
        0
    ]
    denied = _api(
        c,
        token,
        "create_deal",
        {"accountId": account["id"], "title": "x", "amount": 1000},
    )
    assert denied.status_code == 403 and denied.json()["error"] == "insufficient_scope"


# --------------------------------------------------------------------------- #
# Contact updates (email change with dedupe, marketing status)
# --------------------------------------------------------------------------- #
def test_update_contact_changes_marketing_status():
    c = _client()
    token = _token(c)
    updated = _api(
        c,
        token,
        "update_contact",
        {"contactId": "CONT-00001", "marketingStatus": "unsubscribed"},
    ).json()["data"]
    assert updated["marketingStatus"] == "unsubscribed" and updated["optedOut"] is True


def test_update_contact_email_rejects_duplicate():
    c = _client()
    token = _token(c)
    other = _api(c, token, "get_contact", {"contactId": "CONT-00002"}).json()["data"]
    dup = _api(
        c, token, "update_contact", {"contactId": "CONT-00001", "email": other["email"]}
    )
    assert dup.status_code == 409 and dup.json()["error"] == "duplicate_contact"


# --------------------------------------------------------------------------- #
# Task activities carry status and due date
# --------------------------------------------------------------------------- #
def test_log_task_activity_carries_due_date_and_status():
    c = _client()
    token = _token(c)
    task = _api(
        c,
        token,
        "log_activity",
        {
            "contactId": "CONT-00001",
            "type": "task",
            "subject": "Follow up on renewal",
            "dueDate": "2026-07-01",
            "priority": "high",
        },
    ).json()["data"]
    assert task["status"] == "scheduled" and task["dueDate"] == "2026-07-01"
    assert task["priority"] == "high"
