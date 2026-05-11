"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Generic async-job router factory: submit returns 202 with job_id; status polls;
completion fires a webhook. Used by ERP and document-processing providers.
"""
from __future__ import annotations

from typing import Iterable

from fastapi import APIRouter, HTTPException, Request, Response

from _mock import cases
from _mock.rest import jobs
from _mock.rest.middleware import apply_faults, idempotent


def build(
    provider: str,
    *,
    prefix: str,
    sync_actions: Iterable[str] = (),
    job_actions: Iterable[tuple[str, str]] = (),
    write_actions: Iterable[str] = (),
) -> APIRouter:
    """Build a router exposing:
    - POST /{prefix}/{action} for sync_actions (cases lookup with faults).
    - POST /{prefix}/{action} for job_actions (returns 202+job_id, fires webhook).
    - GET  /{prefix}/jobs/{job_id} for polling.
    write_actions get idempotency key enforcement.
    """
    router = APIRouter(prefix=f"/{prefix}", tags=[provider])
    job_event_map = dict(job_actions)
    writes = set(write_actions)

    for action in sync_actions:
        @router.post(f"/{action}", name=f"{provider}-{action}")
        async def _sync(payload: dict, request: Request, _action: str = action) -> dict:
            await apply_faults(provider, _action, payload, request)
            if _action in writes:
                return idempotent(provider, request, lambda: cases.resolve(provider, _action, payload))
            return cases.resolve(provider, _action, payload)

    for action, event_type in job_actions:
        @router.post(f"/{action}", status_code=202, name=f"{provider}-{action}-submit")
        async def _submit(
            payload: dict,
            request: Request,
            response: Response,
            _action: str = action,
            _event: str = event_type,
        ) -> dict:
            await apply_faults(provider, _action, payload, request)

            def _do() -> dict:
                job = jobs.submit(
                    provider, _action, payload,
                    completer=lambda: cases.resolve(provider, _action, payload),
                    webhook_event=_event,
                )
                response.headers["Location"] = f"/{prefix}/jobs/{job.job_id}"
                return {
                    "job_id": job.job_id,
                    "status": "processing",
                    "status_url": f"/{prefix}/jobs/{job.job_id}",
                }

            if _action in writes:
                return idempotent(provider, request, _do)
            return _do()

    @router.get("/jobs/{job_id}")
    async def _status(job_id: str) -> dict:
        job = jobs.get(job_id)
        if job is None or job.provider != provider:
            raise HTTPException(status_code=404, detail="job not found")
        return jobs.to_dict(job)

    return router
