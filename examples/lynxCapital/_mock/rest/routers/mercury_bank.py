"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

mercury-bank REST endpoints. Synchronous balance reads, async settlement on writes.
"""
from __future__ import annotations

from fastapi import APIRouter, Request

from _mock import cases
from _mock.rest.middleware import apply_faults, idempotent
from _mock.webhooks.dispatcher import deliver

PROVIDER = "mercury-bank"
router = APIRouter(prefix="/v1", tags=[PROVIDER])


@router.post("/accounts/balance")
async def get_account_balance(payload: dict, request: Request) -> dict:
    await apply_faults(PROVIDER, "get_account_balance", payload, request)
    return cases.resolve(PROVIDER, "get_account_balance", payload)


@router.post("/payments")
async def submit_payment(payload: dict, request: Request) -> dict:
    await apply_faults(PROVIDER, "submit_payment", payload, request)

    def _build() -> dict:
        body = cases.resolve(PROVIDER, "submit_payment", payload)
        if body.get("status") == "submitted":
            body["status"] = "pending"
            deliver(PROVIDER, "transaction.posted", {
                "tx_id": body.get("tx_id"),
                "vendor_id": payload.get("vendor_id"),
                "amount": payload.get("amount"),
                "currency": payload.get("currency"),
                "status": "posted",
            }, delay_s=0.5)
            deliver(PROVIDER, "transaction.settled", {
                "tx_id": body.get("tx_id"),
                "vendor_id": payload.get("vendor_id"),
                "amount": payload.get("amount"),
                "currency": payload.get("currency"),
                "status": "settled",
            }, delay_s=1.5)
        return body

    return idempotent(PROVIDER, request, _build)
