"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SDK primitives: with_agent and with_delegation as async context managers.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from dataclasses import replace
from typing import Any, AsyncGenerator

from .context import CaracalContext, current, try_current, _ctx_var
from .coordinator import (
    AgentKind,
    CoordinatorClient,
    DelegationRequest,
    SpawnRequest,
    create_delegation,
    spawn_agent,
    terminate_agent,
)


@asynccontextmanager
async def with_agent(
    *,
    coordinator: CoordinatorClient,
    zone_id: str,
    application_id: str,
    subject_token: str,
    session_sid: str | None = None,
    parent_id: str | None = None,
    kind: AgentKind = "instance",
    ttl_seconds: int | None = None,
    metadata: dict[str, Any] | None = None,
    trace_id: str | None = None,
) -> AsyncGenerator[CaracalContext, None]:
    parent = try_current()
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

    token = _ctx_var.set(ctx)
    try:
        yield ctx
    finally:
        _ctx_var.reset(token)
        if kind != "service":
            await terminate_agent(coordinator, bearer, zone_id, res.agent_session_id)


@asynccontextmanager
async def with_delegation(
    *,
    coordinator: CoordinatorClient,
    to_agent_session_id: str,
    to_application_id: str,
    scopes: list[str],
    constraints: dict[str, Any] | None = None,
    ttl_seconds: int | None = None,
) -> AsyncGenerator[CaracalContext, None]:
    ctx = current()
    if not ctx.agent_session_id:
        raise RuntimeError("with_delegation requires an active agent session in context")

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
