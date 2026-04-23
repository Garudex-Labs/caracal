"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Per-agent todo plan store for DeepAgents-style write_todos planning.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from threading import Lock
from typing import Literal

Status = Literal["pending", "in_progress", "completed"]
_VALID: tuple[Status, ...] = ("pending", "in_progress", "completed")


@dataclass
class PlanItem:
    id: int
    content: str
    status: Status = "pending"

    def as_dict(self) -> dict:
        return {"id": self.id, "content": self.content, "status": self.status}


@dataclass
class AgentPlan:
    agent_id: str
    items: list[PlanItem] = field(default_factory=list)
    revision: int = 0

    def replace(self, raw_items: list[dict | str]) -> list[PlanItem]:
        out: list[PlanItem] = []
        for i, raw in enumerate(raw_items or []):
            if isinstance(raw, str):
                content, status = raw, "pending"
            else:
                content = str(raw.get("content") or raw.get("task") or "").strip()
                status = raw.get("status") or "pending"
            if status not in _VALID:
                status = "pending"
            if not content:
                continue
            out.append(PlanItem(id=i + 1, content=content[:240], status=status))  # type: ignore[arg-type]
        self.items = out
        self.revision += 1
        return out

    def as_list(self) -> list[dict]:
        return [p.as_dict() for p in self.items]


class RunPlanStore:
    def __init__(self, run_id: str) -> None:
        self.run_id = run_id
        self._plans: dict[str, AgentPlan] = {}
        self._lock = Lock()

    def get_or_create(self, agent_id: str) -> AgentPlan:
        with self._lock:
            p = self._plans.get(agent_id)
            if p is None:
                p = AgentPlan(agent_id=agent_id)
                self._plans[agent_id] = p
            return p

    def write(self, agent_id: str, todos: list[dict | str]) -> AgentPlan:
        plan = self.get_or_create(agent_id)
        plan.replace(todos)
        return plan
