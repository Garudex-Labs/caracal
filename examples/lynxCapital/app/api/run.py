"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Run lifecycle endpoints: start, SSE event stream, status, cancel, and approvals.
"""

from __future__ import annotations

from uuid import uuid4

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from app.core.approvals import approvals
from app.core.cancellation import cancellation
from app.events.bus import bus
from app.events.sse import run_stream
from app.orchestration.swarm import run_swarm

router = APIRouter()


class StartRequest(BaseModel):
    prompt: str


class StartResponse(BaseModel):
    runId: str


class ApprovalDecision(BaseModel):
    requestId: str
    approved: bool
    note: str = ""


@router.post("/start")
async def start(body: StartRequest, background: BackgroundTasks) -> StartResponse:
    run_id = str(uuid4())
    background.add_task(run_swarm, run_id, body.prompt)
    return StartResponse(runId=run_id)


@router.get("/{run_id}/events")
async def events(run_id: str):
    return EventSourceResponse(run_stream(run_id))


@router.get("/{run_id}/status")
def status(run_id: str) -> dict:
    """Lightweight run status for UI reattachment on page refresh."""
    history = bus.history(run_id)
    if not history:
        raise HTTPException(status_code=404, detail="Run not found")
    ended = next((e for e in history if e.kind == "run_end"), None)
    started = next((e for e in history if e.kind == "run_start"), None)
    return {
        "runId": run_id,
        "exists": True,
        "active": ended is None,
        "status": (ended.payload.get("status") if ended else "running"),
        "events": len(history),
        "started_at": started.ts if started else None,
        "ended_at": ended.ts if ended else None,
    }


@router.post("/{run_id}/cancel")
def cancel(run_id: str) -> dict:
    """Cooperatively cancel an in-flight run. The swarm checks the cancellation
    token between turns and stops gracefully; in-flight LLM and tool calls
    complete first so chat history stays consistent."""
    ok = cancellation.cancel(run_id)
    return {"runId": run_id, "cancelled": ok}


@router.post("/{run_id}/approve")
async def approve(run_id: str, body: ApprovalDecision) -> dict:
    """Resolve a pending human-in-the-loop approval request. Runs on the event
    loop so the waiter's asyncio.Event is set from its own thread."""
    ok = approvals.resolve(run_id, body.requestId, body.approved, body.note)
    if not ok:
        raise HTTPException(
            status_code=404, detail="Unknown or already-resolved approval request"
        )
    return {"runId": run_id, "requestId": body.requestId, "approved": body.approved}
