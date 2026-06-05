"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Setup validation endpoint confirming OpenAI credentials and the local provider network.
"""
from __future__ import annotations

import os

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse

router = APIRouter()

_PROVIDER_HEALTH_DEFAULT = "http://127.0.0.1:9400/healthz"


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

    api_key = os.environ.get("OPENAI_API_KEY", "")
    steps.append({
        "id": "openai_key",
        "label": "OPENAI_API_KEY set",
        "ok": bool(api_key),
        "detail": "Found in environment." if api_key
                  else "Missing: add it to .env or your shell.",
    })

    provider_health = os.environ.get("LYNX_PROVIDER_HEALTH_URL", _PROVIDER_HEALTH_DEFAULT)
    ok, detail = await _ping(provider_health)
    steps.append({
        "id": "provider_network",
        "label": "Provider network reachable",
        "ok": ok,
        "detail": detail,
    })

    from app.api.hooks import required_secret_envs
    missing_secrets = [k for k in required_secret_envs() if not os.environ.get(k)]
    steps.append({
        "id": "webhook_secrets",
        "label": "Webhook signing secrets set",
        "ok": not missing_secrets,
        "detail": "All provider hook secrets present." if not missing_secrets
                  else f"Missing: {', '.join(missing_secrets)}",
    })

    overall = all(s["ok"] for s in steps)
    return JSONResponse({"ok": overall, "steps": steps})
