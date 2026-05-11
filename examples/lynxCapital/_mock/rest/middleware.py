"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Shared dependencies and middleware: auth, latency injection, fault evaluation, idempotency.
"""
from __future__ import annotations

import asyncio
import os
from typing import Awaitable, Callable

from fastapi import HTTPException, Request, Response

from _mock.faults.engine import FaultDecision, evaluate, profile_for
from _mock.rest import idempotency


def _expected_auth(provider: str) -> tuple[str, str, str] | None:
    p = profile_for(provider)
    auth = p.get("auth")
    if not auth:
        return None
    secret = os.getenv(auth["env"], f"dev-{provider}-key")
    return auth["header"], auth["prefix"], secret


def authenticate(provider: str, request: Request) -> str:
    """Validate the per-provider auth header. Returns the api-key string used as
    the rate-limit bucket identity."""
    spec = _expected_auth(provider)
    if spec is None:
        return "anon"
    header, prefix, expected = spec
    received = request.headers.get(header)
    if not received:
        raise HTTPException(status_code=401, detail=f"{provider}: missing {header}")
    if prefix and not received.startswith(prefix):
        raise HTTPException(status_code=401, detail=f"{provider}: bad auth prefix")
    token = received[len(prefix):] if prefix else received
    if token != expected:
        raise HTTPException(status_code=401, detail=f"{provider}: invalid credential")
    return token


async def apply_faults(
    provider: str,
    action: str,
    payload: dict,
    request: Request,
) -> FaultDecision:
    """Run the deterministic fault engine; sleep the latency; raise on errors.
    Returns the decision so handlers can record it."""
    api_key = authenticate(provider, request)
    attempt = int(request.headers.get("X-Attempt", "1"))
    decision = evaluate(provider, action, payload, attempt, api_key)
    if decision.delay_s > 0:
        await asyncio.sleep(decision.delay_s)
    if decision.error_status is not None:
        headers = {}
        if decision.rate_limited:
            headers["Retry-After"] = str(max(1, int(decision.retry_after_s) + 1))
        raise HTTPException(
            status_code=decision.error_status,
            detail=decision.error_body,
            headers=headers,
        )
    return decision


def idempotent(provider: str, request: Request, handler: Callable[[], dict]) -> dict:
    """If the provider requires idempotency keys, serve replays from the cache.
    Otherwise execute the handler directly."""
    p = profile_for(provider)
    if p.get("idempotency") != "required":
        return handler()
    key = request.headers.get("Idempotency-Key")
    if not key:
        raise HTTPException(status_code=400, detail=f"{provider}: Idempotency-Key required")
    prior = idempotency.get(provider, key)
    if prior is not None:
        return prior
    result = handler()
    idempotency.put(provider, key, result)
    return result
