"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Run lifecycle endpoints: start, SSE event stream, lineage, and graph.
"""
from __future__ import annotations

import asyncio
from uuid import uuid4

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from app.agents.runner import get_runner
from app.events.bus import bus
from app.events.sse import run_stream
from app.orchestration.swarm import run_swarm

router = APIRouter()


class StartRequest(BaseModel):
    prompt: str


class StartResponse(BaseModel):
    runId: str


@router.post("/start")
async def start(body: StartRequest, background: BackgroundTasks) -> StartResponse:
    run_id = str(uuid4())
    background.add_task(run_swarm, run_id, body.prompt)
    return StartResponse(runId=run_id)


@router.get("/{run_id}/events")
async def events(run_id: str):
    return EventSourceResponse(run_stream(run_id))


@router.get("/{run_id}/lineage")
def lineage(run_id: str) -> dict:
    history = bus.history(run_id)
    if not history:
        raise HTTPException(status_code=404, detail="Run not found")

    spawns = {e.payload["agent_id"]: e for e in history if e.kind == "agent_spawn"}
    terminates = {e.payload["agent_id"]: e for e in history if e.kind == "agent_terminate"}
    starts = {e.payload["agent_id"]: e for e in history if e.kind == "agent_start"}

    nodes = []
    for agent_id, spawn_ev in spawns.items():
        term_ev = terminates.get(agent_id)
        start_ev = starts.get(agent_id)
        status = "spawned"
        if start_ev and not term_ev:
            status = "running"
        elif term_ev:
            status = term_ev.payload.get("status", "completed")

        nodes.append({
            "id": agent_id,
            "role": spawn_ev.payload.get("role"),
            "layer": spawn_ev.payload.get("layer"),
            "region": spawn_ev.payload.get("region"),
            "parent": spawn_ev.payload.get("parent_id"),
            "status": status,
            "ts_spawn": spawn_ev.ts,
            "ts_terminate": term_ev.ts if term_ev else None,
        })

    return {"runId": run_id, "nodes": nodes}


@router.get("/{run_id}/graph")
def graph(run_id: str) -> dict:
    history = bus.history(run_id)
    if not history:
        raise HTTPException(status_code=404, detail="Run not found")

    spawns = {e.payload["agent_id"]: e for e in history if e.kind == "agent_spawn"}
    terminates = {e.payload["agent_id"]: e for e in history if e.kind == "agent_terminate"}
    starts = {e.payload["agent_id"]: e for e in history if e.kind == "agent_start"}
    delegations = [e for e in history if e.kind == "delegation"]

    nodes = []
    for agent_id, spawn_ev in spawns.items():
        term_ev = terminates.get(agent_id)
        start_ev = starts.get(agent_id)
        status = "spawned"
        if start_ev and not term_ev:
            status = "running"
        elif term_ev:
            status = term_ev.payload.get("status", "completed")

        nodes.append({
            "id": agent_id,
            "role": spawn_ev.payload.get("role"),
            "layer": spawn_ev.payload.get("layer"),
            "region": spawn_ev.payload.get("region"),
            "parent": spawn_ev.payload.get("parent_id"),
            "status": status,
        })

    edges = []
    for spawn_ev in spawns.values():
        parent = spawn_ev.payload.get("parent_id")
        if parent:
            edges.append({
                "from": parent,
                "to": spawn_ev.payload["agent_id"],
                "kind": "spawn",
            })
    for d in delegations:
        edges.append({
            "from": d.payload["parent_id"],
            "to": d.payload["child_id"],
            "kind": "delegation",
        })

    return {"runId": run_id, "nodes": nodes, "edges": edges}
