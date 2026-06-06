"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Setup validation endpoint for environment, provider, webhook, and runtime readiness.
"""
from __future__ import annotations

import asyncio
import os
import shutil
import sys

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.services import partners
from app.services.setup_catalog import base_url, credential_vars

router = APIRouter()

_PROVIDER_HEALTH_DEFAULT = "http://127.0.0.1:9400/healthz"


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

    api_key = os.environ.get("OPENAI_API_KEY", "")
    steps.append(_step(
        "openai_key",
        "OpenAI configuration",
        "passed" if api_key else "failed",
        "OPENAI_API_KEY is set." if api_key else "Missing OPENAI_API_KEY; add it to .env or your shell.",
    ))

    steps.append(_step(
        "python_runtime",
        "Python runtime",
        "passed" if sys.version_info >= (3, 12) else "failed",
        f"Running Python {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}.",
    ))

    docker_path = shutil.which("docker")
    steps.append(_step(
        "docker",
        "Docker CLI",
        "passed" if docker_path else "warning",
        f"Docker CLI found at {docker_path}." if docker_path else "Docker CLI not found in PATH; provider startup commands require Docker.",
    ))

    provider_health = os.environ.get("LYNX_PROVIDER_HEALTH_URL", _PROVIDER_HEALTH_DEFAULT)
    ok, detail = await _ping(provider_health)
    specs = partners.catalog()
    health_results = await asyncio.gather(*(
        _ping(f"{base_url(spec)}/healthz")
        for spec in specs.values()
    ))
    reachable = sum(1 for provider_ok, _ in health_results if provider_ok)
    provider_status = "passed" if ok and reachable == len(health_results) else "failed"
    steps.append(_step(
        "provider_network",
        "Provider network",
        provider_status,
        f"{reachable}/{len(health_results)} providers reachable. Primary probe: {detail}",
    ))

    missing_provider_vars = [
        name
        for spec in specs.values()
        for name in credential_vars(spec)
        if not os.environ.get(name)
    ]
    steps.append(_step(
        "provider_credentials",
        "Provider credentials",
        "passed" if not missing_provider_vars else "failed",
        "All provider credential variables are set." if not missing_provider_vars else f"Missing: {', '.join(missing_provider_vars[:8])}{'...' if len(missing_provider_vars) > 8 else ''}",
    ))

    from app.api.hooks import required_secret_envs
    missing_secrets = [k for k in required_secret_envs() if not os.environ.get(k)]
    steps.append(_step(
        "webhook_secrets",
        "Webhook signing secrets",
        "passed" if not missing_secrets else "failed",
        "All provider hook secrets present." if not missing_secrets else f"Missing: {', '.join(missing_secrets)}",
    ))

    from app import caracal
    if caracal.enabled():
        caracal_ok = True
        details: list[str] = []
        for sid, label, default in (
            ("CARACAL_STS_URL", "Caracal STS reachable", "http://localhost:8080"),
            ("CARACAL_COORDINATOR_URL", "Caracal Coordinator reachable", "http://localhost:4000"),
            ("CARACAL_GATEWAY_URL", "Caracal Gateway reachable", "http://localhost:8081"),
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
    else:
        steps.append(_step(
            "caracal_runtime",
            "Caracal runtime",
            "warning",
            "CARACAL_ZONE_ID and CARACAL_APPLICATION_ID are not set; direct local provider mode will be used.",
        ))

    overall = not any(s["status"] == "failed" for s in steps)
    return JSONResponse({"ok": overall, "steps": steps})
