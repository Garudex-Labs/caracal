"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

customer-billing REST endpoints with rich event webhook stream.
"""
from __future__ import annotations

from fastapi import APIRouter, Request

from _mock import cases
from _mock.rest.middleware import apply_faults, idempotent
from _mock.webhooks.dispatcher import deliver

PROVIDER = "customer-billing"
router = APIRouter(prefix="/v1", tags=[PROVIDER])


@router.post("/invoices")
async def issue_customer_invoice(payload: dict, request: Request) -> dict:
    await apply_faults(PROVIDER, "issue_customer_invoice", payload, request)

    def _build() -> dict:
        body = cases.resolve(PROVIDER, "issue_customer_invoice", payload)
        deliver(PROVIDER, "invoice.issued", {
            "invoice_id": body.get("invoice_id"),
            "customer_id": payload.get("customer_id"),
            "amount": payload.get("amount"),
        }, delay_s=0.2)
        return body

    return idempotent(PROVIDER, request, _build)


@router.post("/dunning")
async def send_dunning_notice(payload: dict, request: Request) -> dict:
    await apply_faults(PROVIDER, "send_dunning_notice", payload, request)
    return cases.resolve(PROVIDER, "send_dunning_notice", payload)


@router.post("/payments/apply")
async def apply_customer_payment(payload: dict, request: Request) -> dict:
    await apply_faults(PROVIDER, "apply_customer_payment", payload, request)

    def _build() -> dict:
        body = cases.resolve(PROVIDER, "apply_customer_payment", payload)
        deliver(PROVIDER, "payment.applied", {
            "invoice_id": payload.get("invoice_id"),
            "amount": payload.get("amount"),
            "status": body.get("status"),
        }, delay_s=0.4)
        return body

    return idempotent(PROVIDER, request, _build)


@router.post("/ar_aging")
async def get_ar_aging(payload: dict, request: Request) -> dict:
    await apply_faults(PROVIDER, "get_ar_aging", payload, request)
    return cases.resolve(PROVIDER, "get_ar_aging", payload)
