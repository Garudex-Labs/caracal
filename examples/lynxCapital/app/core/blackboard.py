"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Run-scoped shared blackboard for cross-agent findings and coordination.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from threading import Lock


@dataclass
class Finding:
    agent_id: str
    region: str | None
    kind: str
    content: str
    ts: float = field(default_factory=time.time)

    def as_dict(self) -> dict:
        return {
            "agent_id": self.agent_id,
            "region": self.region,
            "kind": self.kind,
            "content": self.content,
            "ts": self.ts,
        }


class RunBlackboard:
    """Append-only shared workspace where any agent in a run can post findings
    and any agent can read them back filtered by kind or region."""

    def __init__(self, run_id: str) -> None:
        self.run_id = run_id
        self._items: list[Finding] = []
        self._lock = Lock()

    def post(self, agent_id: str, region: str | None, kind: str, content: str) -> Finding:
        f = Finding(agent_id=agent_id, region=region, kind=kind, content=content)
        with self._lock:
            self._items.append(f)
        return f

    def read(self, kind: str | None = None, region: str | None = None, limit: int = 20) -> list[Finding]:
        with self._lock:
            items = list(self._items)
        if kind:
            items = [f for f in items if f.kind == kind]
        if region:
            items = [f for f in items if f.region == region]
        return items[-max(1, limit):]

    def all(self) -> list[Finding]:
        with self._lock:
            return list(self._items)
