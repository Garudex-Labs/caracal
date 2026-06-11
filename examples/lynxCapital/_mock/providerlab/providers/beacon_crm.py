"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Beacon CRM domain: accounts, contacts, a sales deal pipeline, and the engagement history of activities, notes, and contact relationships.
"""
from __future__ import annotations

import time

from _mock.providerlab import intelligence
from _mock.providerlab.data import generators as gen
from _mock.providerlab.providers import base
from _mock.providerlab.providers.base import Ctx, DomainError

ID = "beacon-crm"

_STAGE_PROB = dict(gen.CRM_STAGES)
_STAGES = tuple(name for name, _ in gen.CRM_STAGES)
_OPEN_STAGES = tuple(name for name in _STAGES if name not in ("won", "lost"))
_ACTIVITY_TYPES = ("call", "email", "meeting", "note", "task")


def _iso(epoch: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


@base.seeder(ID)
def seed(state: base.State) -> None:
    for name, table in gen.crm_dataset(ID).items():
        state.tables[name] = table


# --------------------------------------------------------------------------- #
# Contacts
# --------------------------------------------------------------------------- #
@base.op(ID, "list_contacts")
def list_contacts(ctx: Ctx) -> dict:
    ctx.require_scope("contacts.read")
    items = list(ctx.state.table("contacts").values())
    stage = ctx.get("lifecycleStage")
    if stage:
        items = [c for c in items if c["lifecycleStage"] == stage]
    account_id = ctx.get("accountId")
    if account_id:
        items = [c for c in items if c["accountId"] == account_id]
    query = str(ctx.get("query", "")).lower()
    if query:
        items = [c for c in items
                 if query in f"{c['firstName']} {c['lastName']}".lower()
                 or query in c["email"].lower()
                 or query in c["company"].lower()]
    items.sort(key=lambda c: c["id"])
    return ctx.paginate(items, size_default=25)


@base.op(ID, "get_contact")
def get_contact(ctx: Ctx) -> dict:
    ctx.require_scope("contacts.read")
    ctx.require("contactId")
    contact = ctx.state.table("contacts").get(ctx.payload["contactId"])
    if contact is None:
        raise DomainError(404, "contact_not_found", ctx.payload["contactId"])
    return contact


@base.op(ID, "create_contact")
def create_contact(ctx: Ctx) -> dict:
    ctx.require_scope("contacts.write")
    ctx.require("firstName", "lastName", "email")
    email = str(ctx.payload["email"])
    if "@" not in email:
        raise DomainError(422, "invalid_email", "email is not a valid address")
    contacts = ctx.state.table("contacts")
    if any(c["email"].lower() == email.lower() for c in contacts.values()):
        raise DomainError(409, "duplicate_contact", f"a contact with email {email} already exists")
    account_id = ctx.get("accountId")
    account = ctx.state.table("accounts").get(account_id) if account_id else None
    if account_id and account is None:
        raise DomainError(404, "account_not_found", account_id)
    now = base.now()
    contact = {
        "id": ctx.state.next_id("CONT"),
        "firstName": ctx.payload["firstName"],
        "lastName": ctx.payload["lastName"],
        "email": email,
        "phone": ctx.get("phone", ""),
        "jobTitle": ctx.get("jobTitle", ""),
        "company": account["name"] if account else ctx.get("company", ""),
        "accountId": account_id,
        "lifecycleStage": ctx.get("lifecycleStage", "lead"),
        "leadStatus": ctx.get("leadStatus", "new"),
        "source": ctx.get("source", "inbound"),
        "ownerId": ctx.get("ownerId", account["ownerId"] if account else "USR-001"),
        "tags": list(ctx.get("tags", [])),
        "country": account["country"] if account else ctx.get("country", ""),
        "isPrimary": False,
        "createdAt": _iso(now),
        "updatedAt": _iso(now),
        "lastActivityAt": _iso(now),
    }
    contacts[contact["id"]] = contact
    return contact


@base.op(ID, "update_contact")
def update_contact(ctx: Ctx) -> dict:
    ctx.require_scope("contacts.write")
    ctx.require("contactId")
    contact = ctx.state.table("contacts").get(ctx.payload["contactId"])
    if contact is None:
        raise DomainError(404, "contact_not_found", ctx.payload["contactId"])
    for field in ("jobTitle", "phone", "lifecycleStage", "leadStatus", "ownerId", "tags"):
        if ctx.get(field) is not None:
            contact[field] = ctx.payload[field]
    contact["updatedAt"] = _iso(base.now())
    return contact


# --------------------------------------------------------------------------- #
# Accounts
# --------------------------------------------------------------------------- #
@base.op(ID, "list_accounts")
def list_accounts(ctx: Ctx) -> dict:
    ctx.require_scope("accounts.read")
    items = list(ctx.state.table("accounts").values())
    account_type = ctx.get("accountType")
    if account_type:
        items = [a for a in items if a["accountType"] == account_type]
    tier = ctx.get("tier")
    if tier:
        items = [a for a in items if a["tier"] == tier]
    query = str(ctx.get("query", "")).lower()
    if query:
        items = [a for a in items
                 if query in a["name"].lower() or query in a["domain"].lower()]
    items.sort(key=lambda a: a["id"])
    return ctx.paginate(items, size_default=25)


@base.op(ID, "get_account")
def get_account(ctx: Ctx) -> dict:
    ctx.require_scope("accounts.read")
    ctx.require("accountId")
    account = ctx.state.table("accounts").get(ctx.payload["accountId"])
    if account is None:
        raise DomainError(404, "account_not_found", ctx.payload["accountId"])
    return account


# --------------------------------------------------------------------------- #
# Deals
# --------------------------------------------------------------------------- #
@base.op(ID, "list_deals")
def list_deals(ctx: Ctx) -> dict:
    ctx.require_scope("deals.read")
    items = list(ctx.state.table("deals").values())
    account_id = ctx.get("accountId")
    if account_id:
        items = [d for d in items if d["accountId"] == account_id]
    stage = ctx.get("stage")
    if stage:
        items = [d for d in items if d["stage"] == stage]
    status = ctx.get("status")
    if status:
        items = [d for d in items if d["status"] == status]
    items.sort(key=lambda d: d["updatedAt"], reverse=True)
    return ctx.paginate(items, size_default=25)


@base.op(ID, "get_deal")
def get_deal(ctx: Ctx) -> dict:
    ctx.require_scope("deals.read")
    ctx.require("dealId")
    deal = ctx.state.table("deals").get(ctx.payload["dealId"])
    if deal is None:
        raise DomainError(404, "deal_not_found", ctx.payload["dealId"])
    return deal


@base.op(ID, "update_deal")
def update_deal(ctx: Ctx) -> dict:
    ctx.require_scope("deals.write")
    ctx.require("dealId")
    deal = ctx.state.table("deals").get(ctx.payload["dealId"])
    if deal is None:
        raise DomainError(404, "deal_not_found", ctx.payload["dealId"])
    if deal["status"] in ("won", "lost"):
        raise DomainError(409, "deal_closed", "closed deals cannot be modified")

    account = ctx.state.table("accounts").get(deal["accountId"])
    stage = ctx.get("stage")
    if stage is not None:
        if stage not in _STAGES:
            raise DomainError(422, "invalid_stage", f"unknown deal stage {stage!r}")
        if stage == "lost" and not ctx.get("lostReason"):
            raise DomainError(422, "lost_reason_required",
                              "moving a deal to 'lost' requires lostReason")
        if deal["stage"] in _OPEN_STAGES and stage in ("won", "lost") and account:
            account["openDealCount"] = max(0, account["openDealCount"] - 1)
        deal["stage"] = stage
        deal["probability"] = _STAGE_PROB[stage]
        deal["status"] = {"won": "won", "lost": "lost"}.get(stage, "open")
        if stage == "won":
            deal["wonAt"] = _iso(base.now())
            deal["closedAt"] = deal["wonAt"]
        elif stage == "lost":
            deal["lostReason"] = ctx.payload["lostReason"]
            deal["closedAt"] = _iso(base.now())

    if ctx.get("amount") is not None:
        try:
            deal["amount"] = round(float(ctx.payload["amount"]), 2)
        except (TypeError, ValueError):
            raise DomainError(422, "invalid_amount", "amount must be a number")
    if ctx.get("expectedCloseDate") is not None:
        deal["expectedCloseDate"] = ctx.payload["expectedCloseDate"]

    deal["updatedAt"] = _iso(base.now())
    return deal


# --------------------------------------------------------------------------- #
# Activities and notes
# --------------------------------------------------------------------------- #
@base.op(ID, "list_activities")
def list_activities(ctx: Ctx) -> dict:
    ctx.require_scope("activities.read")
    items = list(ctx.state.table("activities").values())
    contact_id = ctx.get("contactId")
    if contact_id:
        items = [a for a in items if a["contactId"] == contact_id]
    deal_id = ctx.get("dealId")
    if deal_id:
        items = [a for a in items if a["dealId"] == deal_id]
    kind = ctx.get("type")
    if kind:
        items = [a for a in items if a["type"] == kind]
    items.sort(key=lambda a: a["at"], reverse=True)
    return ctx.paginate(items, size_default=25)


@base.op(ID, "log_activity")
def log_activity(ctx: Ctx) -> dict:
    ctx.require_scope("activities.write")
    ctx.require("contactId", "type")
    contact = ctx.state.table("contacts").get(ctx.payload["contactId"])
    if contact is None:
        raise DomainError(404, "contact_not_found", ctx.payload["contactId"])
    kind = ctx.payload["type"]
    if kind not in _ACTIVITY_TYPES:
        raise DomainError(422, "invalid_activity_type",
                          f"type must be one of {', '.join(_ACTIVITY_TYPES)}")
    deal_id = ctx.get("dealId")
    if deal_id and deal_id not in ctx.state.table("deals"):
        raise DomainError(404, "deal_not_found", deal_id)
    note = ctx.get("note", "")
    now = base.now()
    activity = {
        "activityId": ctx.state.next_id("ACT"),
        "type": kind,
        "contactId": contact["id"],
        "accountId": contact["accountId"],
        "dealId": deal_id,
        "subject": ctx.get("subject", f"{kind.title()} with {contact['firstName']} {contact['lastName']}"),
        "summary": intelligence.narrative(
            "You are a CRM assistant. Summarize this activity in one short sentence.",
            note or f"{kind} logged.",
            note or f"{kind.title()} recorded for contact {contact['id']}."),
        "direction": ctx.get("direction", "outbound"),
        "outcome": ctx.get("outcome", "completed"),
        "ownerId": contact["ownerId"],
        "at": _iso(now),
        "createdAt": _iso(now),
    }
    ctx.state.table("activities")[activity["activityId"]] = activity
    contact["lastActivityAt"] = activity["at"]
    return activity


@base.op(ID, "add_note")
def add_note(ctx: Ctx) -> dict:
    ctx.require_scope("activities.write")
    ctx.require("body")
    contact_id = ctx.get("contactId")
    account_id = ctx.get("accountId")
    deal_id = ctx.get("dealId")
    if not (contact_id or account_id or deal_id):
        raise DomainError(422, "missing_association",
                          "a note must reference a contactId, accountId, or dealId")
    if contact_id and contact_id not in ctx.state.table("contacts"):
        raise DomainError(404, "contact_not_found", contact_id)
    if account_id and account_id not in ctx.state.table("accounts"):
        raise DomainError(404, "account_not_found", account_id)
    if deal_id and deal_id not in ctx.state.table("deals"):
        raise DomainError(404, "deal_not_found", deal_id)
    now = base.now()
    note = {
        "noteId": ctx.state.next_id("NOTE"),
        "contactId": contact_id,
        "accountId": account_id,
        "dealId": deal_id,
        "body": ctx.payload["body"],
        "ownerId": ctx.get("ownerId", "USR-001"),
        "createdAt": _iso(now),
    }
    ctx.state.table("notes")[note["noteId"]] = note
    return note


@base.op(ID, "list_notes")
def list_notes(ctx: Ctx) -> dict:
    ctx.require_scope("activities.read")
    items = list(ctx.state.table("notes").values())
    for field in ("contactId", "accountId", "dealId"):
        value = ctx.get(field)
        if value:
            items = [n for n in items if n.get(field) == value]
    items.sort(key=lambda n: n["createdAt"], reverse=True)
    return ctx.paginate(items, size_default=25)


# --------------------------------------------------------------------------- #
# Relationships
# --------------------------------------------------------------------------- #
@base.op(ID, "list_relationships")
def list_relationships(ctx: Ctx) -> dict:
    ctx.require_scope("contacts.read")
    items = list(ctx.state.table("relationships").values())
    contact_id = ctx.get("contactId")
    if contact_id:
        items = [r for r in items
                 if r["fromContactId"] == contact_id or r["toContactId"] == contact_id]
    account_id = ctx.get("accountId")
    if account_id:
        items = [r for r in items if r["accountId"] == account_id]
    return ctx.paginate(items, size_default=25)
