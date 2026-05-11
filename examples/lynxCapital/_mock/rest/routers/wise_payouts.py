"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

wise-payouts REST endpoints; quote-then-execute with delivery webhook.
"""
from __future__ import annotations

from fastapi import APIRouter, Request

from _mock import cases
from _mock.rest.middleware import apply_faults, idempotent
from _mock.webhooks.dispatcher import deliver

PROVIDER = "wise-payouts"
router = APIRouter(prefix="/v1", tags=[PROVIDER])


@router.post("/quotes")
async def get_quote(payload: dict, request: Request) -> dict:
    await apply_faults(PROVIDER, "get_quote", payload, request)
    return cases.resolve(PROVIDER, "get_quote", payload)


@router.post("/transfers")
async def submit_payout(payload: dict, request: Request) -> dict:
    await apply_faults(PROVIDER, "submit_payout", payload, request)

    def _build() -> dict:
        body = cases.resolve(PROVIDER, "submit_payout", payload)
        if body.get("status") == "submitted":
            body["status"] = "processing"
            deliver(PROVIDER, "transfer.delivered", {
                "transfer_id": body.get("transfer_id"),
                "vendor_id": payload.get("vendor_id"),
                "status": "delivered",
            }, delay_s=2.0)
        return body

    return idempotent(PROVIDER, request, _build)
