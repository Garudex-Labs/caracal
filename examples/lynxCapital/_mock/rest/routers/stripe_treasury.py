"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

stripe-treasury REST endpoints; the surface vendored SDK calls into.
"""
from __future__ import annotations

from fastapi import APIRouter, Request

from _mock import cases
from _mock.rest.middleware import apply_faults, idempotent
from _mock.webhooks.dispatcher import deliver

PROVIDER = "stripe-treasury"
router = APIRouter(prefix="/v1/treasury", tags=[PROVIDER])


@router.post("/financial_accounts/lookup")
async def get_financial_account(payload: dict, request: Request) -> dict:
    await apply_faults(PROVIDER, "get_financial_account", payload, request)
    return cases.resolve(PROVIDER, "get_financial_account", payload)


@router.post("/outbound_payments")
async def create_outbound_payment(payload: dict, request: Request) -> dict:
    await apply_faults(PROVIDER, "create_outbound_payment", payload, request)

    def _build() -> dict:
        body = cases.resolve(PROVIDER, "create_outbound_payment", payload)
        if body.get("status") in {"submitted", "processing"}:
            body["status"] = "processing"
            deliver(PROVIDER, "treasury.outbound_payment.posted", {
                "id": body.get("payment_id") or body.get("id"),
                "vendor_id": payload.get("vendor_id"),
                "amount": payload.get("amount"),
                "status": "posted",
            }, delay_s=0.8)
        return body

    return idempotent(PROVIDER, request, _build)
