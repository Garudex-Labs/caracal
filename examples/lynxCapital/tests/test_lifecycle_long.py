"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for long-horizon primitives: WorkerPool, JobRegistry, stage budget, and stage event flow.
"""

from __future__ import annotations

import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("OPENAI_API_KEY", "test-key")

from langchain_core.messages import AIMessageChunk, SystemMessage

import app.agents.runner as runner_mod
import app.core.workers as workers_mod
import app.events.bus as bus_mod
import app.orchestration.swarm as swarm_mod
from app.config import load_config
from app.core.blackboard import RunBlackboard
from app.core.files import RunFileStore
from app.core.jobs import JobRegistry
from app.core.memory import RunMemoryStore
from app.core.plans import RunPlanStore


@pytest.fixture(autouse=True)
def fresh_bus(monkeypatch):
    new_bus = bus_mod.EventBus()
    monkeypatch.setattr(bus_mod, "bus", new_bus)
    monkeypatch.setattr(runner_mod, "bus", new_bus)
    monkeypatch.setattr(swarm_mod, "bus", new_bus)
    monkeypatch.setattr(workers_mod, "bus", new_bus)
    load_config()
    return new_bus


def test_worker_pool_acquire_release(fresh_bus):
    run_id = "wp-1"
    runner = runner_mod.create_runner(run_id)
    parent = runner.spawn(
        role="finance-control",
        scope="global",
        parent=None,
        layer="finance-control",
        region=None,
    )
    parent.start()
    pool = workers_mod.WorkerPool(run_id, runner, parent)

    w = pool.acquire("invoice-intake", "scope-1")
    assert w.id in pool.active_ids()
    ok = pool.release(w.id, {"summary": "done"})
    assert ok
    assert w.id not in pool.active_ids()

    kinds = [e.kind for e in fresh_bus.history(run_id)]
    assert "worker_acquire" in kinds
    assert "worker_release" in kinds
    assert "agent_terminate" in kinds


def test_worker_pool_drain_terminates_active(fresh_bus):
    run_id = "wp-2"
    runner = runner_mod.create_runner(run_id)
    parent = runner.spawn(
        role="finance-control",
        scope="global",
        parent=None,
        layer="finance-control",
        region=None,
    )
    parent.start()
    pool = workers_mod.WorkerPool(run_id, runner, parent)
    w = pool.acquire("policy-check", "scope-2")
    pool.drain("cancelled")
    assert pool.active_ids() == []
    terms = [
        e
        for e in fresh_bus.history(run_id)
        if e.kind == "agent_terminate" and e.payload.get("agent_id") == w.id
    ]
    assert len(terms) == 1


def test_job_registry_await_returns_in_order(fresh_bus):
    async def run():
        reg = JobRegistry("jr-1")

        async def make(value, delay):
            await asyncio.sleep(delay)
            return {"v": value}

        ids = [
            reg.start(make("a", 0.02), kind="region", target="A"),
            reg.start(make("b", 0.01), kind="region", target="B"),
            reg.start(make("c", 0.03), kind="region", target="C"),
        ]
        results = await reg.await_many(ids, timeout_s=1.0)
        assert [r["target"] for r in results] == ["A", "B", "C"]
        assert all(r["status"] == "completed" for r in results)
        assert results[1]["result"] == {"v": "b"}

    asyncio.run(run())


def test_job_registry_timeout_returns_pending(fresh_bus):
    async def run():
        reg = JobRegistry("jr-2")

        async def slow():
            await asyncio.sleep(5.0)
            return {"v": 1}

        jid = reg.start(slow(), kind="region", target="X")
        results = await reg.await_many([jid], timeout_s=0.05)
        assert results[0]["status"] == "pending"
        await reg.drain(timeout_s=0.0)

    asyncio.run(run())


class _StageFakeLLM:
    """Fake LLM that simulates an orchestrator declaring and completing one
    stage, then exiting cleanly."""

    def __init__(self):
        self._turn = 0

    def bind_tools(self, tools):
        self._tools = tools
        return self

    async def astream(self, messages):
        self._turn += 1
        if self._turn == 1:
            yield AIMessageChunk(
                content="",
                tool_calls=[
                    {
                        "name": "start_stage",
                        "args": {"name": "extract", "intent": "pull pending invoices"},
                        "id": "s1",
                        "type": "tool_call",
                    }
                ],
            )
        elif self._turn == 2:
            yield AIMessageChunk(
                content="",
                tool_calls=[
                    {
                        "name": "complete_stage",
                        "args": {"name": "extract", "summary": "two invoices ready"},
                        "id": "s2",
                        "type": "tool_call",
                    }
                ],
            )
        else:
            yield AIMessageChunk(content="done")


def test_stage_complete_writes_finding_and_exits_loop(fresh_bus):
    run_id = "stage-1"
    runner = runner_mod.create_runner(run_id)
    agent = runner.spawn(
        role="regional-orchestrator",
        scope="region:US",
        parent=None,
        layer="regional-orchestrator",
        region="US",
    )
    agent.start()

    plans = RunPlanStore(run_id)
    files = RunFileStore(run_id=run_id)
    board = RunBlackboard(run_id)
    pool = workers_mod.WorkerPool(run_id, runner, agent)
    state = {"current": None}

    tools = swarm_mod._build_agent_builtins(
        run_id,
        agent.id,
        plans,
        files,
        board,
        region="US",
        stage_state=state,
        worker_pool=pool,
    )
    tool_map = {t.name: t for t in tools}

    fake = _StageFakeLLM().bind_tools(tools)
    summarizer = _StageFakeLLM()
    mem = RunMemoryStore(run_id, "gpt-5.4-nano").open(
        agent_id=agent.id,
        system=SystemMessage(content="test"),
    )

    async def run():
        return await swarm_mod._drive_stages(
            run_id=run_id,
            agent=agent,
            model_name="gpt-5.4-nano",
            llm_with_tools=fake,
            summarizer=summarizer,
            mem=mem,
            tool_map=tool_map,
            stage_budget=4,
            total_budget=20,
        )

    asyncio.run(run())

    kinds = [e.kind for e in fresh_bus.history(run_id)]
    assert "stage_start" in kinds
    assert "stage_end" in kinds
    findings = board.read(kind="stage")
    assert any("extract" in f.content for f in findings)


class _RunawayFakeLLM:
    """Always emits one tool call so a stage budget cap is exercised."""

    def bind_tools(self, tools):
        return self

    async def astream(self, messages):
        yield AIMessageChunk(
            content="",
            tool_calls=[
                {
                    "name": "post_finding",
                    "args": {"kind": "noise", "content": "x"},
                    "id": "n",
                    "type": "tool_call",
                }
            ],
        )


def test_turn_loop_honors_stage_budget(fresh_bus):
    run_id = "stage-budget"
    runner = runner_mod.create_runner(run_id)
    agent = runner.spawn(
        role="regional-orchestrator",
        scope="region:US",
        parent=None,
        layer="regional-orchestrator",
        region="US",
    )
    agent.start()

    plans = RunPlanStore(run_id)
    files = RunFileStore(run_id=run_id)
    board = RunBlackboard(run_id)
    state = {"current": None}

    tools = swarm_mod._build_agent_builtins(
        run_id,
        agent.id,
        plans,
        files,
        board,
        region="US",
        stage_state=state,
    )
    tool_map = {t.name: t for t in tools}

    fake = _RunawayFakeLLM()
    summarizer = _RunawayFakeLLM()
    mem = RunMemoryStore(run_id, "gpt-5.4-nano").open(
        agent_id=agent.id,
        system=SystemMessage(content="test"),
    )

    loop_state = {
        "total_used": 0,
        "tool_calls": 0,
        "stage_done": False,
        "current": None,
        "total_budget": 100,
    }

    async def run():
        return await swarm_mod._turn_loop(
            run_id=run_id,
            agent=agent,
            model_name="gpt-5.4-nano",
            llm_with_tools=fake,
            summarizer=summarizer,
            mem=mem,
            tool_map=tool_map,
            stage_budget=3,
            state=loop_state,
        )

    asyncio.run(run())

    assert loop_state["total_used"] == 3
