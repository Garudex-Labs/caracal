"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Atlas Vendor Network domain: MCP tool server for vendor master data, onboarding, verification, compliance, and contract lifecycle.
"""

from __future__ import annotations

import hashlib
import random
from datetime import datetime, timedelta, timezone

from _mock.providerlab.data import generators as gen
from _mock.providerlab.providers import base
from _mock.providerlab.providers.base import Ctx, DomainError

ID = "atlas-vendor"

_STATUSES = ("active", "on_hold", "suspended", "offboarded")
_DOC_TYPES = ("w9", "coi", "bank_letter", "msa", "registration", "other")
_ONBOARDING_STEPS = ("profile", "tax", "kyb", "banking", "documents", "approval")
_STEP_LABELS = (
    "Company profile captured",
    "Tax identification validated",
    "KYB / sanctions screening cleared",
    "Bank account verified",
    "Required documents collected",
    "Final approval and activation",
)
_PROFILE_FIELDS = ("displayName", "category", "paymentTerms", "website", "currency")
_SCREENING_PROVIDER = "ComplyAdvantage"
_SCREENING_PROVIDERS = (
    "Dow Jones Risk & Compliance",
    "Refinitiv World-Check",
    "LexisNexis Bridger",
    "ComplyAdvantage",
)
_SANCTIONS_LISTS = ("OFAC SDN", "EU Consolidated", "UN Consolidated", "UK HMT")
_DIVERSITY = (
    "minority_owned",
    "women_owned",
    "veteran_owned",
    "small_business",
    "lgbtq_owned",
)
_CATEGORIES = (
    ("Software", "43230000"),
    ("Professional Services", "80100000"),
    ("Facilities", "72100000"),
    ("Logistics", "78100000"),
    ("Hardware", "43210000"),
    ("Marketing", "82100000"),
    ("Utilities", "83100000"),
    ("Consulting", "80101500"),
    ("Manufacturing", "73100000"),
    ("Travel", "90120000"),
)

_VENDOR_REF = {
    "type": "object",
    "properties": {
        "vendorId": {
            "type": "string",
            "description": "Vendor identifier, e.g. VEND-00042",
        }
    },
    "required": ["vendorId"],
}
_VENDOR_OUTPUT = {
    "type": "object",
    "properties": {
        "id": {"type": "string"},
        "legalName": {"type": "string"},
        "status": {"type": "string"},
        "lifecycleStage": {"type": "string"},
        "riskTier": {"type": "string"},
    },
    "required": ["id", "legalName", "status"],
}
_COMPLIANCE_OUTPUT = {
    "type": "object",
    "properties": {
        "vendorId": {"type": "string"},
        "riskTier": {"type": "string"},
        "riskScore": {"type": "integer"},
        "clearedToPay": {"type": "boolean"},
        "blockingChecks": {"type": "array", "items": {"type": "string"}},
        "compliance": {"type": "object"},
    },
    "required": ["vendorId", "clearedToPay", "blockingChecks"],
}
_ONBOARDING_OUTPUT = {
    "type": "object",
    "properties": {
        "vendorId": {"type": "string"},
        "onboarding": {"type": "object"},
        "progress": {"type": "object"},
    },
    "required": ["vendorId", "onboarding"],
}
_PAGE_PROPS = {
    "page": {"type": "integer", "minimum": 1, "default": 1},
    "pageSize": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20},
}


def _now() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _record_event(vendor: dict, kind: str, summary: str, *, actor: str = "api") -> dict:
    """Append a change-history entry to the vendor record, newest first."""
    events = vendor.setdefault("events", [])
    entry = {
        "eventId": f"EVT-{vendor['id'].split('-')[-1]}-{len(events) + 1:03d}",
        "type": kind,
        "summary": summary,
        "actor": actor,
        "occurredAt": _now(),
    }
    events.insert(0, entry)
    vendor["updatedAt"] = entry["occurredAt"]
    return entry


def _categories() -> list[dict]:
    return [
        {"code": code, "name": name, "segment": code[:2] + "000000"}
        for name, code in _CATEGORIES
    ]


def _rng(vendor_id: str) -> random.Random:
    digest = hashlib.sha256(f"atlas-enrich:{vendor_id}".encode()).hexdigest()
    return random.Random(int(digest[:16], 16))


def _seed_instant(rng: random.Random, lo: int, hi: int) -> str:
    when = datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(
        days=rng.randint(lo, hi), seconds=rng.randint(0, 86399)
    )
    return when.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _enrich(vendor: dict) -> dict:
    """Augment a generated vendor with beneficial-ownership, classification, screening,
    and audit-history detail a real vendor-MDM platform would carry."""
    rng = _rng(vendor["id"])
    stage = vendor.get("lifecycleStage")
    country = vendor.get("country", "US")

    owners, remaining = [], 100
    for n in range(rng.randint(1, 3)):
        if remaining <= 0:
            break
        share = remaining if n == 2 else rng.randint(15, min(60, remaining))
        remaining -= share
        owners.append(
            {
                "ownerId": f"UBO-{rng.randint(10**4, 10**5 - 1)}",
                "name": gen._person(rng),
                "type": "individual",
                "ownershipPercent": share,
                "nationality": country,
                "screened": rng.random() > 0.1,
                "pep": rng.random() < 0.06,
            }
        )
    vendor["beneficialOwners"] = owners

    diversity = rng.sample(_DIVERSITY, rng.randint(1, 2)) if rng.random() < 0.25 else []
    vendor["classifications"] = {
        "diversity": diversity,
        "diversityCertified": bool(diversity),
        "smallBusiness": "small_business" in diversity or rng.random() < 0.2,
        "esgScore": rng.randint(28, 95),
        "strategic": rng.random() < 0.15 and stage == "active",
    }

    compliance = vendor.setdefault("compliance", {})
    compliance.setdefault("sanctionsLists", list(_SANCTIONS_LISTS))
    compliance.setdefault("adverseMedia", "none" if rng.random() > 0.08 else "review")
    compliance.setdefault(
        "watchlistHits", 0 if rng.random() > 0.05 else rng.randint(1, 3)
    )
    compliance.setdefault(
        "uboVerified", stage in ("active", "suspended") and rng.random() > 0.2
    )
    compliance.setdefault("screeningProvider", rng.choice(_SCREENING_PROVIDERS))
    compliance.setdefault("lastScreenedAt", _seed_instant(rng, -200, -10))

    events: list[dict] = []
    seq = 0

    def add(kind: str, summary: str, when: str, actor: str) -> None:
        nonlocal seq
        seq += 1
        events.append(
            {
                "eventId": f"EVT-{vendor['id'].split('-')[-1]}-{seq:03d}",
                "type": kind,
                "summary": summary,
                "actor": actor,
                "occurredAt": when,
            }
        )

    add(
        "vendor.registered",
        "Vendor master record created",
        _seed_instant(rng, -540, -300),
        "intake-queue",
    )
    for step in vendor.get("onboarding", {}).get("checklist", []):
        if step.get("status") == "completed" and step.get("completedAt"):
            when = step["completedAt"]
            add(
                f"onboarding.{step['step']}.completed",
                step["label"],
                when if "T" in str(when) else f"{when}T12:00:00Z",
                "intake-queue",
            )
    if stage in ("active", "suspended"):
        add(
            "compliance.screening.completed",
            "KYB and sanctions screening cleared",
            compliance["lastScreenedAt"],
            compliance["screeningProvider"],
        )
    if stage == "active":
        add(
            "vendor.activated",
            "Vendor activated for transacting",
            _seed_instant(rng, -180, -5),
            gen._person(rng),
        )
    if stage == "suspended":
        add(
            "vendor.suspended",
            "Vendor suspended pending review",
            _seed_instant(rng, -30, -2),
            gen._person(rng),
        )
    events.sort(key=lambda e: e["occurredAt"], reverse=True)
    vendor["events"] = events
    return vendor


@base.seeder(ID)
def seed(state: base.State) -> None:
    vendors = gen.atlas_vendors(ID, 240)
    for vendor in vendors:
        _enrich(vendor)
    state.tables["vendors"] = gen.index_by(vendors)
    state.tables["contracts"] = gen.atlas_contracts(ID, vendors)
    state.tables["categories"] = {c["code"]: c for c in _categories()}


def _vendor(ctx: Ctx) -> dict:
    ctx.require("vendorId")
    vendor = ctx.state.table("vendors").get(ctx.payload["vendorId"])
    if vendor is None:
        raise DomainError(404, "vendor_not_found", ctx.payload["vendorId"])
    return vendor


def _matches_filters(ctx: Ctx, vendor: dict) -> bool:
    for field in ("status", "riskTier", "category"):
        wanted = ctx.get(field)
        if wanted and vendor.get(field) != wanted:
            return False
    country = ctx.get("country")
    if country and vendor.get("country") != country:
        return False
    return True


def _summary(vendor: dict) -> dict:
    return {
        "id": vendor["id"],
        "legalName": vendor.get("legalName"),
        "displayName": vendor.get("displayName"),
        "country": vendor.get("country"),
        "currency": vendor.get("currency"),
        "category": vendor.get("category"),
        "status": vendor.get("status"),
        "lifecycleStage": vendor.get("lifecycleStage"),
        "riskTier": vendor.get("riskTier"),
        "paymentTerms": vendor.get("paymentTerms"),
    }


# --------------------------------------------------------------------------- #
# Discovery and master-data reads
# --------------------------------------------------------------------------- #
@base.op(
    ID,
    "search_vendors",
    title="Search vendors",
    description="Full-text search across the vendor master with optional status, "
    "risk-tier, country, and category filters.",
    input_schema={
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Name or country search term"},
            "status": {"type": "string", "enum": list(_STATUSES)},
            "riskTier": {"type": "string", "enum": ["low", "medium", "high"]},
            "country": {
                "type": "string",
                "description": "ISO 3166-1 alpha-2 country code",
            },
            "category": {"type": "string"},
            "page": _PAGE_PROPS["page"],
            "pageSize": _PAGE_PROPS["pageSize"],
        },
        "required": ["query"],
    },
    annotations={"readOnlyHint": True, "idempotentHint": True},
)
def search_vendors(ctx: Ctx) -> dict:
    ctx.require("query")
    query = str(ctx.payload["query"]).lower()
    items = []
    for v in ctx.state.table("vendors").values():
        if (
            query not in v["displayName"].lower()
            and query not in v.get("country", "").lower()
        ):
            continue
        if not _matches_filters(ctx, v):
            continue
        items.append(_summary(v))
    return ctx.paginate(items, size_default=20)


@base.op(
    ID,
    "list_vendors",
    title="List vendors",
    description="List vendor master records, optionally filtered by lifecycle status, "
    "risk tier, or category.",
    input_schema={
        "type": "object",
        "properties": {
            "status": {"type": "string", "enum": list(_STATUSES)},
            "riskTier": {"type": "string", "enum": ["low", "medium", "high"]},
            "category": {"type": "string"},
            "page": _PAGE_PROPS["page"],
            "pageSize": _PAGE_PROPS["pageSize"],
        },
    },
    annotations={"readOnlyHint": True, "idempotentHint": True},
)
def list_vendors(ctx: Ctx) -> dict:
    items = [
        _summary(v)
        for v in ctx.state.table("vendors").values()
        if _matches_filters(ctx, v)
    ]
    return ctx.paginate(items, size_default=25)


@base.op(
    ID,
    "get_vendor_profile",
    title="Get vendor profile",
    description="Retrieve the full master-data profile for a vendor, including "
    "contacts, banking, compliance, documents, and onboarding state.",
    input_schema=_VENDOR_REF,
    output_schema=_VENDOR_OUTPUT,
    annotations={"readOnlyHint": True, "idempotentHint": True},
)
def get_vendor_profile(ctx: Ctx) -> dict:
    return _vendor(ctx)


@base.op(
    ID,
    "list_vendor_contacts",
    title="List vendor contacts",
    description="List the registered business contacts for a vendor.",
    input_schema=_VENDOR_REF,
    annotations={"readOnlyHint": True, "idempotentHint": True},
)
def list_vendor_contacts(ctx: Ctx) -> dict:
    vendor = _vendor(ctx)
    return {"vendorId": vendor["id"], "items": vendor.get("contacts", [])}


@base.op(
    ID,
    "update_vendor_profile",
    title="Update vendor profile",
    description="Update mutable master-data fields on a vendor record (display name, "
    "category, payment terms, website, currency).",
    input_schema={
        "type": "object",
        "properties": {
            "vendorId": {"type": "string"},
            "displayName": {"type": "string"},
            "category": {"type": "string"},
            "paymentTerms": {
                "type": "string",
                "enum": ["NET15", "NET30", "NET45", "NET60"],
            },
            "website": {"type": "string"},
            "currency": {"type": "string", "description": "ISO 4217 currency code"},
        },
        "required": ["vendorId"],
    },
    output_schema=_VENDOR_OUTPUT,
    annotations={"readOnlyHint": False, "idempotentHint": True},
)
def update_vendor_profile(ctx: Ctx) -> dict:
    vendor = _vendor(ctx)
    changed = []
    for field in _PROFILE_FIELDS:
        value = ctx.get(field)
        if value not in (None, "") and vendor.get(field) != value:
            vendor[field] = value
            changed.append(field)
    if not changed:
        raise DomainError(422, "no_changes", "no updatable fields were provided")
    _record_event(
        vendor,
        "vendor.updated",
        f"Master data updated: {', '.join(changed)}",
        actor="api",
    )
    return _summary(vendor)


@base.op(
    ID,
    "add_vendor_contact",
    title="Add vendor contact",
    description="Register a business contact on a vendor record.",
    input_schema={
        "type": "object",
        "properties": {
            "vendorId": {"type": "string"},
            "name": {"type": "string"},
            "email": {"type": "string"},
            "role": {"type": "string"},
            "phone": {"type": "string"},
            "primary": {"type": "boolean", "default": False},
        },
        "required": ["vendorId", "name", "email"],
    },
    annotations={"readOnlyHint": False, "idempotentHint": False},
)
def add_vendor_contact(ctx: Ctx) -> dict:
    ctx.require("vendorId", "name", "email")
    vendor = _vendor(ctx)
    contacts = vendor.setdefault("contacts", [])
    primary = bool(ctx.get("primary"))
    if primary:
        for existing in contacts:
            existing["primary"] = False
    contact = {
        "contactId": f"{vendor['id']}-C{len(contacts) + 1}",
        "name": ctx.payload["name"],
        "email": ctx.payload["email"],
        "role": ctx.get("role", "Account Manager"),
        "phone": ctx.get("phone"),
        "primary": primary or not contacts,
    }
    contacts.append(contact)
    if contact["primary"]:
        vendor["primaryContact"] = contact
    _record_event(
        vendor, "contact.added", f"Contact added: {contact['name']}", actor="api"
    )
    return contact


# --------------------------------------------------------------------------- #
# Onboarding and registration
# --------------------------------------------------------------------------- #
@base.op(
    ID,
    "register_vendor",
    title="Register vendor",
    description="Create a vendor master record and open an onboarding case. The "
    "vendor enters pending_review until onboarding completes.",
    input_schema={
        "type": "object",
        "properties": {
            "legalName": {"type": "string", "description": "Registered legal name"},
            "name": {"type": "string", "description": "Alias for legalName"},
            "country": {
                "type": "string",
                "description": "ISO 3166-1 alpha-2 country code",
            },
            "currency": {"type": "string", "default": "USD"},
            "category": {"type": "string"},
            "taxId": {"type": "string"},
            "contactEmail": {"type": "string"},
        },
        "required": ["country"],
    },
    output_schema=_VENDOR_OUTPUT,
    annotations={"readOnlyHint": False, "idempotentHint": False},
)
def register_vendor(ctx: Ctx) -> dict:
    legal = ctx.get("legalName") or ctx.get("name")
    if not legal:
        raise DomainError(
            422, "invalid_request", "missing required field(s): legalName"
        )
    ctx.require("country")
    country = str(ctx.payload["country"]).strip().upper()
    if len(country) != 2 or not country.isalpha():
        raise DomainError(
            422, "invalid_country", "country must be an ISO 3166-1 alpha-2 code"
        )
    vendors = ctx.state.table("vendors")
    duplicate = next(
        (
            v
            for v in vendors.values()
            if v.get("legalName", "").lower() == legal.lower()
            and v.get("country") == country
        ),
        None,
    )
    if duplicate is not None:
        raise DomainError(
            409,
            "vendor_exists",
            f"a vendor with this legal name already exists: {duplicate['id']}",
        )
    vid = f"VEND-{len(vendors) + 1:05d}"
    checklist = [
        {
            "step": s,
            "label": label,
            "status": "completed" if s == "profile" else "pending",
            "completedAt": _now() if s == "profile" else None,
        }
        for s, label in zip(_ONBOARDING_STEPS, _STEP_LABELS)
    ]
    vendor = {
        "id": vid,
        "legalName": legal,
        "displayName": ctx.get("name") or legal,
        "slug": legal.lower().replace(" ", "-"),
        "taxId": ctx.get("taxId"),
        "country": country,
        "currency": ctx.get("currency", "USD"),
        "category": ctx.get("category", "Professional Services"),
        "status": "pending_review",
        "lifecycleStage": "onboarding",
        "riskTier": "medium",
        "riskScore": 50,
        "paymentTerms": "NET30",
        "primaryContact": {"email": ctx.get("contactEmail")}
        if ctx.get("contactEmail")
        else None,
        "contacts": [],
        "documents": [],
        "beneficialOwners": [],
        "classifications": {
            "diversity": [],
            "diversityCertified": False,
            "smallBusiness": False,
            "esgScore": None,
            "strategic": False,
        },
        "banking": {"status": "unverified", "method": "micro_deposit"},
        "compliance": {
            "kyb": "pending",
            "sanctions": "pending",
            "adverseMedia": "pending",
            "watchlistHits": 0,
            "taxValidation": "pending",
            "uboVerified": False,
            "insurance": "missing",
            "w9OnFile": False,
            "screeningProvider": _SCREENING_PROVIDER,
            "lastScreenedAt": None,
        },
        "onboarding": {
            "caseId": f"ONB-{vid.split('-')[-1]}",
            "stage": "tax",
            "status": "in_progress",
            "checklist": checklist,
            "owner": "intake-queue",
            "startedAt": _now(),
            "completedAt": None,
        },
        "events": [],
        "createdAt": _now(),
        "updatedAt": _now(),
    }
    vendors[vid] = vendor
    _record_event(
        vendor,
        "vendor.registered",
        f"Vendor master record created for {legal}",
        actor="intake-queue",
    )
    return _summary(vendor)


@base.op(
    ID,
    "get_onboarding_status",
    title="Get onboarding status",
    description="Return the onboarding case and step-by-step checklist for a vendor.",
    input_schema=_VENDOR_REF,
    output_schema=_ONBOARDING_OUTPUT,
    annotations={"readOnlyHint": True, "idempotentHint": True},
)
def get_onboarding_status(ctx: Ctx) -> dict:
    vendor = _vendor(ctx)
    case = vendor["onboarding"]
    done = sum(1 for s in case["checklist"] if s["status"] == "completed")
    return {
        "vendorId": vendor["id"],
        "onboarding": case,
        "progress": {"completed": done, "total": len(case["checklist"])},
    }


@base.op(
    ID,
    "advance_onboarding",
    title="Advance onboarding step",
    description="Mark an onboarding checklist step as completed or failed. When every "
    "step is complete the vendor is activated.",
    input_schema={
        "type": "object",
        "properties": {
            "vendorId": {"type": "string"},
            "step": {"type": "string", "enum": list(_ONBOARDING_STEPS)},
            "outcome": {"type": "string", "enum": ["pass", "fail"], "default": "pass"},
        },
        "required": ["vendorId", "step"],
    },
    annotations={"readOnlyHint": False, "idempotentHint": True},
)
def advance_onboarding(ctx: Ctx) -> dict:
    ctx.require("vendorId", "step")
    vendor = _vendor(ctx)
    step = ctx.payload["step"]
    if step not in _ONBOARDING_STEPS:
        raise DomainError(422, "invalid_step", f"unknown onboarding step {step!r}")
    case = vendor["onboarding"]
    if case["status"] == "completed":
        raise DomainError(
            409, "onboarding_complete", "onboarding case is already closed"
        )
    entry = next((s for s in case["checklist"] if s["step"] == step), None)
    if ctx.get("outcome", "pass") == "fail":
        entry["status"] = "failed"
        case["status"] = "blocked"
        vendor["status"] = "on_hold"
        _record_event(
            vendor,
            f"onboarding.{step}.failed",
            f"Onboarding step failed: {entry['label']}",
            actor="intake-queue",
        )
        return get_onboarding_status(ctx)
    entry["status"] = "completed"
    entry["completedAt"] = _now()
    _record_event(
        vendor, f"onboarding.{step}.completed", entry["label"], actor="intake-queue"
    )
    pending = next((s for s in case["checklist"] if s["status"] == "pending"), None)
    if pending is None:
        case["status"] = "completed"
        case["stage"] = "completed"
        case["completedAt"] = _now()
        vendor["status"] = "active"
        vendor["lifecycleStage"] = "active"
        _record_event(
            vendor,
            "vendor.activated",
            "Onboarding complete; vendor activated",
            actor="intake-queue",
        )
    else:
        case["stage"] = pending["step"]
        case["status"] = "in_progress"
    vendor["updatedAt"] = _now()
    return get_onboarding_status(ctx)


# --------------------------------------------------------------------------- #
# Verification and compliance
# --------------------------------------------------------------------------- #
@base.op(
    ID,
    "verify_vendor_banking",
    title="Verify vendor banking",
    description="Run micro-deposit verification on a vendor's bank account and record "
    "the verified state.",
    input_schema={
        "type": "object",
        "properties": {
            "vendorId": {"type": "string"},
            "accountNumber": {"type": "string"},
            "routingNumber": {"type": "string"},
        },
        "required": ["vendorId"],
    },
    annotations={"readOnlyHint": False, "idempotentHint": True},
)
def verify_vendor_banking(ctx: Ctx) -> dict:
    vendor = _vendor(ctx)
    banking = vendor["banking"]
    account = str(ctx.get("accountNumber", "")).strip()
    if account and len(account) < 5:
        raise DomainError(
            422, "invalid_account", "account number must be at least 5 digits"
        )
    if banking.get("status") == "verified":
        return {
            "vendorId": vendor["id"],
            "status": "verified",
            "alreadyVerified": True,
            "banking": banking,
        }
    banking["status"] = "verified"
    banking["method"] = "micro_deposit"
    banking["verifiedAt"] = _now()
    if account:
        banking["accountLast4"] = account[-4:]
    _record_event(
        vendor,
        "banking.verified",
        "Bank account verified via micro-deposit",
        actor="api",
    )
    return {
        "vendorId": vendor["id"],
        "status": "verified",
        "alreadyVerified": False,
        "banking": banking,
    }


@base.op(
    ID,
    "get_compliance_status",
    title="Get compliance status",
    description="Return the vendor's consolidated compliance posture: KYB, sanctions, "
    "adverse media, tax validation, beneficial-ownership, insurance, and review dates.",
    input_schema=_VENDOR_REF,
    output_schema=_COMPLIANCE_OUTPUT,
    annotations={"readOnlyHint": True, "idempotentHint": True},
)
def get_compliance_status(ctx: Ctx) -> dict:
    vendor = _vendor(ctx)
    compliance = vendor["compliance"]
    blocking = [
        k
        for k in ("kyb", "sanctions", "taxValidation", "adverseMedia")
        if compliance.get(k) in ("flagged", "review", "invalid", "pending")
    ]
    if compliance.get("watchlistHits"):
        blocking.append("watchlist")
    return {
        "vendorId": vendor["id"],
        "riskTier": vendor["riskTier"],
        "riskScore": vendor.get("riskScore"),
        "compliance": compliance,
        "clearedToPay": not blocking,
        "blockingChecks": blocking,
    }


@base.op(
    ID,
    "run_compliance_screening",
    title="Run compliance screening",
    description="Re-run KYB, sanctions, and adverse-media screening for a vendor against "
    "the configured watchlists and refresh its risk tier and posture.",
    input_schema={
        "type": "object",
        "properties": {
            "vendorId": {"type": "string"},
            "scope": {
                "type": "array",
                "items": {
                    "type": "string",
                    "enum": ["kyb", "sanctions", "adverse_media", "ubo"],
                },
                "description": "Checks to run; defaults to the full screen.",
            },
        },
        "required": ["vendorId"],
    },
    output_schema=_COMPLIANCE_OUTPUT,
    annotations={"readOnlyHint": False, "idempotentHint": False},
)
def run_compliance_screening(ctx: Ctx) -> dict:
    vendor = _vendor(ctx)
    compliance = vendor["compliance"]
    scope = ctx.get("scope") or ["kyb", "sanctions", "adverse_media", "ubo"]
    hits = compliance.get("watchlistHits", 0)
    if "kyb" in scope and compliance.get("kyb") == "pending":
        compliance["kyb"] = "cleared"
    if "sanctions" in scope:
        compliance["sanctions"] = "review" if hits else "clear"
    if "adverse_media" in scope and compliance.get("adverseMedia") == "pending":
        compliance["adverseMedia"] = "none"
    if "ubo" in scope:
        compliance["uboVerified"] = all(
            o.get("screened") for o in vendor.get("beneficialOwners", [])
        )
    compliance["screeningProvider"] = _SCREENING_PROVIDER
    compliance["lastScreenedAt"] = _now()
    flagged = (
        hits > 0
        or compliance.get("sanctions") == "review"
        or compliance.get("adverseMedia") == "review"
    )
    if flagged:
        vendor["riskTier"] = "high"
        vendor["riskScore"] = max(vendor.get("riskScore", 50), 80)
    _record_event(
        vendor,
        "compliance.screening.completed",
        f"Screening run ({', '.join(scope)}); {'hits found' if flagged else 'cleared'}",
        actor=_SCREENING_PROVIDER,
    )
    return get_compliance_status(ctx)


# --------------------------------------------------------------------------- #
# Documents
# --------------------------------------------------------------------------- #
@base.op(
    ID,
    "list_vendor_documents",
    title="List vendor documents",
    description="List documents on file for a vendor (W-9, insurance, agreements).",
    input_schema=_VENDOR_REF,
    annotations={"readOnlyHint": True, "idempotentHint": True},
)
def list_vendor_documents(ctx: Ctx) -> dict:
    vendor = _vendor(ctx)
    return {"vendorId": vendor["id"], "items": vendor.get("documents", [])}


@base.op(
    ID,
    "submit_vendor_document",
    title="Submit vendor document",
    description="Attach a document to a vendor record for compliance review.",
    input_schema={
        "type": "object",
        "properties": {
            "vendorId": {"type": "string"},
            "type": {"type": "string", "enum": list(_DOC_TYPES)},
            "fileName": {"type": "string"},
        },
        "required": ["vendorId", "type", "fileName"],
    },
    annotations={"readOnlyHint": False, "idempotentHint": False},
)
def submit_vendor_document(ctx: Ctx) -> dict:
    ctx.require("vendorId", "type", "fileName")
    vendor = _vendor(ctx)
    dtype = ctx.payload["type"]
    if dtype not in _DOC_TYPES:
        raise DomainError(422, "invalid_document_type", dtype)
    docs = vendor.setdefault("documents", [])
    document = {
        "documentId": f"DOC-{vendor['id'].split('-')[-1]}-{len(docs) + 1}",
        "type": dtype,
        "status": "pending_review",
        "fileName": ctx.payload["fileName"],
        "uploadedAt": _now(),
        "expiresAt": None,
    }
    docs.append(document)
    if dtype == "w9":
        vendor["compliance"]["w9OnFile"] = True
    _record_event(
        vendor,
        "document.submitted",
        f"Document submitted for review: {dtype}",
        actor="api",
    )
    return document


@base.op(
    ID,
    "get_vendor_document",
    title="Get vendor document",
    description="Retrieve the metadata for a single document on a vendor record.",
    input_schema={
        "type": "object",
        "properties": {
            "vendorId": {"type": "string"},
            "documentId": {"type": "string"},
        },
        "required": ["vendorId", "documentId"],
    },
    annotations={"readOnlyHint": True, "idempotentHint": True},
)
def get_vendor_document(ctx: Ctx) -> dict:
    ctx.require("vendorId", "documentId")
    vendor = _vendor(ctx)
    document = next(
        (
            d
            for d in vendor.get("documents", [])
            if d["documentId"] == ctx.payload["documentId"]
        ),
        None,
    )
    if document is None:
        raise DomainError(404, "document_not_found", ctx.payload["documentId"])
    return document


@base.op(
    ID,
    "review_vendor_document",
    title="Review vendor document",
    description="Approve or reject a submitted vendor document during compliance review.",
    input_schema={
        "type": "object",
        "properties": {
            "vendorId": {"type": "string"},
            "documentId": {"type": "string"},
            "decision": {"type": "string", "enum": ["approve", "reject"]},
            "note": {"type": "string"},
        },
        "required": ["vendorId", "documentId", "decision"],
    },
    annotations={"readOnlyHint": False, "idempotentHint": True},
)
def review_vendor_document(ctx: Ctx) -> dict:
    ctx.require("vendorId", "documentId", "decision")
    vendor = _vendor(ctx)
    decision = ctx.payload["decision"]
    if decision not in ("approve", "reject"):
        raise DomainError(422, "invalid_decision", decision)
    document = next(
        (
            d
            for d in vendor.get("documents", [])
            if d["documentId"] == ctx.payload["documentId"]
        ),
        None,
    )
    if document is None:
        raise DomainError(404, "document_not_found", ctx.payload["documentId"])
    document["status"] = "verified" if decision == "approve" else "rejected"
    document["reviewedAt"] = _now()
    if ctx.get("note"):
        document["reviewNote"] = ctx.payload["note"]
    if document["type"] == "coi" and decision == "approve":
        vendor["compliance"]["insurance"] = "current"
    _record_event(
        vendor,
        f"document.{decision}d",
        f"Document {decision}d: {document['type']}",
        actor="compliance",
    )
    return document


# --------------------------------------------------------------------------- #
# Lifecycle and contracts
# --------------------------------------------------------------------------- #
@base.op(
    ID,
    "set_vendor_status",
    title="Set vendor status",
    description="Transition a vendor's lifecycle status (active, on_hold, suspended, "
    "offboarded).",
    input_schema={
        "type": "object",
        "properties": {
            "vendorId": {"type": "string"},
            "status": {"type": "string", "enum": list(_STATUSES)},
            "reason": {"type": "string"},
        },
        "required": ["vendorId", "status"],
    },
    annotations={
        "readOnlyHint": False,
        "idempotentHint": True,
        "destructiveHint": True,
    },
)
def set_vendor_status(ctx: Ctx) -> dict:
    ctx.require("vendorId", "status")
    vendor = _vendor(ctx)
    status = ctx.payload["status"]
    if status not in _STATUSES:
        raise DomainError(422, "invalid_status", status)
    vendor["status"] = status
    vendor["lifecycleStage"] = "active" if status in ("active", "on_hold") else status
    _record_event(
        vendor,
        f"vendor.{status}",
        ctx.get("reason") or f"Vendor status set to {status}",
        actor="api",
    )
    return {"vendorId": vendor["id"], "status": status, "reason": ctx.get("reason")}


@base.op(
    ID,
    "list_contracts",
    title="List contracts",
    description="List contracts, optionally scoped to a single vendor.",
    input_schema={
        "type": "object",
        "properties": {
            "vendorId": {"type": "string"},
            "page": _PAGE_PROPS["page"],
            "pageSize": _PAGE_PROPS["pageSize"],
        },
    },
    annotations={"readOnlyHint": True, "idempotentHint": True},
)
def list_contracts(ctx: Ctx) -> dict:
    vendor_id = ctx.get("vendorId")
    items = [
        c
        for c in ctx.state.table("contracts").values()
        if vendor_id is None or c["vendorId"] == vendor_id
    ]
    return ctx.paginate(items, size_default=20)


@base.op(
    ID,
    "get_contract_terms",
    title="Get contract terms",
    description="Retrieve the terms of a single vendor contract.",
    input_schema={
        "type": "object",
        "properties": {
            "contractId": {
                "type": "string",
                "description": "Contract identifier, e.g. CTR-00012",
            }
        },
        "required": ["contractId"],
    },
    annotations={"readOnlyHint": True, "idempotentHint": True},
)
def get_contract_terms(ctx: Ctx) -> dict:
    ctx.require("contractId")
    contract = ctx.state.table("contracts").get(ctx.payload["contractId"])
    if contract is None:
        raise DomainError(404, "contract_not_found", ctx.payload["contractId"])
    return contract


# --------------------------------------------------------------------------- #
# Taxonomy and audit history
# --------------------------------------------------------------------------- #
@base.op(
    ID,
    "list_categories",
    title="List vendor categories",
    description="List the vendor commodity taxonomy (UNSPSC segment codes) the network "
    "classifies vendors against.",
    input_schema={"type": "object", "properties": {}},
    annotations={"readOnlyHint": True, "idempotentHint": True},
)
def list_categories(ctx: Ctx) -> dict:
    items = list(ctx.state.table("categories").values())
    return {"total": len(items), "items": items}


@base.op(
    ID,
    "list_vendor_events",
    title="List vendor events",
    description="Return the change-history / audit trail for a vendor, newest first.",
    input_schema={
        "type": "object",
        "properties": {
            "vendorId": {"type": "string"},
            "page": _PAGE_PROPS["page"],
            "pageSize": _PAGE_PROPS["pageSize"],
        },
        "required": ["vendorId"],
    },
    annotations={"readOnlyHint": True, "idempotentHint": True},
)
def list_vendor_events(ctx: Ctx) -> dict:
    vendor = _vendor(ctx)
    result = ctx.paginate(vendor.get("events", []), size_default=25)
    result["vendorId"] = vendor["id"]
    return result


# --------------------------------------------------------------------------- #
# MCP resources (discovery surface)
# --------------------------------------------------------------------------- #
@base.resource(
    ID,
    uri="atlas://vendors/directory",
    name="Vendor directory",
    title="Vendor directory",
    description="Aggregate vendor counts by status and risk tier with a sample.",
)
def _res_directory(ctx: Ctx) -> dict:
    vendors = list(ctx.state.table("vendors").values())
    by_status: dict[str, int] = {}
    by_risk: dict[str, int] = {}
    for v in vendors:
        by_status[v["status"]] = by_status.get(v["status"], 0) + 1
        by_risk[v["riskTier"]] = by_risk.get(v["riskTier"], 0) + 1
    return {
        "total": len(vendors),
        "byStatus": by_status,
        "byRiskTier": by_risk,
        "sample": [_summary(v) for v in vendors[:10]],
    }


@base.resource(
    ID,
    uri="atlas://onboarding/queue",
    name="Onboarding queue",
    title="Onboarding queue",
    description="Vendors with open onboarding cases and their current step.",
)
def _res_onboarding_queue(ctx: Ctx) -> dict:
    queue = []
    for v in ctx.state.table("vendors").values():
        case = v.get("onboarding") or {}
        if case.get("status") in ("in_progress", "blocked"):
            queue.append(
                {
                    "vendorId": v["id"],
                    "displayName": v["displayName"],
                    "stage": case.get("stage"),
                    "status": case.get("status"),
                    "owner": case.get("owner"),
                }
            )
    return {"total": len(queue), "items": queue[:50]}


@base.resource(
    ID,
    uri="atlas://compliance/review",
    name="Compliance review list",
    title="Compliance review list",
    description="Vendors with blocking compliance checks or high risk.",
)
def _res_compliance_review(ctx: Ctx) -> dict:
    flagged = []
    for v in ctx.state.table("vendors").values():
        c = v.get("compliance") or {}
        if (
            v["riskTier"] == "high"
            or c.get("kyb") == "flagged"
            or c.get("sanctions") == "review"
        ):
            flagged.append(
                {
                    "vendorId": v["id"],
                    "displayName": v["displayName"],
                    "riskTier": v["riskTier"],
                    "kyb": c.get("kyb"),
                    "sanctions": c.get("sanctions"),
                }
            )
    return {"total": len(flagged), "items": flagged[:50]}


@base.resource(
    ID,
    uri="atlas://catalog/categories",
    name="Vendor category taxonomy",
    title="Vendor category taxonomy",
    description="The UNSPSC commodity taxonomy vendors are classified against.",
)
def _res_categories(ctx: Ctx) -> dict:
    items = list(ctx.state.table("categories").values())
    return {"total": len(items), "items": items}


@base.resource(
    ID,
    uri="atlas://activity/feed",
    name="Vendor activity feed",
    title="Vendor activity feed",
    description="Most recent change-history events across the vendor network.",
)
def _res_activity_feed(ctx: Ctx) -> dict:
    events = []
    for v in ctx.state.table("vendors").values():
        for e in v.get("events", [])[:3]:
            events.append({**e, "vendorId": v["id"], "displayName": v["displayName"]})
    events.sort(key=lambda e: e["occurredAt"], reverse=True)
    return {"total": len(events), "items": events[:50]}


# --------------------------------------------------------------------------- #
# MCP resource templates (per-vendor discovery)
# --------------------------------------------------------------------------- #
@base.resource_template(
    ID,
    uri_template="atlas://vendors/{vendorId}",
    name="Vendor record",
    title="Vendor record",
    description="Full master-data profile for a single vendor by id.",
)
def _tmpl_vendor(ctx: Ctx) -> dict:
    return _vendor(ctx)


@base.resource_template(
    ID,
    uri_template="atlas://vendors/{vendorId}/onboarding",
    name="Vendor onboarding case",
    title="Vendor onboarding case",
    description="The onboarding case and checklist for a single vendor.",
)
def _tmpl_onboarding(ctx: Ctx) -> dict:
    return get_onboarding_status(ctx)


@base.resource_template(
    ID,
    uri_template="atlas://vendors/{vendorId}/compliance",
    name="Vendor compliance posture",
    title="Vendor compliance posture",
    description="The consolidated compliance posture for a single vendor.",
)
def _tmpl_compliance(ctx: Ctx) -> dict:
    return get_compliance_status(ctx)
