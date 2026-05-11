"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

REST mock server entry: FastAPI app exposing every provider's REST surface.
Each provider uses a distinct path prefix; clients reach it via the docker
network alias <provider>.mock so traffic looks routed by host even though one
container fronts them all.
"""
from __future__ import annotations

import os

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from _mock.rest.routers import (
    close_engine,
    compliance_nexus,
    customer_billing,
    fx_rates,
    mercury_bank,
    netsuite,
    ocr_vision,
    quickbooks,
    regulatory_filings,
    sap_erp,
    stripe_treasury,
    tax_rules,
    wise_payouts,
)


_PROVIDER_PREFIX = {
    "mercury-bank":       "/v1",
    "wise-payouts":       "/v1",
    "stripe-treasury":    "/v1/treasury",
    "quickbooks":         "/v3",
    "netsuite":           "/services/rest/v1",
    "sap-erp":            "/sap/opu/odata/sap",
    "ocr-vision":         "/v1/documents",
    "close-engine":       "/v1/close",
    "regulatory-filings": "/v1/regulatory",
    "customer-billing":   "/v1",
    "fx-rates":           "/v1",
    "tax-rules":          "/v1",
    "compliance-nexus":   "/v1",
}


_ALL_ROUTERS = [
    mercury_bank.router,
    wise_payouts.router,
    stripe_treasury.router,
    quickbooks.router,
    netsuite.router,
    sap_erp.router,
    ocr_vision.router,
    close_engine.router,
    regulatory_filings.router,
    customer_billing.router,
    fx_rates.router,
    tax_rules.router,
    compliance_nexus.router,
]


app = FastAPI(title="lynx-mock-network")
for r in _ALL_ROUTERS:
    app.include_router(r)


_STRICT_HOST = os.getenv("LYNX_MOCK_STRICT_HOST", "0") == "1"


@app.get("/")
async def root() -> dict:
    return {"providers": sorted(_PROVIDER_PREFIX.keys())}


@app.get("/healthz")
async def healthz() -> dict:
    return {"status": "ok"}


@app.middleware("http")
async def host_check(request: Request, call_next):
    """Optionally enforce that traffic to a provider path arrives with the
    matching <provider>.mock Host header (production-shaped routing)."""
    if not _STRICT_HOST or request.url.path in {"/", "/healthz"}:
        return await call_next(request)
    host = request.headers.get("host", "").split(":", 1)[0]
    if not host.endswith(".mock"):
        return JSONResponse(status_code=400, content={"error": "Host header must be <provider>.mock"})
    provider = host[: -len(".mock")]
    expected = _PROVIDER_PREFIX.get(provider)
    if expected is None:
        return JSONResponse(status_code=404, content={"error": f"unknown provider: {provider}"})
    if not request.url.path.startswith(expected):
        return JSONResponse(status_code=404, content={
            "error": f"path {request.url.path!r} not served by provider {provider!r}",
        })
    return await call_next(request)


@app.exception_handler(HTTPException)
async def _http_exc(_request: Request, exc: HTTPException) -> JSONResponse:
    body = exc.detail if isinstance(exc.detail, dict) else {"error": str(exc.detail)}
    return JSONResponse(status_code=exc.status_code, content=body, headers=exc.headers or {})
