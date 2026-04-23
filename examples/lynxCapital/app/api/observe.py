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
        # Walk in temporal order. Every tool_call is bracketed by its tool_result;
        # any service_call/service_result that lands between those two markers
        # belongs to that tool. This is robust to built-in tools (write_todos,
        # write_file, read_file, ls_files, dispatch_region) that never talk to
        # an external service.
        i = 0
        n = len(agent_events)
        while i < n:
            e = agent_events[i]
            if e.kind != "tool_call":
                i += 1
                continue
            j = i + 1
            tr_ev = None
            services: list[dict] = []
            pending_sc: dict | None = None
            while j < n and agent_events[j].kind != "tool_call":
                ej = agent_events[j]
                if ej.kind == "tool_result":
                    tr_ev = ej
                    j += 1
                    break
                if ej.kind == "service_call":
                    pending_sc = {
                        "id": ej.payload.get("service_id"),
                        "action": ej.payload.get("action"),
                        "payload": ej.payload.get("payload"),
                        "ts_call": ej.ts,
                        "ts_result": None,
                        "result": None,
                    }
                    services.append(pending_sc)
                elif ej.kind == "service_result" and pending_sc is not None:
                    pending_sc["ts_result"] = ej.ts
                    pending_sc["result"] = ej.payload.get("result")
                    pending_sc = None
                j += 1

            tool_calls_by_agent.setdefault(agent_id, []).append({
                "tool": e.payload.get("tool_name"),
                "args": e.payload.get("args"),
                "ts_call": e.ts,
                "ts_result": tr_ev.ts if tr_ev else None,
                "result": tr_ev.payload.get("result") if tr_ev else None,
                "services": services,
            })
            i = j

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
