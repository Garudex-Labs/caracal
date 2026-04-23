"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Enforcement tests: Caracal deny propagation through _enforce and the run lifecycle.
"""
from __future__ import annotations

import asyncio
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("OPENAI_API_KEY", "test-key")

from caracal_sdk.adapters.base import BaseAdapter, SDKRequest, SDKResponse
from caracal_sdk.context import ScopeContext
from caracal_sdk.hooks import HookRegistry

from app.events.bus import EventBus
import app.events.bus as bus_mod
import app.agents.tools as tools_mod
import app.agents.runner as runner_mod


class _DenyAdapter(BaseAdapter):
    """Transport adapter that always raises PermissionError."""

    async def send(self, request: SDKRequest) -> SDKResponse:
        raise PermissionError("policy denied by mock")

    def close(self) -> None:
        pass

    @property
    def is_connected(self) -> bool:
        return True


def _make_deny_scope() -> ScopeContext:
    return ScopeContext(adapter=_DenyAdapter(), hooks=HookRegistry(), workspace_id="test-ws")


@pytest.fixture()
def isolated_bus(monkeypatch):
    """Fresh event bus + enforcement state reset per test."""
    new_bus = EventBus()
    monkeypatch.setattr(bus_mod, "bus", new_bus)
    monkeypatch.setattr(tools_mod, "bus", new_bus)
    monkeypatch.setattr(runner_mod, "bus", new_bus)
    # Reset enforcement state so tests are isolated.
    monkeypatch.setattr(tools_mod, "_enforcement_scope", None)
    monkeypatch.setattr(tools_mod, "_event_loop", None)
    return new_bus


@pytest.fixture()
def deny_scope():
    """ScopeContext backed by DenyAdapter, with background event loop."""
    loop = asyncio.new_event_loop()
    thr = threading.Thread(target=loop.run_forever, daemon=True)
    thr.start()
    scope = _make_deny_scope()
    yield scope, loop
    loop.call_soon_threadsafe(loop.stop)
    thr.join(timeout=2)


# ---------------------------------------------------------------------------
# 1. _enforce raises PermissionError and publishes deny event
# ---------------------------------------------------------------------------

def test_enforce_deny_raises(isolated_bus, deny_scope, monkeypatch):
    """_enforce() raises PermissionError when Caracal denies the tool call."""
    scope, loop = deny_scope
    tools_mod.init_enforcement(scope=scope, loop=loop)

    with pytest.raises(PermissionError, match="Caracal denied"):
        tools_mod._enforce(
            run_id="run-deny-1",
            agent_id="agent-pe-1",
            service_id="mercury-bank",
            action="submit_payment",
            args={"amount": 5000, "currency": "USD"},
        )


def test_enforce_deny_event(isolated_bus, deny_scope, monkeypatch):
    """_enforce() publishes a caracal_enforce event with decision=deny."""
    scope, loop = deny_scope
    tools_mod.init_enforcement(scope=scope, loop=loop)

    try:
        tools_mod._enforce(
            run_id="run-deny-2",
            agent_id="agent-pe-2",
            service_id="mercury-bank",
            action="submit_payment",
            args={"amount": 5000, "currency": "USD"},
        )
    except PermissionError:
        pass

    events = isolated_bus.history("run-deny-2")
    enforce_events = [e for e in events if e.kind == "caracal_enforce"]
    assert enforce_events, "Expected at least one caracal_enforce event"
    ev = enforce_events[0]
    assert ev.payload["decision"] == "deny"
    assert "mercury-bank" in ev.payload["tool_id"]
    assert "submit_payment" in ev.payload["tool_id"]


# ---------------------------------------------------------------------------
# 2. No enforcement when scope is None (bypass for test isolation)
# ---------------------------------------------------------------------------

def test_enforce_noop_when_no_scope(isolated_bus):
    """_enforce() is a no-op when no enforcement scope is configured."""
    # scope is None by default in isolated_bus fixture
    tools_mod._enforce(
        run_id="run-noop-1",
        agent_id="agent-noop-1",
        service_id="mercury-bank",
        action="submit_payment",
        args={"amount": 100},
    )
    events = isolated_bus.history("run-noop-1")
    enforce_events = [e for e in events if e.kind == "caracal_enforce"]
    assert enforce_events == [], "Expected no enforce events when scope is None"


# ---------------------------------------------------------------------------
# 3. run_swarm ends with status=denied on PermissionError
# ---------------------------------------------------------------------------

def test_run_ends_denied_on_permission_error(isolated_bus, deny_scope, monkeypatch):
    """run_swarm publishes run_end with status=denied when enforcement denies a call."""
    from langchain_core.messages import AIMessageChunk
    from app.config import load_config
    from app.orchestration import swarm as swarm_mod

    monkeypatch.setattr(swarm_mod, "bus", isolated_bus)

    scope, loop = deny_scope
    tools_mod.init_enforcement(scope=scope, loop=loop)
    monkeypatch.setattr(tools_mod, "_enforcement_scope", scope)
    monkeypatch.setattr(tools_mod, "_event_loop", loop)

    class _FakeLLMDenyPath:
        """LLM that immediately calls submit_payment to trigger enforcement deny."""

        def __init__(self):
            self._tools = []
            self._turn = 0

        def bind_tools(self, tools):
            self._tools = tools
            return self

        async def astream(self, messages):
            self._turn += 1
            for m in messages:
                txt = str(getattr(m, "content", ""))
                if "Finance Control" in txt:
                    if self._turn == 1:
                        yield AIMessageChunk(content="Dispatching US.", tool_calls=[
                            {"name": "dispatch_region", "args": {"region": "US", "focus": "batch"},
                             "id": "fc-us", "type": "tool_call"},
                        ])
                    else:
                        yield AIMessageChunk(content="Done.")
                    return
                if "Regional Orchestrator" in txt or "regional" in txt.lower():
                    if self._turn == 1:
                        yield AIMessageChunk(content="Paying.", tool_calls=[
                            {"name": "submit_payment",
                             "args": {"vendor_id": "us-logix-ll", "amount": 100.0,
                                      "currency": "USD", "rail": "ACH", "reference": "INV-001"},
                             "id": "ro-pay", "type": "tool_call"},
                        ])
                    else:
                        yield AIMessageChunk(content="Done.")
                    return
                yield AIMessageChunk(content="Done.")
                return

    monkeypatch.setattr(swarm_mod, "_make_llm", lambda model, temperature=0.1: _FakeLLMDenyPath())
    load_config()

    asyncio.run(swarm_mod.run_swarm("run-deny-swarm", "process payouts"))

    events = isolated_bus.history("run-deny-swarm")
    run_end = next((e for e in events if e.kind == "run_end"), None)
    assert run_end is not None, "Expected run_end event"
    assert run_end.payload.get("status") == "denied", (
        f"Expected status=denied, got {run_end.payload.get('status')!r}"
    )
