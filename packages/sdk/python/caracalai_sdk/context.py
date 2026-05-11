"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

CaracalContext: ambient identity and delegation context via contextvars.
"""

from __future__ import annotations

import contextvars
from dataclasses import dataclass, replace
from typing import Any, Awaitable, Callable, TypeVar

from .envelope import Envelope

T = TypeVar("T")

_ctx_var: contextvars.ContextVar["CaracalContext"] = contextvars.ContextVar(
    "caracal_context"
)


@dataclass(frozen=True)
class CaracalContext:
    subject_token: str
    zone_id: str
    client_id: str
    agent_session_id: str | None = None
    delegation_edge_id: str | None = None
    parent_edge_id: str | None = None
    session_id: str | None = None
    trace_id: str | None = None
    hop: int = 0


def current() -> CaracalContext | None:
    return _ctx_var.get(None)


def bind(ctx: CaracalContext, fn: Callable[[], T]) -> T:
    token = _ctx_var.set(ctx)
    try:
        return fn()
    finally:
        _ctx_var.reset(token)


async def abind(ctx: CaracalContext, coro: Awaitable[T]) -> T:
    token = _ctx_var.set(ctx)
    try:
        return await coro
    finally:
        _ctx_var.reset(token)


def with_overrides(**patch: Any) -> CaracalContext:
    base = current()
    if base is None:
        raise RuntimeError("with_overrides requires an existing Caracal context")
    return replace(base, **patch)


def to_envelope(ctx: CaracalContext) -> Envelope:
    return Envelope(
        subject_token=ctx.subject_token,
        agent_session_id=ctx.agent_session_id,
        delegation_edge_id=ctx.delegation_edge_id,
        parent_edge_id=ctx.parent_edge_id,
        trace_id=ctx.trace_id,
        hop=ctx.hop,
    )


def from_envelope(
    env: Envelope,
    *,
    zone_id: str,
    client_id: str,
) -> CaracalContext:
    if not env.subject_token:
        raise ValueError("envelope missing subject token")
    return CaracalContext(
        subject_token=env.subject_token,
        zone_id=zone_id,
        client_id=client_id,
        agent_session_id=env.agent_session_id,
        delegation_edge_id=env.delegation_edge_id,
        parent_edge_id=env.parent_edge_id,
        trace_id=env.trace_id,
        hop=env.hop,
    )
