"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Long-lived worker pool that lets an orchestrator keep some agents alive across multiple tool calls.
"""
from __future__ import annotations

from app.agents.roles import ROLES
from app.agents.runner import AgentHandle, AgentRunner
from app.events import types as ev
from app.events.bus import bus


class WorkerPool:
    """Per-orchestrator pool of long-lived worker handles. acquire() spawns a
    worker and starts it; release() ends and terminates it. drain() cleans up
    any worker still alive at shutdown."""

    def __init__(self, run_id: str, runner: AgentRunner, parent: AgentHandle) -> None:
        self.run_id = run_id
        self._runner = runner
        self._parent = parent
        self._active: dict[str, AgentHandle] = {}

    def acquire(self, role: str, scope: str, customer_id: str | None = None) -> AgentHandle:
        if role not in ROLES:
            raise ValueError(f"unknown role {role!r}; valid roles: {', '.join(sorted(ROLES))}")
        w = self._runner.spawn(
            role=role, scope=scope, parent=self._parent,
            layer=role, region=self._parent.region, customer_id=customer_id,
        )
        w.start()
        self._active[w.id] = w
        bus.publish(ev.worker_acquire(self.run_id, self._parent.id, w.id, role, scope))
        return w

    def release(self, worker_id: str, result: dict) -> bool:
        w = self._active.pop(worker_id, None)
        if w is None:
            return False
        w.end(result)
        w.terminate("completed")
        bus.publish(ev.worker_release(self.run_id, self._parent.id, worker_id, result))
        return True

    def active_ids(self) -> list[str]:
        return list(self._active.keys())

    def drain(self, status: str = "cancelled") -> None:
        for worker_id, w in list(self._active.items()):
            if not w._terminated:
                w.end({"drained": True})
                w.terminate(status)
                bus.publish(ev.worker_release(
                    self.run_id, self._parent.id, worker_id, {"drained": True, "status": status},
                ))
            self._active.pop(worker_id, None)
