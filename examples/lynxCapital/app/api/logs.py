"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Log query and SSE stream endpoints for categorized event logs.
"""
from __future__ import annotations

from fastapi import APIRouter
from sse_starlette.sse import EventSourceResponse

from app.events.bus import bus
from app.events.sse import log_stream

router = APIRouter()


@router.get("/recent")
def recent(runId: str | None = None, category: str | None = None) -> dict:
    if runId:
        events = bus.history(runId)
    else:
        events = [e for rid in bus.runs() for e in bus.history(rid)]

    if category:
        events = [e for e in events if e.category == category]

    return {
        "events": [e.model_dump() for e in events[-200:]],
        "total": len(events),
    }


@router.get("/stream")
async def stream(runId: str | None = None, category: str | None = None):
    return EventSourceResponse(log_stream(runId, category))
