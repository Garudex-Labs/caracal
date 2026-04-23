"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Agent lifecycle runner: spawn, start, end, terminate, and subtree cancellation.
"""
from __future__ import annotations

from uuid import uuid4

from app.events import types as ev
from app.events.bus import bus


class AgentHandle:
    def __init__(
        self,
        id: str,
        role: str,
        scope: str,
        parent_id: str | None,
        layer: str,
        region: str | None,
        run_id: str,
    ) -> None:
        self.id = id
        self.role = role
        self.scope = scope
        self.parent_id = parent_id
        self.layer = layer
        self.region = region
        self.run_id = run_id
        self.status = "spawned"
        self._terminated = False

    def start(self) -> None:
        self.status = "running"
        bus.publish(ev.agent_start(self.run_id, self.id))

    def end(self, result: dict | None = None) -> None:
        bus.publish(ev.agent_end(self.run_id, self.id, result))

    def terminate(self, status: str = "completed") -> None:
        if self._terminated:
            raise RuntimeError(f"Agent {self.id} already terminated.")
        self._terminated = True
        self.status = status
        bus.publish(ev.agent_terminate(self.run_id, self.id, status))


class AgentRunner:
    def __init__(self, run_id: str) -> None:
        self.run_id = run_id
        self._handles: dict[str, AgentHandle] = {}
        self._children: dict[str, list[str]] = {}

    def spawn(
        self,
        role: str,
        scope: str,
        parent: AgentHandle | None,
        layer: str,
        region: str | None = None,
    ) -> AgentHandle:
        agent_id = str(uuid4())
        parent_id = parent.id if parent else None

        handle = AgentHandle(
            id=agent_id,
            role=role,
            scope=scope,
            parent_id=parent_id,
            layer=layer,
            region=region,
            run_id=self.run_id,
        )
        self._handles[agent_id] = handle
        if parent_id:
            self._children.setdefault(parent_id, []).append(agent_id)

        bus.publish(ev.agent_spawn(self.run_id, agent_id, role, scope, parent_id, layer, region))
        if parent_id:
            bus.publish(ev.delegation(self.run_id, parent_id, agent_id, scope))

        return handle

    def cancel_subtree(self, agent_id: str) -> None:
        for child_id in list(self._children.get(agent_id, [])):
            self.cancel_subtree(child_id)
        handle = self._handles.get(agent_id)
        if handle and not handle._terminated:
            handle.terminate("cancelled")

    def handle(self, agent_id: str) -> AgentHandle | None:
        return self._handles.get(agent_id)

    def all_handles(self) -> list[AgentHandle]:
        return list(self._handles.values())


_runners: dict[str, AgentRunner] = {}


def create_runner(run_id: str) -> AgentRunner:
    runner = AgentRunner(run_id)
    _runners[run_id] = runner
    return runner


def get_runner(run_id: str) -> AgentRunner | None:
    return _runners.get(run_id)
