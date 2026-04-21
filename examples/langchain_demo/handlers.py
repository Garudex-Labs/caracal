"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Local logic tool handlers for the demo ops-api provider.
"""

from __future__ import annotations

import os
from typing import Any


_DEMO_MODE = os.environ.get("CARACAL_DEMO_MODE", "mock").strip().lower()


def _is_mock() -> bool:
    return os.environ.get("CARACAL_DEMO_MODE", "mock").strip().lower() == "mock"


async def read_incident(*, principal_id: str, service: str = "demo-api", **_: Any) -> dict:
    """Read current incident context for the given service."""
    if _is_mock():
        return {
            "service": service,
            "severity": "P2",
            "open_count": 3,
            "incidents": [
                {"id": "INC-1001", "title": "High error rate on /checkout", "severity": "P2", "opened_at": "2026-04-21T08:12:00Z"},
                {"id": "INC-1002", "title": "Latency spike on payment-service", "severity": "P3", "opened_at": "2026-04-21T09:45:00Z"},
                {"id": "INC-1003", "title": "Disk usage warning on db-primary", "severity": "P3", "opened_at": "2026-04-21T10:01:00Z"},
            ],
            "principal_id": principal_id,
        }
    import httpx
    base = os.environ.get("OPS_API_URL", "http://localhost:9000")
    async with httpx.AsyncClient(base_url=base, timeout=10) as client:
        resp = await client.get("/incidents", params={"service": service})
        resp.raise_for_status()
        data = dict(resp.json())
        data["principal_id"] = principal_id
        return data


async def read_deployment(*, principal_id: str, service: str = "demo-api", **_: Any) -> dict:
    """Read current deployment state for the given service."""
    if _is_mock():
        return {
            "service": service,
            "current_version": "v1.8.3",
            "previous_version": "v1.8.2",
            "deployed_at": "2026-04-21T07:55:00Z",
            "deployer": "ci-pipeline",
            "status": "stable",
            "replicas": {"desired": 6, "ready": 6, "available": 6},
            "recent_changes": [
                "Bumped payment-service timeout from 3s to 5s",
                "Added circuit breaker on /checkout dependency",
            ],
            "principal_id": principal_id,
        }
    import httpx
    base = os.environ.get("OPS_API_URL", "http://localhost:9000")
    async with httpx.AsyncClient(base_url=base, timeout=10) as client:
        resp = await client.get("/deployments/current", params={"service": service})
        resp.raise_for_status()
        data = dict(resp.json())
        data["principal_id"] = principal_id
        return data


async def read_logs(*, principal_id: str, service: str = "demo-api", lines: int = 20, **_: Any) -> dict:
    """Read recent structured log excerpts for the given service."""
    if _is_mock():
        return {
            "service": service,
            "lines_returned": 5,
            "logs": [
                {"ts": "2026-04-21T10:15:03Z", "level": "ERROR", "msg": "upstream timeout: payment-gateway /charge", "duration_ms": 5003},
                {"ts": "2026-04-21T10:15:07Z", "level": "WARN",  "msg": "circuit breaker open: payment-gateway", "state": "open"},
                {"ts": "2026-04-21T10:15:09Z", "level": "INFO",  "msg": "retry attempt 1/3 for /charge", "attempt": 1},
                {"ts": "2026-04-21T10:15:12Z", "level": "INFO",  "msg": "retry succeeded after 3103ms", "duration_ms": 3103},
                {"ts": "2026-04-21T10:15:30Z", "level": "WARN",  "msg": "p99 latency above threshold: 4800ms vs 2000ms threshold"},
            ],
            "principal_id": principal_id,
        }
    import httpx
    base = os.environ.get("OPS_API_URL", "http://localhost:9000")
    async with httpx.AsyncClient(base_url=base, timeout=10) as client:
        resp = await client.get("/logs", params={"service": service, "lines": lines})
        resp.raise_for_status()
        data = dict(resp.json())
        data["principal_id"] = principal_id
        return data


async def submit_recommendation(
    *,
    principal_id: str,
    summary: str = "",
    findings: dict | None = None,
    run_id: str = "",
    **_: Any,
) -> dict:
    """Submit aggregated recommendation from the orchestrator."""
    findings = findings or {}
    if _is_mock():
        return {
            "accepted": True,
            "recommendation_id": f"REC-{run_id[:8]}",
            "summary": summary or "No summary provided.",
            "findings_count": len(findings),
            "principal_id": principal_id,
        }
    import httpx
    base = os.environ.get("OPS_API_URL", "http://localhost:9000")
    payload = {"summary": summary, "findings": findings, "run_id": run_id, "submitted_by": principal_id}
    async with httpx.AsyncClient(base_url=base, timeout=10) as client:
        resp = await client.post("/recommendations", json=payload)
        resp.raise_for_status()
        data = dict(resp.json())
        data["principal_id"] = principal_id
        return data
