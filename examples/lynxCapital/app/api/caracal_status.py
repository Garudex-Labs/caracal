"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal status API: principals, tools, mandates, and enforcement history.
"""
from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.api.setup import _query_db, _PRINCIPALS_SQL, _TOOLS_SQL, _MANDATES_SQL
from app.events.bus import bus

router = APIRouter()

_ENFORCE_LIMIT = 40


@router.get("")
def caracal_summary():
    principals = _query_db(_PRINCIPALS_SQL)
    tools      = _query_db(_TOOLS_SQL)
    mandates   = _query_db(_MANDATES_SQL)
    enforcement = _recent_enforcement()
    return JSONResponse({
        "principals": principals,
        "tools":      tools,
        "mandates":   mandates,
        "enforcement": enforcement,
        "counts": {
            "principals": len(principals),
            "tools":      len(tools),
            "mandates":   len(mandates),
        },
    })


@router.get("/enforcement")
def enforcement_history():
    return JSONResponse({"events": _recent_enforcement()})


def _recent_enforcement() -> list[dict]:
    events: list[dict] = []
    for run_id in bus.runs():
        for e in bus.history(run_id):
            if e.kind == "caracal_enforce":
                events.append({
                    "run_id":    run_id,
                    "ts":        e.ts,
                    "tool_id":   e.payload.get("tool_id", ""),
                    "decision":  e.payload.get("decision", ""),
                    "agent_id":  e.payload.get("agent_id", ""),
                    "reason":    e.payload.get("reason", ""),
                })
    events.sort(key=lambda x: x["ts"], reverse=True)
    return events[:_ENFORCE_LIMIT]
