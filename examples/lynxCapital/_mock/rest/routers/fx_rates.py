"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

fx-rates REST snapshot endpoint; the SSE stream lives in streaming/fx_rates/.
"""
from __future__ import annotations

from fastapi import APIRouter, Request

from _mock import cases
from _mock.rest.middleware import apply_faults

PROVIDER = "fx-rates"
router = APIRouter(prefix="/v1", tags=[PROVIDER])


@router.post("/rate")
async def get_rate(payload: dict, request: Request) -> dict:
    await apply_faults(PROVIDER, "get_rate", payload, request)
    return cases.resolve(PROVIDER, "get_rate", payload)


@router.post("/rates/batch")
async def get_rates_batch(payload: dict, request: Request) -> dict:
    await apply_faults(PROVIDER, "get_rates_batch", payload, request)
    return cases.resolve(PROVIDER, "get_rates_batch", payload)
