"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Swarm spawner: walks the topology graph and spawns all agents with full lifecycle events.
"""
from __future__ import annotations

import asyncio
from typing import Any

from app.agents import tools as tool_fns
from app.agents.runner import AgentHandle, AgentRunner, create_runner
from app.config import get_config
from app.core.dataset import INVOICES, VENDORS, FX_RATES
from app.events import types as ev
from app.events.bus import bus
from app.orchestration.topology import NodeDef, TopologyGraph, build_topology


# -- fast-path execution per layer --

def _run_invoice_intake(run_id: str, handle: AgentHandle, region: str) -> dict:
    invoices = [inv for inv in INVOICES if inv.region == region]
    batch_size = max(1, len(invoices) // 6)
    results = []
    for inv in invoices[:batch_size]:
        r = tool_fns.extract_invoice(run_id, handle.id, inv.id, f"doc-{inv.id}")
        results.append(r)
    return {"region": region, "processed": len(results)}


def _run_ledger_match(run_id: str, handle: AgentHandle, region: str) -> dict:
    invoices = [inv for inv in INVOICES if inv.region == region]
    batch_size = max(1, len(invoices) // 4)
    matched = 0
    for inv in invoices[:batch_size]:
        vendor = VENDORS.get(inv.vendor_id)
        if vendor:
            tool_fns.netsuite_match_invoice(run_id, handle.id, inv.vendor_id, inv.id, float(inv.amount_usd), inv.currency)
            matched += 1
    return {"region": region, "matched": matched}


def _run_policy_check(run_id: str, handle: AgentHandle, region: str) -> dict:
    vendors_in_region = [v for v in VENDORS.values() if v.region == region]
    checked = 0
    for vendor in vendors_in_region[:5]:
        tool_fns.check_vendor(run_id, handle.id, vendor.id)
        tool_fns.validate_tax_id(run_id, handle.id, vendor.id)
        checked += 1
    return {"region": region, "checked": checked}


def _run_route_optimization(run_id: str, handle: AgentHandle, region: str) -> dict:
    currency = next((inv.currency for inv in INVOICES if inv.region == region), "USD")
    if currency != "USD":
        tool_fns.get_fx_rate(run_id, handle.id, "USD", currency)
    tool_fns.get_withholding_rate(run_id, handle.id, region, currency)
    return {"region": region, "currency": currency}


def _run_payment_execution(run_id: str, handle: AgentHandle, region: str) -> dict:
    invoices = [inv for inv in INVOICES if inv.region == region]
    vendor = VENDORS.get(invoices[0].vendor_id) if invoices else None
    if vendor and invoices:
        inv = invoices[0]
        tool_fns.submit_payment(
            run_id, handle.id, vendor.id,
            float(inv.amount_local), inv.currency,
            vendor.preferred_rails[0].value if vendor.preferred_rails else "WIRE",
            f"ref-{inv.id}",
        )
    return {"region": region, "submitted": 1 if vendor else 0}


def _run_audit(run_id: str, handle: AgentHandle, region: str) -> dict:
    vendors_in_region = [v for v in VENDORS.values() if v.region == region]
    for vendor in vendors_in_region[:2]:
        tool_fns.get_contract_terms(run_id, handle.id, vendor.id)
    bus.publish(ev.audit_record(run_id, handle.id, {"region": region, "status": "recorded"}))
    return {"region": region, "audited": True}


def _run_exception(run_id: str, handle: AgentHandle, region: str) -> dict:
    vendors_in_region = [v for v in VENDORS.values() if v.region == region]
    for vendor in vendors_in_region[:1]:
        tool_fns.check_vendor(run_id, handle.id, vendor.id)
        tool_fns.get_vendor_profile(run_id, handle.id, vendor.id)
    return {"region": region, "investigated": 1}


_LAYER_FNS = {
    "invoice-intake": _run_invoice_intake,
    "ledger-match": _run_ledger_match,
    "policy-check": _run_policy_check,
    "route-optimization": _run_route_optimization,
    "payment-execution": _run_payment_execution,
    "audit": _run_audit,
    "exception": _run_exception,
}


def _execute_node(run_id: str, handle: AgentHandle, node: NodeDef) -> dict:
    fn = _LAYER_FNS.get(node.layer)
    if fn is None:
        return {}
    region = node.region or ""
    return fn(run_id, handle, region)


async def run_swarm(run_id: str, prompt: str) -> None:
    cfg = get_config()
    regions = [r.id for r in cfg.regions]
    layer_cfg = [
        {"id": lc.id, "perRegion": lc.perRegion, "ephemeral": lc.ephemeral}
        for lc in cfg.agentLayers
    ]

    bus.publish(ev.run_start(run_id, prompt))
    topology = build_topology(regions, layer_cfg)
    runner = create_runner(run_id, cfg.swarm.llmBackedCap)

    # Map topology node_id -> AgentHandle for parent resolution
    handles: dict[str, AgentHandle] = {}

    for node in topology.nodes:
        parent_handle = handles.get(node.parent_id) if node.parent_id else None
        handle = runner.spawn(
            role=node.role,
            scope=node.id,
            parent=parent_handle,
            layer=node.layer,
            region=node.region,
        )
        handles[node.id] = handle

    # Execute all non-orchestrator nodes
    ORCHESTRATORS = {"finance-control", "regional-orchestrator"}

    for node in topology.nodes:
        handle = handles[node.id]
        if node.role in ORCHESTRATORS:
            handle.start()
            handle.end()
            handle.terminate("completed")
            continue

        handle.start()
        result = await asyncio.get_event_loop().run_in_executor(
            None, _execute_node, run_id, handle, node
        )
        handle.end(result)
        handle.terminate("completed")

    bus.publish(ev.run_end(run_id, "completed"))
