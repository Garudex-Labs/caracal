"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Setup state inspection endpoint for Caracal workspace validation.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

router = APIRouter()
logger = logging.getLogger(__name__)


def _env() -> dict[str, str]:
    return {
        "session_token": os.environ.get("CCL_SESS_TOKEN", ""),
        "api_url":      os.environ.get("CCL_API_URL", ""),
        "workspace_id": os.environ.get("CCL_WORKSPACE_ID", ""),
    }


def _check_workspace() -> dict:
    """Verify the workspace is configured by querying the principals table."""
    try:
        principals = _query_db(_PRINCIPALS_SQL)
        if principals:
            return {"ok": True, "error": None}
        return {"ok": False, "error": "No principals found — workspace not yet configured."}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


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
        "detail":  "CCL_SESS_TOKEN, CCL_API_URL, CCL_WORKSPACE_ID" if env_ok
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
        probe = _check_workspace()
        steps.append({
            "id":     "workspace",
            "label":  "Workspace reachable",
            "ok":     probe["ok"],
            "detail": f"workspace={env['workspace_id']}" if probe["ok"] else probe["error"],
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

_TOOLS_SQL = (
    "SELECT json_agg(row_to_json(t)) FROM "
    "(SELECT tool_id, provider_name, resource_scope, action_scope "
    "FROM registered_tools WHERE active = true ORDER BY provider_name, tool_id) t;"
)

_MANDATES_SQL = (
    "SELECT json_agg(row_to_json(t)) FROM "
    "(SELECT mandate_id::text, issuer_id::text, subject_id::text, "
    "COALESCE(source_mandate_id::text, '') AS source_mandate_id "
    "FROM execution_mandates WHERE revoked = false AND valid_until > now() "
    "ORDER BY created_at DESC) t;"
)


def _query_db(sql: str) -> list:
    db_name = os.environ.get("CCL_DB_NAME", "caracal_db")
    db_user = os.environ.get("CCL_DB_USER", "caracal")
    db_password = os.environ.get("CCL_DB_PASSWORD", "caracal")
    result = subprocess.run(
        [
            "docker", "exec",
            "-e", f"PGPASSWORD={db_password}",
            "caracal-postgres-1",
            "psql", "-h", "localhost", "-U", db_user, "-d", db_name,
            "-At", "-c", sql,
        ],
        capture_output=True,
        text=True,
        timeout=10,
    )
    raw = result.stdout.strip()
    if not raw or raw == "null":
        return []
    return json.loads(raw)


@router.get("/principals")
def get_principals():
    try:
        principals = _query_db(_PRINCIPALS_SQL)
        if not principals:
            raise ValueError("No principals found in database")
        return JSONResponse({"ok": True, "principals": principals})
    except Exception as exc:
        logger.exception("Failed to fetch principals")
        return JSONResponse({"ok": False, "error": "Internal server error"}, status_code=500)


@router.get("/tools")
def get_tools():
    try:
        tools = _query_db(_TOOLS_SQL)
        return JSONResponse({"ok": True, "tools": tools})
    except Exception as exc:
        logger.exception("Failed to fetch tools")
        return JSONResponse({"ok": False, "error": "Internal server error"}, status_code=500)


@router.get("/mandates")
def get_mandates():
    try:
        mandates = _query_db(_MANDATES_SQL)
        return JSONResponse({"ok": True, "mandates": mandates})
    except Exception as exc:
        logger.exception("Failed to fetch mandates")
        return JSONResponse({"ok": False, "error": "Internal server error"}, status_code=500)
