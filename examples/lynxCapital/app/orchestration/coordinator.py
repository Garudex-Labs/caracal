"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

LangGraph StateGraph coordinator driving the layer-by-layer swarm flow.
"""
from __future__ import annotations

import asyncio
from typing import TypedDict

from langgraph.graph import END, StateGraph

from app.config import get_config
from app.core.dataset import INVOICES, VENDORS
from app.events import types as ev
from app.events.bus import bus
from app.agents.runner import get_runner, AgentHandle
from app.agents import tools as tool_fns
from app.orchestration.topology import build_topology, TopologyGraph


class SwarmState(TypedDict):
    run_id: str
    prompt: str
    topology: TopologyGraph | None
    handles: dict[str, str]  # topology node_id -> agent handle id
    layer_results: dict[str, list[dict]]
    status: str


def _node_init(state: SwarmState) -> SwarmState:
    cfg = get_config()
    regions = [r.id for r in cfg.regions]
    layer_cfg = [
        {"id": lc.id, "perRegion": lc.perRegion, "ephemeral": lc.ephemeral}
        for lc in cfg.agentLayers
    ]
    topology = build_topology(regions, layer_cfg)
    return {**state, "topology": topology, "handles": {}, "layer_results": {}}


def _node_spawn_all(state: SwarmState) -> SwarmState:
    run_id = state["run_id"]
    topology = state["topology"]
    runner = get_runner(run_id)
    if runner is None:
        return {**state, "status": "error"}

    handle_map: dict[str, AgentHandle] = {}
    for node in topology.nodes:
        parent_handle = handle_map.get(node.parent_id) if node.parent_id else None
        h = runner.spawn(
            role=node.role,
            scope=node.id,
            parent=parent_handle,
            layer=node.layer,
            region=node.region,
        )
        handle_map[node.id] = h

    return {**state, "handles": {nid: h.id for nid, h in handle_map.items()}, "_handles": handle_map}


def _run_worker_layer(state: SwarmState, layer_id: str) -> SwarmState:
    run_id = state["run_id"]
    topology = state["topology"]
    handle_map: dict[str, AgentHandle] = state.get("_handles", {})
    runner = get_runner(run_id)
    results = []

    from app.orchestration.swarm import _execute_node, ORCHESTRATORS
    for node in topology.by_layer(layer_id):
        handle = handle_map.get(node.id)
        if handle is None:
            continue
        handle.start()
        result = _execute_node(run_id, handle, node)
        handle.end(result)
        handle.terminate("completed")
        results.append(result)

    updated = dict(state["layer_results"])
    updated[layer_id] = results
    return {**state, "layer_results": updated}


def _node_orchestrators(state: SwarmState) -> SwarmState:
    run_id = state["run_id"]
    topology = state["topology"]
    handle_map: dict[str, AgentHandle] = state.get("_handles", {})

    from app.orchestration.swarm import ORCHESTRATORS
    for node in topology.nodes:
        if node.role in ORCHESTRATORS:
            h = handle_map.get(node.id)
            if h:
                h.start()
                h.end()
                h.terminate("completed")

    return state


def _node_intake(state: SwarmState) -> SwarmState:
    return _run_worker_layer(state, "invoice-intake")


def _node_ledger(state: SwarmState) -> SwarmState:
    return _run_worker_layer(state, "ledger-match")


def _node_policy(state: SwarmState) -> SwarmState:
    return _run_worker_layer(state, "policy-check")


def _node_route(state: SwarmState) -> SwarmState:
    return _run_worker_layer(state, "route-optimization")


def _node_payment(state: SwarmState) -> SwarmState:
    return _run_worker_layer(state, "payment-execution")


def _node_audit(state: SwarmState) -> SwarmState:
    return _run_worker_layer(state, "audit")


def _node_exception(state: SwarmState) -> SwarmState:
    return _run_worker_layer(state, "exception")


def _node_finalize(state: SwarmState) -> SwarmState:
    bus.publish(ev.run_end(state["run_id"], "completed"))
    return {**state, "status": "completed"}


def build_coordinator() -> StateGraph:
    graph = StateGraph(SwarmState)

    graph.add_node("init", _node_init)
    graph.add_node("spawn_all", _node_spawn_all)
    graph.add_node("orchestrators", _node_orchestrators)
    graph.add_node("intake", _node_intake)
    graph.add_node("ledger", _node_ledger)
    graph.add_node("policy", _node_policy)
    graph.add_node("route", _node_route)
    graph.add_node("payment", _node_payment)
    graph.add_node("audit", _node_audit)
    graph.add_node("exception", _node_exception)
    graph.add_node("finalize", _node_finalize)

    graph.set_entry_point("init")
    graph.add_edge("init", "spawn_all")
    graph.add_edge("spawn_all", "orchestrators")
    graph.add_edge("orchestrators", "intake")
    graph.add_edge("intake", "ledger")
    graph.add_edge("ledger", "policy")
    graph.add_edge("policy", "route")
    graph.add_edge("route", "payment")
    graph.add_edge("payment", "audit")
    graph.add_edge("audit", "exception")
    graph.add_edge("exception", "finalize")
    graph.add_edge("finalize", END)

    return graph.compile()
