"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Beacon CRM domain: vendor and customer contacts, accounts, deal pipeline, and activity logging.
"""
from __future__ import annotations

from _mock.providerlab import intelligence
from _mock.providerlab.data import generators as gen
from _mock.providerlab.providers import base
from _mock.providerlab.providers.base import Ctx, DomainError

ID = "beacon-crm"

_STAGES = ("prospect", "qualified", "proposal", "negotiation", "won", "lost")


@base.seeder(ID)
def seed(state: base.State) -> None:
    people = gen.contacts(ID, 300)
    state.tables["contacts"] = gen.index_by(people)
    accounts = {}
    deals = {}
    for i, c in enumerate(people, start=1):
        rng = gen._rng(ID, "deal", i)
        if rng.random() > 0.5:
            did = f"DEAL-{i:05d}"
            deals[did] = {"id": did, "contactId": c["id"], "amount": round(rng.uniform(5_000, 400_000), 2),
                          "stage": rng.choice(_STAGES), "currency": "USD"}
        acc_id = f"ACC-{(i % 80) + 1:04d}"
        accounts.setdefault(acc_id, {"id": acc_id, "name": c["company"], "tier": "smb"})
    state.tables["accounts"] = accounts
    state.tables["deals"] = deals
    state.tables["activities"] = {}


@base.op(ID, "get_contact")
def get_contact(ctx: Ctx) -> dict:
    ctx.require_scope("contacts.read")
    ctx.require("contactId")
    contact = ctx.state.table("contacts").get(ctx.payload["contactId"])
    if contact is None:
        raise DomainError(404, "contact_not_found", ctx.payload["contactId"])
    return contact


@base.op(ID, "list_contacts")
def list_contacts(ctx: Ctx) -> dict:
    ctx.require_scope("contacts.read")
    items = list(ctx.state.table("contacts").values())
    stage = ctx.get("stage")
    if stage:
        items = [c for c in items if c["stage"] == stage]
    query = str(ctx.get("query", "")).lower()
    if query:
        items = [c for c in items if query in c["name"].lower() or query in c["company"].lower()]
    return ctx.paginate(items, size_default=25)


@base.op(ID, "update_deal")
def update_deal(ctx: Ctx) -> dict:
    ctx.require_scope("deals.write")
    ctx.require("dealId", "stage")
    deal = ctx.state.table("deals").get(ctx.payload["dealId"])
    if deal is None:
        raise DomainError(404, "deal_not_found", ctx.payload["dealId"])
    if ctx.payload["stage"] not in _STAGES:
        raise DomainError(422, "invalid_stage", "unknown deal stage")
    if deal["stage"] in ("won", "lost"):
        raise DomainError(409, "deal_closed", "closed deals cannot change stage")
    deal["stage"] = ctx.payload["stage"]
    return deal


@base.op(ID, "log_activity")
def log_activity(ctx: Ctx) -> dict:
    ctx.require_scope("deals.write")
    ctx.require("contactId", "type")
    if ctx.payload["contactId"] not in ctx.state.table("contacts"):
        raise DomainError(404, "contact_not_found", ctx.payload["contactId"])
    note = ctx.get("note", "")
    activity = {"activityId": base.new_id("act"), "contactId": ctx.payload["contactId"],
                "type": ctx.payload["type"],
                "summary": intelligence.narrative(
                    "You are a CRM assistant. Summarize this activity in one short sentence.",
                    note or f"{ctx.payload['type']} logged.",
                    note or f"{ctx.payload['type'].title()} recorded for contact {ctx.payload['contactId']}."),
                "at": base.now()}
    ctx.state.table("activities")[activity["activityId"]] = activity
    return activity


@base.op(ID, "get_account")
def get_account(ctx: Ctx) -> dict:
    ctx.require_scope("contacts.read")
    ctx.require("accountId")
    acc = ctx.state.table("accounts").get(ctx.payload["accountId"])
    if acc is None:
        raise DomainError(404, "account_not_found", ctx.payload["accountId"])
    return acc
