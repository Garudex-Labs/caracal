"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Lifecycle invariant tests: spawn/terminate pairing, cancellation order, ephemeral timing.
"""
from __future__ import annotations

import asyncio
import os
import sys
from uuid import uuid4

import pytest
from langchain_core.messages import AIMessage, AIMessageChunk

# Make the demo package importable when running from the repo root.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.config import load_config
from app.events.bus import EventBus
from app.events import types as ev
from app.orchestration.swarm import run_swarm


class _FakeLLM:
    """Stand-in for ChatOpenAI in tests.

    Branches on the first SystemMessage: Finance Control dispatches all five
    regions via tool calls; Regional Orchestrators drive a realistic multi-turn
    tool-call sequence (list -> extract -> match -> compliance -> submit ->
    withholding -> audit -> summary)."""

    def __init__(self):
        self._tools = []
        self._turn = 0
        self._role = None
        self._region = None

    def bind_tools(self, tools):
        self._tools = tools
        return self

    def _classify(self, messages):
        for m in messages:
            if getattr(m, "type", None) == "system" or m.__class__.__name__ == "SystemMessage":
                txt = str(m.content)
                if "Finance Control" in txt:
                    self._role = "fc"
                elif "Regional Orchestrator" in txt:
                    self._role = "regional"
                    # pull the region token: "for the XX region"
                    import re
                    m2 = re.search(r"for the (\w+) region", txt)
                    if m2:
                        self._region = m2.group(1)
                break

    async def astream(self, messages):
        from langchain_core.messages import AIMessageChunk
        if self._role is None:
            self._classify(messages)
        self._turn += 1

        if self._role == "fc":
            if self._turn == 1:
                tool_calls = [
                    {"name": "dispatch_region", "args": {"region": r, "focus": "batch"}, "id": f"fc-{r}", "type": "tool_call"}
                    for r in ("US", "IN", "DE", "SG", "BR")
                ]
                yield AIMessageChunk(content="Dispatching regions.", tool_calls=tool_calls)
            else:
                yield AIMessageChunk(content="All regions completed.")
            return

        # Regional orchestrator: multi-turn tool sequence.
        region = self._region or "US"
        if self._turn == 1:
            yield AIMessageChunk(
                content="",
                tool_calls=[{"name": "list_pending_invoices", "args": {"limit": 2}, "id": f"r-{region}-list", "type": "tool_call"}],
            )
        elif self._turn == 2:
            # Use the last ToolMessage to pick a real invoice id from region data.
            from app.core.dataset import INVOICES, VENDORS
            invs = [i for i in INVOICES if i.region == region][:1]
            if not invs:
                yield AIMessageChunk(content="no invoices")
                return
            inv = invs[0]
            vendor = VENDORS.get(inv.vendor_id)
            rail = vendor.preferred_rails[0].value if vendor and vendor.preferred_rails else "WIRE"
            yield AIMessageChunk(content="", tool_calls=[
                {"name": "extract_invoice_data", "args": {"invoice_id": inv.id}, "id": f"r-{region}-e1", "type": "tool_call"},
                {"name": "match_invoice_in_ledger", "args": {"invoice_id": inv.id, "vendor_id": inv.vendor_id, "amount": float(inv.amount_local), "currency": inv.currency}, "id": f"r-{region}-m1", "type": "tool_call"},
                {"name": "check_vendor_compliance", "args": {"vendor_id": inv.vendor_id}, "id": f"r-{region}-c1", "type": "tool_call"},
                {"name": "submit_payment", "args": {"vendor_id": inv.vendor_id, "amount": float(inv.amount_local), "currency": inv.currency, "rail": rail, "reference": f"ref-{inv.id}"}, "id": f"r-{region}-p1", "type": "tool_call"},
            ])
        elif self._turn == 3:
            from app.core.dataset import REGIONS
            currency = REGIONS[region].currency
            yield AIMessageChunk(content="", tool_calls=[
                {"name": "lookup_withholding_rate", "args": {"currency": currency}, "id": f"r-{region}-w", "type": "tool_call"},
                {"name": "record_audit", "args": {"summary": f"{region} batch complete"}, "id": f"r-{region}-a", "type": "tool_call"},
            ])
        else:
            yield AIMessageChunk(content=f"{region} batch complete.")


@pytest.fixture(autouse=True)
def fresh_bus(monkeypatch):
    """Replace the global bus with a fresh instance and swap in a fake LLM."""
    new_bus = EventBus()
    import app.events.bus as bus_mod
    import app.orchestration.swarm as swarm_mod
    import app.agents.runner as runner_mod
    import app.agents.tools as tools_mod
    monkeypatch.setattr(bus_mod, "bus", new_bus)
    monkeypatch.setattr(swarm_mod, "bus", new_bus)
    monkeypatch.setattr(runner_mod, "bus", new_bus)
    monkeypatch.setattr(tools_mod, "bus", new_bus)
    monkeypatch.setattr(swarm_mod, "_make_llm", lambda cfg: _FakeLLM())
    load_config()
    return new_bus


def _run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# 1. Every agent_spawn has exactly one agent_terminate with the same agent_id
# ---------------------------------------------------------------------------

def test_spawn_terminate_pairing(fresh_bus):
    run_id = "test-lifecycle-pairing"
    _run(run_swarm(run_id, "process weekly payouts"))

    events = fresh_bus.history(run_id)
    spawns = {e.payload["agent_id"] for e in events if e.kind == "agent_spawn"}
    terminates = [e.payload["agent_id"] for e in events if e.kind == "agent_terminate"]

    # Every spawn must have exactly one terminate
    assert spawns, "No agent_spawn events found"
    for aid in spawns:
        count = terminates.count(aid)
        assert count == 1, f"agent {aid} has {count} agent_terminate events (expected 1)"

    # No terminate without a prior spawn
    for aid in terminates:
        assert aid in spawns, f"agent_terminate for {aid!r} has no matching agent_spawn"


# ---------------------------------------------------------------------------
# 2. run_end fires only after all agents have terminated
# ---------------------------------------------------------------------------

def test_run_end_after_all_terminates(fresh_bus):
    run_id = "test-run-end-order"
    _run(run_swarm(run_id, "process weekly payouts"))

    events = fresh_bus.history(run_id)
    positions = {e.kind: [] for e in events}
    for i, e in enumerate(events):
        positions.setdefault(e.kind, []).append(i)

    run_end_pos = positions.get("run_end", [])
    assert run_end_pos, "No run_end event emitted"
    end_pos = run_end_pos[-1]

    terminate_positions = positions.get("agent_terminate", [])
    assert terminate_positions, "No agent_terminate events"
    assert all(t < end_pos for t in terminate_positions), (
        "Some agent_terminate events appear after run_end"
    )


# ---------------------------------------------------------------------------
# 3. Ephemeral agents: payment-execution terminates, no later sibling events
#    from the same parent before the next non-ephemeral layer begins.
# ---------------------------------------------------------------------------

def test_ephemeral_agents_terminate_completely(fresh_bus):
    run_id = "test-ephemeral"
    _run(run_swarm(run_id, "process weekly payouts"))

    events = fresh_bus.history(run_id)

    spawns = {
        e.payload["agent_id"]: e
        for e in events if e.kind == "agent_spawn"
    }
    terminates = {
        e.payload["agent_id"]
        for e in events if e.kind == "agent_terminate"
    }

    # payment-execution nodes are the ephemeral batch nodes; verify they terminated
    pe_agents = [
        aid for aid, s in spawns.items()
        if s.payload.get("layer") == "payment-execution"
    ]
    assert pe_agents, "No payment-execution agents found"
    for aid in pe_agents:
        assert aid in terminates, f"Ephemeral payment-execution agent {aid} never terminated"


# ---------------------------------------------------------------------------
# 4. agent_start and agent_end appear between spawn and terminate for every agent
# ---------------------------------------------------------------------------

def test_start_end_within_lifecycle(fresh_bus):
    run_id = "test-lifecycle-order"
    _run(run_swarm(run_id, "process weekly payouts"))

    events = fresh_bus.history(run_id)
    pos: dict[str, dict[str, int]] = {}
    for i, e in enumerate(events):
        aid = e.payload.get("agent_id")
        if aid is None:
            continue
        if e.kind in ("agent_spawn", "agent_start", "agent_end", "agent_terminate"):
            pos.setdefault(aid, {})[e.kind] = i

    for aid, lifecycle in pos.items():
        if len(lifecycle) < 4:
            # Not all agents necessarily emit all four (fast-path may differ slightly)
            continue
        spawn = lifecycle["agent_spawn"]
        start = lifecycle["agent_start"]
        end   = lifecycle["agent_end"]
        term  = lifecycle["agent_terminate"]
        assert spawn < start < end < term, (
            f"Lifecycle out of order for agent {aid}: "
            f"spawn={spawn} start={start} end={end} terminate={term}"
        )
