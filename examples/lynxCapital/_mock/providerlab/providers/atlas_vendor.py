"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Atlas Vendor Network domain: MCP tool server for vendor master data, onboarding, verification, compliance, and contract lifecycle.
"""
from __future__ import annotations

from datetime import datetime, timezone

from _mock.providerlab.data import generators as gen
from _mock.providerlab.providers import base
from _mock.providerlab.providers.base import Ctx, DomainError

ID = "atlas-vendor"

_STATUSES = ("active", "on_hold", "suspended", "offboarded")
_DOC_TYPES = ("w9", "coi", "bank_letter", "msa", "registration", "other")
_ONBOARDING_STEPS = ("profile", "tax", "kyb", "banking", "documents", "approval")
_STEP_LABELS = ("Company profile captured", "Tax identification validated",
                "KYB / sanctions screening cleared", "Bank account verified",
                "Required documents collected", "Final approval and activation")

_VENDOR_REF = {"type": "object", "properties": {
    "vendorId": {"type": "string", "description": "Vendor identifier, e.g. VEND-00042"}},
    "required": ["vendorId"]}
_VENDOR_OUTPUT = {"type": "object", "properties": {
    "id": {"type": "string"}, "legalName": {"type": "string"},
    "status": {"type": "string"}, "lifecycleStage": {"type": "string"},
    "riskTier": {"type": "string"}}, "required": ["id", "legalName", "status"]}
_PAGE_PROPS = {
    "page": {"type": "integer", "minimum": 1, "default": 1},
    "pageSize": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20}}


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


@base.seeder(ID)
def seed(state: base.State) -> None:
    vendors = gen.atlas_vendors(ID, 240)
    state.tables["vendors"] = gen.index_by(vendors)
    state.tables["contracts"] = gen.atlas_contracts(ID, vendors)


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
    return {"id": vendor["id"], "legalName": vendor.get("legalName"),
            "displayName": vendor.get("displayName"), "country": vendor.get("country"),
            "currency": vendor.get("currency"), "category": vendor.get("category"),
            "status": vendor.get("status"), "lifecycleStage": vendor.get("lifecycleStage"),
            "riskTier": vendor.get("riskTier"), "paymentTerms": vendor.get("paymentTerms")}


# --------------------------------------------------------------------------- #
# Discovery and master-data reads
# --------------------------------------------------------------------------- #
@base.op(
    ID, "search_vendors",
    title="Search vendors",
    description="Full-text search across the vendor master with optional status, "
                "risk-tier, country, and category filters.",
    input_schema={"type": "object", "properties": {
        "query": {"type": "string", "description": "Name or country search term"},
        "status": {"type": "string", "enum": list(_STATUSES)},
        "riskTier": {"type": "string", "enum": ["low", "medium", "high"]},
        "country": {"type": "string", "description": "ISO 3166-1 alpha-2 country code"},
        "category": {"type": "string"},
        "page": _PAGE_PROPS["page"], "pageSize": _PAGE_PROPS["pageSize"]},
        "required": ["query"]},
    annotations={"readOnlyHint": True, "idempotentHint": True})
def search_vendors(ctx: Ctx) -> dict:
    ctx.require("query")
    query = str(ctx.payload["query"]).lower()
    items = []
    for v in ctx.state.table("vendors").values():
        if query not in v["displayName"].lower() and query not in v.get("country", "").lower():
            continue
        if not _matches_filters(ctx, v):
            continue
        items.append(_summary(v))
    return ctx.paginate(items, size_default=20)


@base.op(
    ID, "list_vendors",
    title="List vendors",
    description="List vendor master records, optionally filtered by lifecycle status, "
                "risk tier, or category.",
    input_schema={"type": "object", "properties": {
        "status": {"type": "string", "enum": list(_STATUSES)},
        "riskTier": {"type": "string", "enum": ["low", "medium", "high"]},
        "category": {"type": "string"},
        "page": _PAGE_PROPS["page"], "pageSize": _PAGE_PROPS["pageSize"]}},
    annotations={"readOnlyHint": True, "idempotentHint": True})
def list_vendors(ctx: Ctx) -> dict:
    items = [_summary(v) for v in ctx.state.table("vendors").values() if _matches_filters(ctx, v)]
    return ctx.paginate(items, size_default=25)


@base.op(
    ID, "get_vendor_profile",
    title="Get vendor profile",
    description="Retrieve the full master-data profile for a vendor, including "
                "contacts, banking, compliance, documents, and onboarding state.",
    input_schema=_VENDOR_REF, output_schema=_VENDOR_OUTPUT,
    annotations={"readOnlyHint": True, "idempotentHint": True})
def get_vendor_profile(ctx: Ctx) -> dict:
    return _vendor(ctx)


@base.op(
    ID, "list_vendor_contacts",
    title="List vendor contacts",
    description="List the registered business contacts for a vendor.",
    input_schema=_VENDOR_REF,
    annotations={"readOnlyHint": True, "idempotentHint": True})
def list_vendor_contacts(ctx: Ctx) -> dict:
    vendor = _vendor(ctx)
    return {"vendorId": vendor["id"], "items": vendor.get("contacts", [])}


# --------------------------------------------------------------------------- #
# Onboarding and registration
# --------------------------------------------------------------------------- #
@base.op(
    ID, "register_vendor",
    title="Register vendor",
    description="Create a vendor master record and open an onboarding case. The "
                "vendor enters pending_review until onboarding completes.",
    input_schema={"type": "object", "properties": {
        "legalName": {"type": "string", "description": "Registered legal name"},
        "name": {"type": "string", "description": "Alias for legalName"},
        "country": {"type": "string", "description": "ISO 3166-1 alpha-2 country code"},
        "currency": {"type": "string", "default": "USD"},
        "category": {"type": "string"},
        "taxId": {"type": "string"},
        "contactEmail": {"type": "string"}},
        "required": ["country"]},
    output_schema=_VENDOR_OUTPUT,
    annotations={"readOnlyHint": False, "idempotentHint": False})
def register_vendor(ctx: Ctx) -> dict:
    legal = ctx.get("legalName") or ctx.get("name")
    if not legal:
        raise DomainError(422, "invalid_request", "missing required field(s): legalName")
    ctx.require("country")
    vendors = ctx.state.table("vendors")
    vid = f"VEND-{len(vendors) + 1:05d}"
    checklist = [{"step": s, "label": label,
                  "status": "completed" if s == "profile" else "pending",
                  "completedAt": _now() if s == "profile" else None}
                 for s, label in zip(_ONBOARDING_STEPS, _STEP_LABELS)]
    vendor = {
        "id": vid, "legalName": legal, "displayName": legal,
        "slug": legal.lower().replace(" ", "-"),
        "taxId": ctx.get("taxId"), "country": ctx.payload["country"],
        "currency": ctx.get("currency", "USD"),
        "category": ctx.get("category", "Professional Services"),
        "status": "pending_review", "lifecycleStage": "onboarding",
        "riskTier": "medium", "riskScore": 50, "paymentTerms": "NET30",
        "primaryContact": {"email": ctx.get("contactEmail")} if ctx.get("contactEmail") else None,
        "contacts": [], "documents": [],
        "banking": {"status": "unverified", "method": "micro_deposit"},
        "compliance": {"kyb": "pending", "sanctions": "pending", "taxValidation": "pending",
                       "insurance": "missing", "w9OnFile": False},
        "onboarding": {"caseId": f"ONB-{vid.split('-')[-1]}", "stage": "tax",
                       "status": "in_progress", "checklist": checklist,
                       "owner": "intake-queue", "startedAt": _now(), "completedAt": None},
        "createdAt": _now(), "updatedAt": _now(),
    }
    vendors[vid] = vendor
    return _summary(vendor)


@base.op(
    ID, "get_onboarding_status",
    title="Get onboarding status",
    description="Return the onboarding case and step-by-step checklist for a vendor.",
    input_schema=_VENDOR_REF,
    annotations={"readOnlyHint": True, "idempotentHint": True})
def get_onboarding_status(ctx: Ctx) -> dict:
    vendor = _vendor(ctx)
    case = vendor["onboarding"]
    done = sum(1 for s in case["checklist"] if s["status"] == "completed")
    return {"vendorId": vendor["id"], "onboarding": case,
            "progress": {"completed": done, "total": len(case["checklist"])}}


@base.op(
    ID, "advance_onboarding",
    title="Advance onboarding step",
    description="Mark an onboarding checklist step as completed or failed. When every "
                "step is complete the vendor is activated.",
    input_schema={"type": "object", "properties": {
        "vendorId": {"type": "string"},
        "step": {"type": "string", "enum": list(_ONBOARDING_STEPS)},
        "outcome": {"type": "string", "enum": ["pass", "fail"], "default": "pass"}},
        "required": ["vendorId", "step"]},
    annotations={"readOnlyHint": False, "idempotentHint": True})
def advance_onboarding(ctx: Ctx) -> dict:
    ctx.require("vendorId", "step")
    vendor = _vendor(ctx)
    step = ctx.payload["step"]
    if step not in _ONBOARDING_STEPS:
        raise DomainError(422, "invalid_step", f"unknown onboarding step {step!r}")
    case = vendor["onboarding"]
    if case["status"] == "completed":
        raise DomainError(409, "onboarding_complete", "onboarding case is already closed")
    entry = next((s for s in case["checklist"] if s["step"] == step), None)
    if ctx.get("outcome", "pass") == "fail":
        entry["status"] = "failed"
        case["status"] = "blocked"
        vendor["status"] = "on_hold"
        vendor["updatedAt"] = _now()
        return get_onboarding_status(ctx)
    entry["status"] = "completed"
    entry["completedAt"] = _now()
    pending = next((s for s in case["checklist"] if s["status"] == "pending"), None)
    if pending is None:
        case["status"] = "completed"
        case["stage"] = "completed"
        case["completedAt"] = _now()
        vendor["status"] = "active"
        vendor["lifecycleStage"] = "active"
    else:
        case["stage"] = pending["step"]
        case["status"] = "in_progress"
    vendor["updatedAt"] = _now()
    return get_onboarding_status(ctx)


# --------------------------------------------------------------------------- #
# Verification and compliance
# --------------------------------------------------------------------------- #
@base.op(
    ID, "verify_vendor_banking",
    title="Verify vendor banking",
    description="Run micro-deposit verification on a vendor's bank account and record "
                "the verified state.",
    input_schema={"type": "object", "properties": {
        "vendorId": {"type": "string"},
        "accountNumber": {"type": "string"},
        "routingNumber": {"type": "string"}},
        "required": ["vendorId"]},
    annotations={"readOnlyHint": False, "idempotentHint": True})
def verify_vendor_banking(ctx: Ctx) -> dict:
    vendor = _vendor(ctx)
    banking = vendor["banking"]
    account = str(ctx.get("accountNumber", "")).strip()
    if account and len(account) < 5:
        raise DomainError(422, "invalid_account", "account number must be at least 5 digits")
    if banking.get("status") == "verified":
        return {"vendorId": vendor["id"], "status": "verified", "alreadyVerified": True,
                "banking": banking}
    banking["status"] = "verified"
    banking["method"] = "micro_deposit"
    banking["verifiedAt"] = _now()
    if account:
        banking["accountLast4"] = account[-4:]
    vendor["updatedAt"] = _now()
    return {"vendorId": vendor["id"], "status": "verified", "alreadyVerified": False,
            "banking": banking}


@base.op(
    ID, "get_compliance_status",
    title="Get compliance status",
    description="Return the vendor's consolidated compliance posture: KYB, sanctions, "
                "tax validation, insurance, and review dates.",
    input_schema=_VENDOR_REF,
    annotations={"readOnlyHint": True, "idempotentHint": True})
def get_compliance_status(ctx: Ctx) -> dict:
    vendor = _vendor(ctx)
    compliance = vendor["compliance"]
    blocking = [k for k in ("kyb", "sanctions", "taxValidation")
                if compliance.get(k) in ("flagged", "review", "invalid", "pending")]
    return {"vendorId": vendor["id"], "riskTier": vendor["riskTier"],
            "riskScore": vendor.get("riskScore"), "compliance": compliance,
            "clearedToPay": not blocking, "blockingChecks": blocking}


# --------------------------------------------------------------------------- #
# Documents
# --------------------------------------------------------------------------- #
@base.op(
    ID, "list_vendor_documents",
    title="List vendor documents",
    description="List documents on file for a vendor (W-9, insurance, agreements).",
    input_schema=_VENDOR_REF,
    annotations={"readOnlyHint": True, "idempotentHint": True})
def list_vendor_documents(ctx: Ctx) -> dict:
    vendor = _vendor(ctx)
    return {"vendorId": vendor["id"], "items": vendor.get("documents", [])}


@base.op(
    ID, "submit_vendor_document",
    title="Submit vendor document",
    description="Attach a document to a vendor record for compliance review.",
    input_schema={"type": "object", "properties": {
        "vendorId": {"type": "string"},
        "type": {"type": "string", "enum": list(_DOC_TYPES)},
        "fileName": {"type": "string"}},
        "required": ["vendorId", "type", "fileName"]},
    annotations={"readOnlyHint": False, "idempotentHint": False})
def submit_vendor_document(ctx: Ctx) -> dict:
    ctx.require("vendorId", "type", "fileName")
    vendor = _vendor(ctx)
    dtype = ctx.payload["type"]
    if dtype not in _DOC_TYPES:
        raise DomainError(422, "invalid_document_type", dtype)
    docs = vendor.setdefault("documents", [])
    document = {"documentId": f"DOC-{vendor['id'].split('-')[-1]}-{len(docs) + 1}",
                "type": dtype, "status": "received", "fileName": ctx.payload["fileName"],
                "uploadedAt": _now(), "expiresAt": None}
    docs.append(document)
    if dtype == "w9":
        vendor["compliance"]["w9OnFile"] = True
    vendor["updatedAt"] = _now()
    return document


# --------------------------------------------------------------------------- #
# Lifecycle and contracts
# --------------------------------------------------------------------------- #
@base.op(
    ID, "set_vendor_status",
    title="Set vendor status",
    description="Transition a vendor's lifecycle status (active, on_hold, suspended, "
                "offboarded).",
    input_schema={"type": "object", "properties": {
        "vendorId": {"type": "string"},
        "status": {"type": "string", "enum": list(_STATUSES)},
        "reason": {"type": "string"}},
        "required": ["vendorId", "status"]},
    annotations={"readOnlyHint": False, "idempotentHint": True, "destructiveHint": True})
def set_vendor_status(ctx: Ctx) -> dict:
    ctx.require("vendorId", "status")
    vendor = _vendor(ctx)
    status = ctx.payload["status"]
    if status not in _STATUSES:
        raise DomainError(422, "invalid_status", status)
    vendor["status"] = status
    vendor["lifecycleStage"] = "active" if status in ("active", "on_hold") else status
    vendor["updatedAt"] = _now()
    return {"vendorId": vendor["id"], "status": status, "reason": ctx.get("reason")}


@base.op(
    ID, "list_contracts",
    title="List contracts",
    description="List contracts, optionally scoped to a single vendor.",
    input_schema={"type": "object", "properties": {
        "vendorId": {"type": "string"},
        "page": _PAGE_PROPS["page"], "pageSize": _PAGE_PROPS["pageSize"]}},
    annotations={"readOnlyHint": True, "idempotentHint": True})
def list_contracts(ctx: Ctx) -> dict:
    vendor_id = ctx.get("vendorId")
    items = [c for c in ctx.state.table("contracts").values()
             if vendor_id is None or c["vendorId"] == vendor_id]
    return ctx.paginate(items, size_default=20)


@base.op(
    ID, "get_contract_terms",
    title="Get contract terms",
    description="Retrieve the terms of a single vendor contract.",
    input_schema={"type": "object", "properties": {
        "contractId": {"type": "string", "description": "Contract identifier, e.g. CTR-00012"}},
        "required": ["contractId"]},
    annotations={"readOnlyHint": True, "idempotentHint": True})
def get_contract_terms(ctx: Ctx) -> dict:
    ctx.require("contractId")
    contract = ctx.state.table("contracts").get(ctx.payload["contractId"])
    if contract is None:
        raise DomainError(404, "contract_not_found", ctx.payload["contractId"])
    return contract


# --------------------------------------------------------------------------- #
# MCP resources (discovery surface)
# --------------------------------------------------------------------------- #
@base.resource(ID, uri="atlas://vendors/directory", name="Vendor directory",
               description="Aggregate vendor counts by status and risk tier with a sample.")
def _res_directory(ctx: Ctx) -> dict:
    vendors = list(ctx.state.table("vendors").values())
    by_status: dict[str, int] = {}
    by_risk: dict[str, int] = {}
    for v in vendors:
        by_status[v["status"]] = by_status.get(v["status"], 0) + 1
        by_risk[v["riskTier"]] = by_risk.get(v["riskTier"], 0) + 1
    return {"total": len(vendors), "byStatus": by_status, "byRiskTier": by_risk,
            "sample": [_summary(v) for v in vendors[:10]]}


@base.resource(ID, uri="atlas://onboarding/queue", name="Onboarding queue",
               description="Vendors with open onboarding cases and their current step.")
def _res_onboarding_queue(ctx: Ctx) -> dict:
    queue = []
    for v in ctx.state.table("vendors").values():
        case = v.get("onboarding") or {}
        if case.get("status") in ("in_progress", "blocked"):
            queue.append({"vendorId": v["id"], "displayName": v["displayName"],
                          "stage": case.get("stage"), "status": case.get("status"),
                          "owner": case.get("owner")})
    return {"total": len(queue), "items": queue[:50]}


@base.resource(ID, uri="atlas://compliance/review", name="Compliance review list",
               description="Vendors with blocking compliance checks or high risk.")
def _res_compliance_review(ctx: Ctx) -> dict:
    flagged = []
    for v in ctx.state.table("vendors").values():
        c = v.get("compliance") or {}
        if v["riskTier"] == "high" or c.get("kyb") == "flagged" or c.get("sanctions") == "review":
            flagged.append({"vendorId": v["id"], "displayName": v["displayName"],
                            "riskTier": v["riskTier"], "kyb": c.get("kyb"),
                            "sanctions": c.get("sanctions")})
    return {"total": len(flagged), "items": flagged[:50]}
