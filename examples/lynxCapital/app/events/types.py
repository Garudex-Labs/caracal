"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Typed event models and factory functions for every lifecycle event kind.
"""
from __future__ import annotations

import time
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, Field

Category = Literal["system", "agent", "delegation", "tool", "service", "caracal", "audit"]


class Event(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    run_id: str
    ts: float = Field(default_factory=time.time)
    category: Category
    kind: str
    payload: dict[str, Any] = Field(default_factory=dict)


def _mk(run_id: str, category: Category, kind: str, **payload: Any) -> Event:
    return Event(run_id=run_id, category=category, kind=kind, payload=payload)


def run_start(run_id: str, prompt: str) -> Event:
    return _mk(run_id, "system", "run_start", prompt=prompt)


def run_end(run_id: str, status: str) -> Event:
    return _mk(run_id, "system", "run_end", status=status)


def error(run_id: str, message: str, agent_id: str | None = None) -> Event:
    return _mk(run_id, "system", "error", message=message, agent_id=agent_id)


def agent_spawn(
    run_id: str,
    agent_id: str,
    role: str,
    scope: str,
    parent_id: str | None,
    layer: str,
    region: str | None = None,
) -> Event:
    return _mk(
        run_id, "agent", "agent_spawn",
        agent_id=agent_id, role=role, scope=scope,
        parent_id=parent_id, layer=layer, region=region,
    )


def agent_start(run_id: str, agent_id: str) -> Event:
    return _mk(run_id, "agent", "agent_start", agent_id=agent_id)


def agent_end(run_id: str, agent_id: str, result: dict | None = None) -> Event:
    return _mk(run_id, "agent", "agent_end", agent_id=agent_id, result=result or {})


def agent_terminate(run_id: str, agent_id: str, status: str) -> Event:
    return _mk(run_id, "agent", "agent_terminate", agent_id=agent_id, status=status)


def delegation(run_id: str, parent_id: str, child_id: str, scope: str) -> Event:
    return _mk(run_id, "delegation", "delegation", parent_id=parent_id, child_id=child_id, scope=scope)


def tool_call(run_id: str, agent_id: str, tool_name: str, args: dict) -> Event:
    return _mk(run_id, "tool", "tool_call", agent_id=agent_id, tool_name=tool_name, args=args)


def tool_result(run_id: str, agent_id: str, tool_name: str, result: dict) -> Event:
    return _mk(run_id, "tool", "tool_result", agent_id=agent_id, tool_name=tool_name, result=result)


def service_call(run_id: str, agent_id: str, service_id: str, action: str, payload: dict) -> Event:
    return _mk(
        run_id, "service", "service_call",
        agent_id=agent_id, service_id=service_id, action=action, payload=payload,
    )


def service_result(run_id: str, agent_id: str, service_id: str, action: str, result: dict) -> Event:
    return _mk(
        run_id, "service", "service_result",
        agent_id=agent_id, service_id=service_id, action=action, result=result,
    )


def audit_record(run_id: str, agent_id: str, record: dict) -> Event:
    return _mk(run_id, "audit", "audit_record", agent_id=agent_id, record=record)


def caracal_bind(run_id: str, agent_id: str, decision: str, reason: str = "") -> Event:
    return _mk(run_id, "caracal", "caracal_bind", agent_id=agent_id, decision=decision, reason=reason)


def caracal_enforce(run_id: str, agent_id: str, tool_id: str, decision: str, reason: str = "") -> Event:
    return _mk(
        run_id, "caracal", "caracal_enforce",
        agent_id=agent_id, tool_id=tool_id, decision=decision, reason=reason,
    )
