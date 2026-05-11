"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

quickbooks REST endpoints; OAuth2-style bearer auth and tight rate limits.
"""
from __future__ import annotations

from fastapi import APIRouter, Request

from _mock import cases
from _mock.rest.middleware import apply_faults, idempotent

PROVIDER = "quickbooks"
router = APIRouter(prefix="/v3", tags=[PROVIDER])


@router.post("/vendor")
async def get_vendor(payload: dict, request: Request) -> dict:
    await apply_faults(PROVIDER, "get_vendor", payload, request)
    return cases.resolve(PROVIDER, "get_vendor", payload)


@router.post("/bill")
async def match_bill(payload: dict, request: Request) -> dict:
    await apply_faults(PROVIDER, "match_bill", payload, request)
    return cases.resolve(PROVIDER, "match_bill", payload)


@router.post("/billpayment")
async def create_vendor_payment(payload: dict, request: Request) -> dict:
    await apply_faults(PROVIDER, "create_vendor_payment", payload, request)
    return idempotent(PROVIDER, request, lambda: cases.resolve(PROVIDER, "create_vendor_payment", payload))
