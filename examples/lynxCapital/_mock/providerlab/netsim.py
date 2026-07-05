"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Network simulation that makes lab providers feel like remote third parties through request ids, latency, rate limits, and faults.
"""

from __future__ import annotations

import asyncio
import os
import random
import threading
import time
import uuid

from starlette.requests import Request
from starlette.responses import JSONResponse, Response

FAST = os.getenv("PROVIDERLAB_FAST", "0") == "1"


class _Bucket:
    def __init__(self, capacity: int, refill_per_s: float):
        self.capacity = capacity
        self.refill = refill_per_s
        self.tokens = float(capacity)
        self.updated = time.monotonic()
        self.lock = threading.Lock()

    def take(self) -> tuple[bool, float]:
        with self.lock:
            now = time.monotonic()
            self.tokens = min(
                self.capacity, self.tokens + (now - self.updated) * self.refill
            )
            self.updated = now
            if self.tokens >= 1.0:
                self.tokens -= 1.0
                return True, 0.0
            return False, (1.0 - self.tokens) / self.refill


# Per-profile behavior: token-bucket size/refill, latency band, and transient
# outage rate. Each profile mimics a different class of real provider operations.
_PROFILES: dict[str, dict] = {
    "standard": {
        "capacity": 120,
        "refill": 30.0,
        "latency": (0.02, 0.12),
        "outage": 0.015,
    },
    "flaky": {"capacity": 90, "refill": 20.0, "latency": (0.05, 0.30), "outage": 0.06},
    "strict": {"capacity": 40, "refill": 10.0, "latency": (0.02, 0.10), "outage": 0.01},
    "quiet": {"capacity": 240, "refill": 60.0, "latency": (0.0, 0.02), "outage": 0.0},
}


def _profile(provider) -> dict:
    return _PROFILES.get(
        getattr(provider, "failure_profile", "standard"), _PROFILES["standard"]
    )


_buckets: dict[str, _Bucket] = {}
_bucket_lock = threading.Lock()


def _bucket_for(key: str, capacity: int, refill: float) -> _Bucket:
    with _bucket_lock:
        if key not in _buckets:
            _buckets[key] = _Bucket(capacity=capacity, refill_per_s=refill)
        return _buckets[key]


def install(app, provider) -> None:
    """Attach the external-service behavior layer to a provider app."""

    server_name = f"{provider.brand.replace(' ', '')}/1.0"
    profile = _profile(provider)

    @app.middleware("http")
    async def _netsim(request: Request, call_next):
        if request.url.path.startswith(
            ("/__lab", "/healthz", "/.well-known", "/static")
        ):
            return await call_next(request)

        caller = request.headers.get(
            provider.apikey_field, request.client.host if request.client else "anon"
        )
        allowed, retry_after = _bucket_for(
            f"{provider.id}:{caller}", profile["capacity"], profile["refill"]
        ).take()
        if not allowed:
            return _decorate(
                JSONResponse(
                    status_code=429,
                    content={"error": "rate_limited", "message": "Too many requests"},
                ),
                server_name,
                retry_after=retry_after,
            )

        if not FAST:
            low, high = profile["latency"]
            if high > 0:
                await asyncio.sleep(random.uniform(low, high))
            if profile["outage"] and random.random() < profile["outage"]:
                return _decorate(
                    JSONResponse(
                        status_code=503,
                        content={
                            "error": "upstream_unavailable",
                            "message": "Transient provider error",
                        },
                    ),
                    server_name,
                )

        response = await call_next(request)
        return _decorate(response, server_name)

    def _decorate(
        response: Response, server_name: str, *, retry_after: float | None = None
    ) -> Response:
        response.headers["Server"] = server_name
        response.headers["X-Request-Id"] = uuid.uuid4().hex
        response.headers["X-RateLimit-Limit"] = str(profile["capacity"])
        if retry_after is not None:
            response.headers["Retry-After"] = str(max(1, round(retry_after)))
        return response
