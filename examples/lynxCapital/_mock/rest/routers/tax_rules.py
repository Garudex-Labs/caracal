"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

tax-rules REST endpoints; the surface the vendored tax SDK calls into.
"""
from __future__ import annotations

from fastapi import APIRouter, Request

from _mock import cases
from _mock.rest.middleware import apply_faults

PROVIDER = "tax-rules"
router = APIRouter(prefix="/v1", tags=[PROVIDER])


@router.post("/withholding")
async def get_withholding_rate(payload: dict, request: Request) -> dict:
    await apply_faults(PROVIDER, "get_withholding_rate", payload, request)
    return cases.resolve(PROVIDER, "get_withholding_rate", payload)


@router.post("/tax_id/validate")
async def validate_tax_id(payload: dict, request: Request) -> dict:
    await apply_faults(PROVIDER, "validate_tax_id", payload, request)
    return cases.resolve(PROVIDER, "validate_tax_id", payload)


@router.get("/rules/snapshot")
async def rules_snapshot() -> dict:
    return {"version": "2026-04", "rules_count": 217, "checksum": "sha256:abc123"}
