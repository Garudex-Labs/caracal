"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Setup validation endpoint for end-user Caracal configuration completeness.
"""
from __future__ import annotations

import os

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app import caracal, tenancy
from app.services import setup_catalog

router = APIRouter()


def _step(step_id: str, label: str, status: str, detail: str) -> dict:
    return {"id": step_id, "label": label, "status": status, "ok": status != "missing", "detail": detail}


@router.get("/validate")
async def validate_setup():
    model = tenancy.load_model()
    steps: list[dict] = []

    zone_ok = bool(os.environ.get("CARACAL_ZONE_ID"))
    steps.append(_step(
        "identity",
        "Zone",
        "passed" if zone_ok else "missing",
        "The zone is set." if zone_ok else "Add CARACAL_ZONE_ID from the Caracal Console.",
    ))

    credentialed = [
        app.id for app in model.applications
        if caracal.application_credentials(app.id) == (True, True)
    ]
    if len(credentialed) == len(model.applications):
        app_status = "passed"
        app_detail = f"All {len(model.applications)} application boundaries have an id and secret."
    elif credentialed:
        app_status = "warning"
        app_detail = (
            f"{len(credentialed)} of {len(model.applications)} applications configured. "
            "Export the LYNX_CARACAL_<APP>_APPLICATION_ID and _CLIENT_SECRET values printed by provision.py."
        )
    else:
        app_status = "missing"
        app_detail = "Run scripts/provision.py and export the printed application credentials."
    steps.append(_step("applications", "Application boundaries", app_status, app_detail))

    provisioned_providers, provisioned_resources = setup_catalog.provisioned_state()
    providers_ready = sum(1 for p in model.providers if p.identifier in provisioned_providers)
    if providers_ready == len(model.providers):
        provider_status = "passed"
        provider_detail = f"All {len(model.providers)} credential providers are registered."
    elif providers_ready:
        provider_status = "warning"
        provider_detail = f"{providers_ready} of {len(model.providers)} providers registered. Re-run scripts/provision.py."
    else:
        provider_status = "missing"
        provider_detail = "Register the partner credential providers with scripts/provision.py."
    steps.append(_step("providers", "Credential providers", provider_status, provider_detail))

    views_ready = sum(1 for r in model.resources if r.identifier in provisioned_resources)
    if views_ready == len(model.resources):
        view_status = "passed"
        view_detail = f"All {len(model.resources)} resource views are bound to their applications."
    elif views_ready:
        view_status = "warning"
        view_detail = f"{views_ready} of {len(model.resources)} resource views created. Re-run scripts/provision.py."
    else:
        view_status = "missing"
        view_detail = "Create the per-application resource views with scripts/provision.py."
    steps.append(_step("resources", "Resource views", view_status, view_detail))

    overall = not any(step["status"] == "missing" for step in steps)
    return JSONResponse({"ok": overall, "steps": steps})
