"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Setup validation endpoint for Caracal SDK and gateway readiness.
"""
from __future__ import annotations

import asyncio
import os

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.services import partners, setup_catalog

router = APIRouter()


def _step(step_id: str, label: str, status: str, detail: str) -> dict:
    return {"id": step_id, "label": label, "status": status, "ok": status != "failed", "detail": detail}


async def _ping(url: str) -> tuple[bool, str]:
    try:
        async with httpx.AsyncClient(timeout=2.0) as http:
            r = await http.get(url)
        return (r.status_code < 500, f"{url} → {r.status_code}")
    except Exception as exc:
        return (False, f"{url} unreachable: {exc.__class__.__name__}")


@router.get("/validate")
async def validate_setup():
    steps: list[dict] = []

    caracal_identity = bool(os.environ.get("CARACAL_ZONE_ID") and os.environ.get("CARACAL_APPLICATION_ID"))
    steps.append(_step(
        "caracal_identity",
        "Caracal identity",
        "passed" if caracal_identity else "failed",
        "CARACAL_ZONE_ID and CARACAL_APPLICATION_ID are set." if caracal_identity else "Missing CARACAL_ZONE_ID or CARACAL_APPLICATION_ID.",
    ))

    caracal_auth = bool(os.environ.get("CARACAL_APP_CLIENT_SECRET") or os.environ.get("CARACAL_SUBJECT_TOKEN"))
    steps.append(_step(
        "caracal_auth",
        "Application credential",
        "passed" if caracal_auth else "failed",
        "Application auth is configured." if caracal_auth else "Set CARACAL_APP_CLIENT_SECRET or CARACAL_SUBJECT_TOKEN.",
    ))

    resources = setup_catalog.resource_bindings()
    external_provider_ids = [spec.id for spec in partners.catalog().values() if spec.auth != "none"]
    unmapped = [provider_id for provider_id in external_provider_ids if provider_id not in resources]
    resource_status = "passed" if resources and not unmapped else "failed"
    steps.append(_step(
        "caracal_resources",
        "Resource bindings",
        resource_status,
        f"{len(resources)} resource bindings configured." if resources and not unmapped else (
            f"{len(resources)} resource bindings configured; {len(unmapped)} provider ids are not mapped."
            if resources else "Set CARACAL_RESOURCES with provider resource ids and upstream URLs."
        ),
    ))

    provider_results = await asyncio.gather(*(
        _ping(f"{url.rstrip('/')}/healthz")
        for url in resources.values()
    )) if resources else []
    reachable = sum(1 for provider_ok, _ in provider_results if provider_ok)
    steps.append(_step(
        "provider_access",
        "Provider access",
        "passed" if provider_results and reachable == len(provider_results) else "failed",
        f"{reachable}/{len(provider_results)} mapped providers reachable." if provider_results else "No mapped providers available to validate.",
    ))

    caracal_ok = True
    details: list[str] = []
    for sid, label, default in (
        ("CARACAL_STS_URL", "Caracal STS", "http://localhost:8080"),
        ("CARACAL_COORDINATOR_URL", "Caracal Coordinator", "http://localhost:4000"),
        ("CARACAL_GATEWAY_URL", "Caracal Gateway", "http://localhost:8081"),
    ):
        base = os.environ.get(sid, default).rstrip("/")
        ok, detail = await _ping(f"{base}/healthz")
        caracal_ok = caracal_ok and ok
        details.append(f"{label}: {detail}")
    steps.append(_step(
        "caracal_runtime",
        "Caracal runtime",
        "passed" if caracal_ok else "failed",
        "; ".join(details),
    ))

    from app import caracal
    try:
        runtime = caracal.runtime()
        sdk_ok = runtime is not None
        steps.append(_step(
            "caracal_sdk",
            "Caracal SDK client",
            "passed" if sdk_ok else "failed",
            "SDK client is configured from CARACAL_* environment." if sdk_ok else "SDK client is not configured.",
        ))
    except Exception as exc:
        steps.append(_step(
            "caracal_sdk",
            "Caracal SDK client",
            "failed",
            f"SDK client failed to initialize: {exc.__class__.__name__}",
        ))

    overall = not any(s["status"] == "failed" for s in steps)
    return JSONResponse({"ok": overall, "steps": steps})
