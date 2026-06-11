"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Background job registry that lets orchestrators dispatch work non-blocking and join later.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Awaitable
from uuid import uuid4


@dataclass
class JobInfo:
    job_id: str
    kind: str
    target: str
    depth: int
    task: asyncio.Task


MAX_DEPTH = 2


class JobRegistry:
    """Per-run registry of background orchestrator coroutines. Tracks tasks,
    enforces depth so nested dispatch trees can't run away, and offers an
    explicit join point for orchestrators."""

    def __init__(self, run_id: str) -> None:
        self.run_id = run_id
        self._jobs: dict[str, JobInfo] = {}

    def start(self, coro: Awaitable, *, kind: str, target: str, depth: int = 0) -> str:
        if depth >= MAX_DEPTH:
            raise RuntimeError(f"job depth limit reached at {depth}")
        job_id = f"job-{uuid4().hex[:10]}"
        task = asyncio.create_task(coro, name=f"{kind}:{target}:{job_id}")
        self._jobs[job_id] = JobInfo(job_id=job_id, kind=kind, target=target, depth=depth, task=task)
        return job_id

    def info(self, job_id: str) -> JobInfo | None:
        return self._jobs.get(job_id)

    async def await_many(self, job_ids: list[str], timeout_s: float) -> list[dict]:
        wanted = [self._jobs[jid] for jid in job_ids if jid in self._jobs]
        if not wanted:
            return []
        done, pending = await asyncio.wait(
            [w.task for w in wanted], timeout=timeout_s, return_when=asyncio.ALL_COMPLETED,
        )
        results: list[dict] = []
        for w in wanted:
            if w.task in done:
                try:
                    res = w.task.result()
                    results.append({
                        "job_id": w.job_id, "kind": w.kind, "target": w.target,
                        "status": "completed", "result": res,
                    })
                except Exception as exc:
                    results.append({
                        "job_id": w.job_id, "kind": w.kind, "target": w.target,
                        "status": "failed", "error": str(exc),
                    })
            else:
                results.append({
                    "job_id": w.job_id, "kind": w.kind, "target": w.target,
                    "status": "pending",
                })
        return results

    async def drain(self, timeout_s: float) -> list[dict]:
        outstanding = [j for j in self._jobs.values() if not j.task.done()]
        if not outstanding:
            return []
        return await self.await_many([j.job_id for j in outstanding], timeout_s)

    async def cancel_pending(self) -> int:
        """Cancel every job still running and wait for the tasks to settle. The run's
        cancel flag is cleared at run end, so any job left alive past its drain
        window would otherwise run ungoverned forever."""
        outstanding = [j.task for j in self._jobs.values() if not j.task.done()]
        for task in outstanding:
            task.cancel()
        if outstanding:
            await asyncio.gather(*outstanding, return_exceptions=True)
        return len(outstanding)

    def all_jobs(self) -> list[JobInfo]:
        return list(self._jobs.values())
