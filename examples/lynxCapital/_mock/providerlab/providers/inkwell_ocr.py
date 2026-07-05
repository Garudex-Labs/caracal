"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Inkwell OCR domain: asynchronous document capture with classification, field-level extraction, line items, confidence scoring, human-in-the-loop corrections, and batch submission.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone

from _mock.providerlab.data import generators as gen
from _mock.providerlab.providers import base
from _mock.providerlab.providers.base import Ctx, DomainError

ID = "inkwell-ocr"

_HOST = "api.inkwellocr.test"
_API_VERSION = "2026-02-01"
_QUOTA_CAP = 1000
_BATCH_CAP = 100
_TERMINAL_STATUSES = frozenset({"extracted", "needs_review", "failed", "cancelled"})


def _iso_now() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _self_url(document_id: str) -> str:
    return f"https://{_HOST}/v1/documents/{document_id}"


def _new_doc(
    ctx: Ctx,
    file_name: str,
    model: str,
    *,
    reference: str | None = None,
    callback_url: str | None = None,
    tags: dict | None = None,
    size_bytes: int | None = None,
    page_count: int | None = None,
    idempotency_key: str | None = None,
) -> dict:
    """Build a fresh document record after validating the submission against
    Inkwell's synchronous gates (media size, page count, quota)."""
    mime = gen.inkwell_mime(file_name)
    if mime is None:
        raise DomainError(
            415,
            "unsupported_media_type",
            f"cannot process {file_name!r}; supported types are PDF, PNG, JPEG, TIFF, WEBP, and HEIC",
        )
    models = ctx.state.table("models")
    if model not in models:
        raise DomainError(
            422, "unknown_model", f"model {model!r} is not available; see list_models"
        )

    documents = ctx.state.table("documents")
    if len(documents) >= _QUOTA_CAP:
        raise DomainError(
            429,
            "quota_exceeded",
            f"document quota of {_QUOTA_CAP} reached; archive or delete documents before retrying",
        )

    rng = gen._rng(ID, "submit", file_name, reference or "")
    resolved_size = (
        int(size_bytes) if size_bytes is not None else rng.randint(48_000, 5_200_000)
    )
    resolved_pages = (
        int(page_count) if page_count is not None else rng.choice((1, 1, 1, 2, 3, 5))
    )

    rejection = gen.inkwell_submit_check(file_name, resolved_size, resolved_pages)
    if rejection is not None:
        status, code, message = rejection
        raise DomainError(status, code, message)

    doc_id = base.new_id("doc")
    queued = _iso_now()
    doc = {
        "documentId": doc_id,
        "object": "document",
        "fileName": file_name,
        "mimeType": mime,
        "sizeBytes": resolved_size,
        "sha256": hashlib.sha256(f"{doc_id}:{file_name}".encode()).hexdigest(),
        "pageCount": resolved_pages,
        "model": model,
        "modelVersion": models[model]["version"],
        "documentType": None,
        "status": "processing",
        "source": "api_upload",
        "reference": reference,
        "callbackUrl": callback_url,
        "tags": dict(tags or {}),
        "idempotencyKey": idempotency_key,
        "selfUrl": _self_url(doc_id),
        "apiVersion": _API_VERSION,
        "createdAt": queued,
        "queuedAt": queued,
        "startedAt": None,
        "completedAt": None,
        "cancelledAt": None,
        "processingDurationMs": None,
        "confidence": None,
    }
    documents[doc_id] = doc
    return doc


@base.seeder(ID)
def seed(state: base.State) -> None:
    for name, table in gen.inkwell_dataset(ID).items():
        state.tables[name] = table


@base.op(ID, "submit_document")
def submit_document(ctx: Ctx) -> dict:
    """Queue a document for capture; extraction completes asynchronously and is read back via get_extraction."""
    ctx.require("fileName")
    file_name = str(ctx.payload["fileName"])
    model = str(ctx.get("model", "invoice"))

    idem = ctx.get("idempotencyKey")
    keys = ctx.state.table("idempotency")
    documents = ctx.state.table("documents")
    scoped = f"document:{idem}" if idem else None
    if scoped and scoped in keys:
        prior = documents.get(keys[scoped])
        if prior is not None:
            return prior

    doc = _new_doc(
        ctx,
        file_name,
        model,
        reference=ctx.get("reference"),
        callback_url=ctx.get("callbackUrl"),
        tags=ctx.get("tags"),
        size_bytes=ctx.get("sizeBytes"),
        page_count=ctx.get("pages"),
        idempotency_key=idem,
    )
    if scoped:
        keys[scoped] = doc["documentId"]
    return doc


@base.op(ID, "submit_documents_batch")
def submit_documents_batch(ctx: Ctx) -> dict:
    """Submit a batch of documents in one request; accepted items become processing documents, rejected ones return their failure code."""
    items = ctx.get("documents") or []
    if not items:
        raise DomainError(422, "empty_batch", "batch requires at least one document")
    if len(items) > _BATCH_CAP:
        raise DomainError(
            422, "batch_too_large", f"batch may contain at most {_BATCH_CAP} documents"
        )

    idem = ctx.get("idempotencyKey")
    keys = ctx.state.table("idempotency")
    batches = ctx.state.table("batches")
    scoped = f"batch:{idem}" if idem else None
    if scoped and scoped in keys:
        prior = batches.get(keys[scoped])
        if prior is not None:
            return prior

    accepted = rejected = 0
    results: list[dict] = []
    batch_id = base.new_id("bat")
    created = _iso_now()
    for item in items:
        file_name = str(item.get("fileName") or "").strip()
        if not file_name:
            results.append(
                {
                    "fileName": item.get("fileName"),
                    "status": "rejected",
                    "error": {
                        "code": "invalid_request",
                        "message": "fileName is required",
                    },
                }
            )
            rejected += 1
            continue
        try:
            doc = _new_doc(
                ctx,
                file_name,
                str(item.get("model", "invoice")),
                reference=item.get("reference"),
                callback_url=item.get("callbackUrl"),
                tags=item.get("tags"),
                size_bytes=item.get("sizeBytes"),
                page_count=item.get("pages"),
                idempotency_key=None,
            )
        except DomainError as exc:
            results.append(
                {
                    "fileName": file_name,
                    "status": "rejected",
                    "error": {"code": exc.code, "message": exc.message},
                }
            )
            rejected += 1
        else:
            results.append(
                {
                    "fileName": file_name,
                    "documentId": doc["documentId"],
                    "status": "accepted",
                }
            )
            accepted += 1

    batch = {
        "batchId": batch_id,
        "object": "batch",
        "submitted": len(items),
        "accepted": accepted,
        "rejected": rejected,
        "results": results,
        "createdAt": created,
        "idempotencyKey": idem,
        "selfUrl": f"https://{_HOST}/v1/batches/{batch_id}",
    }
    batches[batch_id] = batch
    if scoped:
        keys[scoped] = batch_id
    return batch


@base.op(ID, "get_document")
def get_document(ctx: Ctx) -> dict:
    ctx.require("documentId")
    doc = ctx.state.table("documents").get(ctx.payload["documentId"])
    if doc is None:
        raise DomainError(404, "document_not_found", ctx.payload["documentId"])
    return doc


@base.op(ID, "cancel_document")
def cancel_document(ctx: Ctx) -> dict:
    """Cancel a queued document and discard any computed extraction before it can be read."""
    ctx.require("documentId")
    documents = ctx.state.table("documents")
    document_id = ctx.payload["documentId"]
    doc = documents.get(document_id)
    if doc is None:
        raise DomainError(404, "document_not_found", document_id)
    if doc["status"] in _TERMINAL_STATUSES:
        raise DomainError(
            409,
            "cancel_not_allowed",
            f"document in status {doc['status']!r} can no longer be cancelled",
        )
    now = _iso_now()
    doc["status"] = "cancelled"
    doc["cancelledAt"] = now
    doc["completedAt"] = now
    doc["processingDurationMs"] = 0
    ctx.state.table("extractions").pop(document_id, None)
    return doc


@base.op(ID, "get_extraction")
def get_extraction(ctx: Ctx) -> dict:
    """Return the extraction, completing the queued capture on the first poll."""
    ctx.require("documentId")
    doc = ctx.state.table("documents").get(ctx.payload["documentId"])
    if doc is None:
        raise DomainError(404, "document_not_found", ctx.payload["documentId"])
    if doc["status"] == "cancelled":
        raise DomainError(
            404,
            "extraction_not_found",
            "document was cancelled before extraction completed",
        )
    extractions = ctx.state.table("extractions")
    existing = extractions.get(doc["documentId"])
    if existing is not None:
        return existing

    extraction = gen.inkwell_extraction(doc)
    now = _iso_now()
    doc["status"] = extraction["status"]
    doc["documentType"] = extraction["documentType"]
    doc["confidence"] = extraction["confidence"]
    doc["startedAt"] = doc.get("startedAt") or doc["queuedAt"]
    doc["completedAt"] = now
    doc["processingDurationMs"] = extraction["processingMs"]
    extractions[doc["documentId"]] = extraction
    return extraction


@base.op(ID, "list_documents")
def list_documents(ctx: Ctx) -> dict:
    items = list(ctx.state.table("documents").values())
    status = ctx.get("status")
    if status:
        items = [d for d in items if d["status"] == status]
    model = ctx.get("model")
    if model:
        items = [d for d in items if d["model"] == model]
    items.sort(key=lambda d: d["createdAt"], reverse=True)
    return ctx.paginate(items, size_default=20)


@base.op(ID, "list_models")
def list_models(ctx: Ctx) -> dict:
    return {"object": "list", "data": list(ctx.state.table("models").values())}


@base.op(ID, "get_model")
def get_model(ctx: Ctx) -> dict:
    """Fetch a single published model by id."""
    ctx.require("modelId")
    model_id = ctx.payload["modelId"]
    model = ctx.state.table("models").get(model_id)
    if model is None:
        raise DomainError(404, "model_not_found", model_id)
    return model


@base.op(ID, "delete_document")
def delete_document(ctx: Ctx) -> dict:
    """Purge a document, its extraction, and any associated corrections, as a retention or right-to-erasure request would."""
    ctx.require("documentId")
    documents = ctx.state.table("documents")
    document_id = ctx.payload["documentId"]
    if document_id not in documents:
        raise DomainError(404, "document_not_found", document_id)
    documents.pop(document_id)
    ctx.state.table("extractions").pop(document_id, None)
    corrections = ctx.state.table("corrections")
    for cid in [
        cid for cid, rec in corrections.items() if rec["documentId"] == document_id
    ]:
        corrections.pop(cid, None)
    return {"documentId": document_id, "object": "document", "deleted": True}


@base.op(ID, "submit_correction")
def submit_correction(ctx: Ctx) -> dict:
    """Append a human-in-the-loop field correction; the extracted field is left intact and the correction is auditable."""
    ctx.require("documentId", "fieldPath", "value")
    document_id = ctx.payload["documentId"]
    doc = ctx.state.table("documents").get(document_id)
    if doc is None:
        raise DomainError(404, "document_not_found", document_id)
    extraction = ctx.state.table("extractions").get(document_id)
    if extraction is None:
        raise DomainError(
            409,
            "extraction_not_ready",
            "load the extraction with get_extraction before submitting corrections",
        )
    field_path = str(ctx.payload["fieldPath"])
    field = extraction["fields"].get(field_path)
    if field is None:
        raise DomainError(
            422,
            "unknown_field",
            f"field {field_path!r} is not present on this extraction",
        )

    correction_id = base.new_id("corr")
    record = {
        "correctionId": correction_id,
        "object": "correction",
        "documentId": document_id,
        "extractionId": extraction["extractionId"],
        "fieldPath": field_path,
        "previousValue": field["value"],
        "value": ctx.payload["value"],
        "previousConfidence": field["confidence"],
        "correctedBy": ctx.get("correctedBy"),
        "note": ctx.get("note"),
        "createdAt": _iso_now(),
    }
    ctx.state.table("corrections")[correction_id] = record
    extraction["corrections"].append(correction_id)
    return record


@base.op(ID, "list_corrections")
def list_corrections(ctx: Ctx) -> dict:
    """List corrections, optionally filtered by document."""
    document_id = ctx.get("documentId")
    items = list(ctx.state.table("corrections").values())
    if document_id:
        items = [c for c in items if c["documentId"] == document_id]
    items.sort(key=lambda c: c["createdAt"], reverse=True)
    return ctx.paginate(items, size_default=25)
