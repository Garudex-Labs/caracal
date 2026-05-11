"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

compliance-nexus sync REST endpoints; streaming feed lives in streaming/compliance/.
"""
from __future__ import annotations

from fastapi import APIRouter, Request

from _mock import cases
from _mock.rest.middleware import apply_faults
from _mock.webhooks.dispatcher import deliver

PROVIDER = "compliance-nexus"
router = APIRouter(prefix="/v1", tags=[PROVIDER])


@router.post("/vendor/check")
async def check_vendor(payload: dict, request: Request) -> dict:
    await apply_faults(PROVIDER, "check_vendor", payload, request)
    return cases.resolve(PROVIDER, "check_vendor", payload)


@router.post("/transaction/check")
async def check_transaction(payload: dict, request: Request) -> dict:
    await apply_faults(PROVIDER, "check_transaction", payload, request)
    body = cases.resolve(PROVIDER, "check_transaction", payload)
    if body.get("decision") == "blocked" or body.get("alerts"):
        deliver(PROVIDER, "compliance.alert", {
            "vendor_id": payload.get("vendor_id"),
            "alerts": body.get("alerts", []),
            "decision": body.get("decision"),
        }, delay_s=0.2)
    return body


@router.post("/vendor/kyb")
async def kyb_screen_vendor(payload: dict, request: Request) -> dict:
    await apply_faults(PROVIDER, "kyb_screen_vendor", payload, request)
    return cases.resolve(PROVIDER, "kyb_screen_vendor", payload)


@router.post("/vendor/refresh")
async def refresh_vendor_compliance(payload: dict, request: Request) -> dict:
    await apply_faults(PROVIDER, "refresh_vendor_compliance", payload, request)
    return cases.resolve(PROVIDER, "refresh_vendor_compliance", payload)
