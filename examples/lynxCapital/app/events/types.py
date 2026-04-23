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

Category = Literal["system", "agent", "delegation", "tool", "service", "caracal", "audit", "chat"]


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


def chat_user(run_id: str, text: str) -> Event:
    return _mk(run_id, "chat", "chat_user", text=text)


def chat_token(run_id: str, agent_id: str, message_id: str, token: str) -> Event:
    return _mk(run_id, "chat", "chat_token", agent_id=agent_id, message_id=message_id, token=token)


def chat_message(run_id: str, agent_id: str, message_id: str, text: str) -> Event:
    return _mk(run_id, "chat", "chat_message", agent_id=agent_id, message_id=message_id, text=text)


def llm_call(
    run_id: str,
    agent_id: str,
    model: str,
    latency_ms: int,
    input_tokens: int,
    output_tokens: int,
    tool_calls: int,
    streamed_chars: int,
) -> Event:
    return _mk(
        run_id, "system", "llm_call",
        agent_id=agent_id, model=model, latency_ms=latency_ms,
        input_tokens=input_tokens, output_tokens=output_tokens,
        tool_calls=tool_calls, streamed_chars=streamed_chars,
    )


def memory_update(
    run_id: str,
    agent_id: str,
    tokens_used: int,
    tokens_limit: int,
    message_count: int,
    compactions: int,
) -> Event:
    return _mk(
        run_id, "system", "memory_update",
        agent_id=agent_id,
        tokens_used=tokens_used,
        tokens_limit=tokens_limit,
        message_count=message_count,
        compactions=compactions,
    )


def memory_compaction(
    run_id: str,
    agent_id: str,
    summary: str,
    tokens_before: int,
    tokens_after: int,
) -> Event:
    return _mk(
        run_id, "system", "memory_compaction",
        agent_id=agent_id,
        summary=summary,
        tokens_before=tokens_before,
        tokens_after=tokens_after,
    )


def model_change(run_id: str, model: str, prior: str) -> Event:
    return _mk(run_id, "system", "model_change", model=model, prior=prior)
