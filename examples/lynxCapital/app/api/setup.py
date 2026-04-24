"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Setup state inspection endpoint for Caracal workspace validation.
"""
from __future__ import annotations

import json
import os
import subprocess

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

router = APIRouter()


def _env() -> dict[str, str]:
    return {
        "api_key":      os.environ.get("CARACAL_API_KEY", ""),
        "api_url":      os.environ.get("CARACAL_API_URL", ""),
        "workspace_id": os.environ.get("CARACAL_WORKSPACE_ID", ""),
    }


async def _check_workspace(scope) -> dict:
    """Try a lightweight workspace probe via the SDK scope."""
    try:
        # caracal-integration: probe workspace health by calling a no-op tool
        await scope.tools.call(
            tool_id="provider:__probe__:resource:health:action:ping",
            tool_args={},
            metadata={"correlation_id": "setup-probe"},
        )
        return {"ok": True, "error": None}
    except Exception as exc:
        msg = str(exc)
        # 404 = workspace reached but tool not registered → workspace valid
        if "404" in msg or "not found" in msg.lower() or "not mocked" in msg.lower():
            return {"ok": True, "error": None}
        return {"ok": False, "error": msg}


@router.get("/validate")
async def validate_setup(request: Request):
    env = _env()
    steps: list[dict] = []

    # Step 1: env vars present
    env_ok = all(env.values())
    steps.append({
        "id":      "env",
        "label":   "Environment variables set",
        "ok":      env_ok,
        "detail":  "CARACAL_API_KEY, CARACAL_API_URL, CARACAL_WORKSPACE_ID" if env_ok
                   else "One or more required env vars are missing.",
    })

    # Step 2: SDK client constructed (app.state.caracal set at startup)
    scope = getattr(getattr(request.app, "state", None), "caracal", None)
    client_ok = scope is not None
    steps.append({
        "id":     "client",
        "label":  "Caracal SDK client initialized",
        "ok":     client_ok,
        "detail": f"Workspace: {env['workspace_id']}" if client_ok
                  else "Client not initialized (check startup logs).",
    })

    # Step 3: workspace reachable
    if client_ok:
        probe = await _check_workspace(scope)
        steps.append({
            "id":     "workspace",
            "label":  "Workspace reachable",
            "ok":     probe["ok"],
            "detail": f"ws={env['workspace_id']}" if probe["ok"] else probe["error"],
        })
    else:
        steps.append({
            "id":     "workspace",
            "label":  "Workspace reachable",
            "ok":     False,
            "detail": "Skipped: client not initialized.",
        })

    overall = all(s["ok"] for s in steps)
    return JSONResponse({"ok": overall, "steps": steps})


_PRINCIPALS_SQL = (
    "SELECT json_agg(row_to_json(t)) FROM "
    "(SELECT principal_id::text, name, principal_kind, owner "
    "FROM public.principals ORDER BY created_at) t;"
)


@router.get("/principals")
def get_principals():
    try:
        db_name = os.environ.get("CARACAL_DB_NAME", "caracal_db")
        db_user = os.environ.get("CARACAL_DB_USER", "caracal")
        db_pass = os.environ.get("CARACAL_DB_PASSWORD", "caracal")
        result = subprocess.run(
            [
                "docker", "exec",
                "-e", f"PGPASSWORD={db_pass}",
                "caracal-postgres-1",
                "psql", "-h", "localhost", "-U", db_user, "-d", db_name,
                "-At", "-c", _PRINCIPALS_SQL,
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        raw = result.stdout.strip()
        if not raw or raw == "null":
            raise ValueError(result.stderr.strip() or "Empty result from database")
        principals = json.loads(raw)
        return JSONResponse({"ok": True, "principals": principals})
    except Exception as exc:
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=500)
