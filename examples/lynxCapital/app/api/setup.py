"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Setup validation endpoint for end-user Caracal configuration completeness.
"""
from __future__ import annotations

import os

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.services import partners, setup_catalog

router = APIRouter()


def _step(step_id: str, label: str, status: str, detail: str) -> dict:
    return {"id": step_id, "label": label, "status": status, "ok": status != "missing", "detail": detail}


@router.get("/validate")
async def validate_setup():
    steps: list[dict] = []

    zone = os.environ.get("CARACAL_ZONE_ID")
    application = os.environ.get("CARACAL_APPLICATION_ID")
    identity_ok = bool(zone and application)
    steps.append(_step(
        "identity",
        "Required identifiers",
        "passed" if identity_ok else "missing",
        "Zone and application are set." if identity_ok else "Add the zone and application from the Caracal console.",
    ))

    auth_ok = bool(os.environ.get("CARACAL_APP_CLIENT_SECRET") or os.environ.get("CARACAL_SUBJECT_TOKEN"))
    steps.append(_step(
        "auth",
        "Application access",
        "passed" if auth_ok else "missing",
        "Application authority is configured." if auth_ok else "Add the application secret issued by the Caracal console.",
    ))

    resources = setup_catalog.resource_bindings()
    external_ids = [spec.id for spec in partners.catalog().values() if spec.auth != "none"]
    mapped = [provider_id for provider_id in external_ids if provider_id in resources]
    if external_ids and len(mapped) == len(external_ids):
        mapping_status = "passed"
        mapping_detail = f"All {len(external_ids)} providers map to a Caracal resource."
    elif mapped:
        mapping_status = "warning"
        mapping_detail = f"{len(mapped)} of {len(external_ids)} providers mapped. Map the rest from the Providers step."
    else:
        mapping_status = "missing"
        mapping_detail = "Map providers to Caracal resources from the Providers step."
    steps.append(_step("mapping", "Caracal mapping", mapping_status, mapping_detail))

    if not external_ids:
        provider_status, provider_detail = "passed", "No external providers require credentials."
    elif len(mapped) == len(external_ids):
        provider_status, provider_detail = "passed", "Provider setup is complete."
    elif mapped:
        provider_status, provider_detail = "warning", f"{len(external_ids) - len(mapped)} providers still need setup."
    else:
        provider_status, provider_detail = "missing", "Configure providers manually or with the automated script."
    steps.append(_step("providers", "Provider setup", provider_status, provider_detail))

    overall = not any(step["status"] == "missing" for step in steps)
    return JSONResponse({"ok": overall, "steps": steps})
