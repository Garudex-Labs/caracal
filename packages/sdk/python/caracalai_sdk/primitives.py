"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SDK primitives: spawn an agent session and delegate authority as async context managers.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from dataclasses import replace
from typing import Any, AsyncGenerator, Awaitable, Callable

from .context import CaracalContext, current, _ctx_var
from .coordinator import (
    AgentKind,
    CoordinatorClient,
    DelegationConstraints,
    DelegationRequest,
    SpawnRequest,
    create_delegation,
    spawn_agent,
    terminate_agent,
)


LifecycleHook = Callable[[CaracalContext], Awaitable[None]]


@asynccontextmanager
async def spawn(
    *,
    coordinator: CoordinatorClient,
    zone_id: str,
    application_id: str,
    subject_token: str,
    session_sid: str | None = None,
    parent_id: str | None = None,
    kind: AgentKind = AgentKind.INSTANCE,
    ttl_seconds: int | None = None,
    metadata: dict[str, Any] | None = None,
    trace_id: str | None = None,
    on_agent_start: LifecycleHook | None = None,
    on_agent_end: LifecycleHook | None = None,
) -> AsyncGenerator[CaracalContext, None]:
    parent = current()
    resolved_parent_id = parent_id or (parent.agent_session_id if parent else None)
    bearer = subject_token

    res = await spawn_agent(
        coordinator,
        bearer,
        SpawnRequest(
            zone_id=zone_id,
            application_id=application_id,
            session_sid=session_sid,
            parent_id=resolved_parent_id,
            kind=kind,
            ttl_seconds=ttl_seconds,
            metadata=metadata,
        ),
    )

    ctx = CaracalContext(
        subject_token=bearer,
        zone_id=zone_id,
        client_id=application_id,
        agent_session_id=res.agent_session_id,
        parent_edge_id=parent.delegation_edge_id if parent else None,
        session_id=session_sid or (parent.session_id if parent else None),
        trace_id=trace_id or (parent.trace_id if parent else None),
        hop=parent.hop if parent else 0,
    )

    if on_agent_start is not None:
        await on_agent_start(ctx)

    token = _ctx_var.set(ctx)
    try:
        yield ctx
    finally:
        _ctx_var.reset(token)
        if on_agent_end is not None:
            await on_agent_end(ctx)
        if kind != AgentKind.SERVICE:
            await terminate_agent(coordinator, bearer, zone_id, res.agent_session_id)


@asynccontextmanager
async def delegate(
    *,
    coordinator: CoordinatorClient,
    to_agent_session_id: str,
    to_application_id: str,
    scopes: list[str],
    constraints: DelegationConstraints | None = None,
    ttl_seconds: int | None = None,
) -> AsyncGenerator[CaracalContext, None]:
    ctx = current()
    if ctx is None or not ctx.agent_session_id:
        raise RuntimeError("delegate requires an active agent session in context")

    res = await create_delegation(
        coordinator,
        ctx.subject_token,
        DelegationRequest(
            zone_id=ctx.zone_id,
            issuer_application_id=ctx.client_id,
            source_session_id=ctx.agent_session_id,
            target_session_id=to_agent_session_id,
            receiver_application_id=to_application_id,
            scopes=scopes,
            constraints=constraints,
            ttl_seconds=ttl_seconds,
        ),
    )

    child = replace(
        ctx,
        parent_edge_id=ctx.delegation_edge_id,
        delegation_edge_id=res.delegation_edge_id,
        hop=ctx.hop + 1,
    )
    token = _ctx_var.set(child)
    try:
        yield child
    finally:
        _ctx_var.reset(token)
