"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Per-run observability endpoint: agent spans with nested tool and service calls.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.events.bus import bus

router = APIRouter()


@router.get("/{run_id}")
def observe(run_id: str) -> dict:
    history = bus.history(run_id)
    if not history:
        raise HTTPException(status_code=404, detail="Run not found")

    spawns = {e.payload["agent_id"]: e for e in history if e.kind == "agent_spawn"}
    terminates = {e.payload["agent_id"]: e for e in history if e.kind == "agent_terminate"}
    starts = {e.payload["agent_id"]: e for e in history if e.kind == "agent_start"}
    ends = {e.payload["agent_id"]: e for e in history if e.kind == "agent_end"}

    # Group events by agent_id in document order so tool/service calls can be paired by position.
    events_by_agent: dict[str, list] = {}
    for e in history:
        aid = e.payload.get("agent_id")
        if aid:
            events_by_agent.setdefault(aid, []).append(e)

    tool_calls_by_agent: dict[str, list] = {}
    for agent_id, agent_events in events_by_agent.items():
        tc_list = [e for e in agent_events if e.kind == "tool_call"]
        tr_list = [e for e in agent_events if e.kind == "tool_result"]
        sc_list = [e for e in agent_events if e.kind == "service_call"]
        sr_list = [e for e in agent_events if e.kind == "service_result"]

        for i, tc_ev in enumerate(tc_list):
            tr_ev = tr_list[i] if i < len(tr_list) else None
            sc_ev = sc_list[i] if i < len(sc_list) else None
            sr_ev = sr_list[i] if i < len(sr_list) else None

            entry = {
                "tool": tc_ev.payload.get("tool_name"),
                "args": tc_ev.payload.get("args"),
                "ts_call": tc_ev.ts,
                "ts_result": tr_ev.ts if tr_ev else None,
                "result": tr_ev.payload.get("result") if tr_ev else None,
                "service": {
                    "id": sc_ev.payload.get("service_id"),
                    "action": sc_ev.payload.get("action"),
                    "ts_call": sc_ev.ts,
                    "ts_result": sr_ev.ts if sr_ev else None,
                    "result": sr_ev.payload.get("result") if sr_ev else None,
                } if sc_ev else None,
            }
            tool_calls_by_agent.setdefault(agent_id, []).append(entry)

    spans = []
    for agent_id, spawn_ev in spawns.items():
        term_ev = terminates.get(agent_id)
        start_ev = starts.get(agent_id)
        end_ev = ends.get(agent_id)

        status = "spawned"
        if start_ev and not term_ev:
            status = "running"
        elif term_ev:
            status = term_ev.payload.get("status", "completed")

        spans.append({
            "id": agent_id,
            "role": spawn_ev.payload.get("role"),
            "layer": spawn_ev.payload.get("layer"),
            "region": spawn_ev.payload.get("region"),
            "scope": spawn_ev.payload.get("scope"),
            "parent": spawn_ev.payload.get("parent_id"),
            "status": status,
            "ts_spawn": spawn_ev.ts,
            "ts_start": start_ev.ts if start_ev else None,
            "ts_end": end_ev.ts if end_ev else None,
            "ts_terminate": term_ev.ts if term_ev else None,
            "tool_calls": tool_calls_by_agent.get(agent_id, []),
        })

    run_end = next((e for e in reversed(history) if e.kind == "run_end"), None)
    run_start = next((e for e in history if e.kind == "run_start"), None)

    return {
        "runId": run_id,
        "status": run_end.payload.get("status") if run_end else "running",
        "ts_start": run_start.ts if run_start else None,
        "ts_end": run_end.ts if run_end else None,
        "spans": spans,
    }
