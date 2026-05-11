"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Asynchronous job queue: providers that submit work (netsuite, sap-erp, ocr-vision,
close-engine, regulatory-filings) accept a request, return 202 with a job_id, and
later either expose poll status or fire a webhook when the job completes.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from threading import Lock
from typing import Callable
from uuid import uuid4

from _mock.faults.engine import _u01, _seed, profile_for
from _mock.webhooks.dispatcher import deliver


@dataclass
class Job:
    job_id: str
    provider: str
    action: str
    submitted_at: float
    ready_at: float
    payload: dict
    result: dict | None = None
    status: str = "queued"


_jobs: dict[str, Job] = {}
_lock = Lock()


def _processing_delay(provider: str, action: str, payload: dict) -> float:
    p = profile_for(provider).get("job") or {"processing_ms": 200, "jitter_ms": 100}
    seed = _seed(provider, action, payload, 1, "job")
    base = p["processing_ms"]
    jitter = p.get("jitter_ms", 0)
    if jitter:
        base += (_u01(seed, "jitter") - 0.5) * 2 * jitter
    return max(0.001, base / 1000.0)


def submit(
    provider: str,
    action: str,
    payload: dict,
    completer: Callable[[], dict],
    *,
    webhook_event: str | None = None,
) -> Job:
    """Register a job; spawn an async task that completes it after the
    deterministic processing delay, optionally firing a webhook when done."""
    delay = _processing_delay(provider, action, payload)
    now = time.time()
    job = Job(
        job_id=f"job_{provider[:3]}_{uuid4().hex[:12]}",
        provider=provider,
        action=action,
        submitted_at=now,
        ready_at=now + delay,
        payload=payload,
        status="processing",
    )
    with _lock:
        _jobs[job.job_id] = job

    async def _complete() -> None:
        await asyncio.sleep(delay)
        with _lock:
            j = _jobs.get(job.job_id)
            if j is None:
                return
            try:
                j.result = completer()
                j.status = "completed"
            except Exception as exc:
                j.result = {"error": "job_failed", "message": str(exc)}
                j.status = "failed"
            terminal = dict(j.__dict__)
        if webhook_event:
            deliver(provider, webhook_event, {
                "job_id": job.job_id,
                "action": action,
                "status": terminal["status"],
                "result": terminal["result"],
            })

    asyncio.get_event_loop().create_task(_complete())
    return job


def get(job_id: str) -> Job | None:
    with _lock:
        return _jobs.get(job_id)


def to_dict(job: Job) -> dict:
    return {
        "job_id": job.job_id,
        "provider": job.provider,
        "action": job.action,
        "status": job.status,
        "submitted_at": job.submitted_at,
        "ready_at": job.ready_at,
        "result": job.result,
    }


def clear() -> None:
    with _lock:
        _jobs.clear()
