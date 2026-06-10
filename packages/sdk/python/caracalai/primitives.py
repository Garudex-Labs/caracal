"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SDK primitives: spawn an agent session and delegate authority as async context managers.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass, field, replace
from collections.abc import AsyncGenerator, Awaitable, Callable

from .context import CaracalContext, current, _ctx_var
from .coordinator import (
    Lifecycle,
    CoordinatorClient,
    DelegationConstraints,
    DelegationRequest,
    SpawnRequest,
    create_delegation,
    heartbeat_agent,
    spawn_agent,
    terminate_agent,
)
from .json_types import JsonObject


logger = logging.getLogger("caracalai")

LifecycleHook = Callable[[CaracalContext], Awaitable[None]]


@dataclass(frozen=True)
class Grant:
    """Authority handed to a spawned child.

    ``inherit`` (the default) runs the child under its parent's effective
    session: if the parent itself holds a narrowing delegation edge the child
    inherits that same narrowing (the server mirrors the parent's edge onto the
    child), so least-privilege is transitive by default; a root parent under full
    application authority yields a child under that same full authority.
    ``narrow`` issues a bounded delegation edge so the child holds only the listed
    scopes; the server re-validates the subset, so a narrow can never broaden.
    ``none`` spawns without issuing any edge.
    """

    mode: str = "inherit"
    scopes: tuple[str, ...] = ()
    resource_id: str | None = None
    constraints: DelegationConstraints | None = None
    ttl_seconds: int | None = None

    @staticmethod
    def inherit() -> Grant:
        return Grant(mode="inherit")

    @staticmethod
    def none() -> Grant:
        return Grant(mode="none")

    @staticmethod
    def narrow(
        scopes: list[str],
        *,
        resource_id: str | None = None,
        constraints: DelegationConstraints | None = None,
        ttl_seconds: int | None = None,
    ) -> Grant:
        return Grant(
            mode="narrow",
            scopes=tuple(scopes),
            resource_id=resource_id,
            constraints=constraints,
            ttl_seconds=ttl_seconds,
        )


@asynccontextmanager
async def spawn(
    *,
    coordinator: CoordinatorClient,
    zone_id: str,
    application_id: str,
    subject_token: str,
    parent_id: str | None = None,
    parent_ctx: CaracalContext | None = None,
    grant: Grant | None = None,
    ttl_seconds: int | None = None,
    metadata: JsonObject | None = None,
    labels: list[str] | None = None,
    trace_id: str | None = None,
    on_agent_start: LifecycleHook | None = None,
    on_agent_end: LifecycleHook | None = None,
) -> AsyncGenerator[CaracalContext, None]:
    """Spawn a child agent session and bind it to the current task.

    The child inherits its parent's effective authority by default: a child of a
    narrowed parent carries that same narrowing forward (transitive
    least-privilege), while a child of a root parent runs under full application
    authority. Pass ``grant=Grant.narrow([...])`` to issue a bounded delegation
    edge so the child holds only a subset. ``parent_ctx`` overrides the bound
    :func:`current` lookup; pass it explicitly when the orchestrator owns the
    parent context but the spawn runs on a different task (asyncio TaskGroup,
    thread pool, framework worker) where the parent's contextvar is not visible.
    """
    grant = grant or Grant.inherit()
    parent = parent_ctx if parent_ctx is not None else current()
    parent_agent_session_id = parent_id or (parent.agent_session_id if parent else None)
    bearer = subject_token

    inherit_parent_edge_id = (
        parent.delegation_edge_id
        if (
            grant.mode == "inherit"
            and parent is not None
            and parent.agent_session_id
            and parent.delegation_edge_id
            and application_id == parent.application_id
        )
        else None
    )

    res = await spawn_agent(
        coordinator,
        bearer,
        SpawnRequest(
            zone_id=zone_id,
            application_id=application_id,
            parent_id=parent_agent_session_id,
            ttl_seconds=ttl_seconds,
            metadata=metadata,
            labels=labels,
            inherit_parent_edge_id=inherit_parent_edge_id,
        ),
    )

    delegation_edge_id: str | None = res.delegation_edge_id
    hop = (
        parent.hop + 1
        if (delegation_edge_id is not None and parent is not None)
        else (parent.hop if parent else 0)
    )
    try:
        if grant.mode == "narrow":
            if parent is None or not parent.agent_session_id:
                raise RuntimeError(
                    "grant=narrow requires an active parent agent session"
                )
            deleg = await create_delegation(
                coordinator,
                parent.subject_token,
                DelegationRequest(
                    zone_id=zone_id,
                    issuer_application_id=parent.application_id,
                    source_session_id=parent.agent_session_id,
                    target_session_id=res.agent_session_id,
                    receiver_application_id=application_id,
                    parent_edge_id=parent.delegation_edge_id,
                    resource_id=grant.resource_id,
                    scopes=list(grant.scopes),
                    constraints=grant.constraints,
                    ttl_seconds=grant.ttl_seconds,
                ),
            )
            delegation_edge_id = deleg.delegation_edge_id
            hop = parent.hop + 1
    except BaseException:
        await terminate_agent(coordinator, bearer, zone_id, res.agent_session_id)
        raise

    ctx = CaracalContext(
        subject_token=bearer,
        zone_id=zone_id,
        application_id=application_id,
        agent_session_id=res.agent_session_id,
        delegation_edge_id=delegation_edge_id,
        parent_edge_id=parent.delegation_edge_id if parent else None,
        session_id=parent.session_id if parent else None,
        trace_id=trace_id or (parent.trace_id if parent else None),
        hop=hop,
    )

    token = None
    started = False
    try:
        if on_agent_start is not None:
            await on_agent_start(ctx)
        started = True
        token = _ctx_var.set(ctx)
        yield ctx
    finally:
        if token is not None:
            _ctx_var.reset(token)
        if started and on_agent_end is not None:
            await on_agent_end(ctx)
        await terminate_agent(coordinator, bearer, zone_id, res.agent_session_id)


@dataclass
class ServiceAgent:
    """Handle for a long-lived service agent session. Unlike :func:`spawn`,
    a service session is not terminated automatically: the holder must
    :meth:`heartbeat` to keep its lease and :meth:`aclose` to retire it.

    Pass ``heartbeat_interval`` to :func:`spawn_service` to have the handle
    renew its own lease from an independent background task. The renewal runs
    on its own loop iteration, so the lease keeps advancing even while the
    calling coroutine is awaiting a long provider/resource stream. A transient
    renewal error is logged and retried on the next tick rather than raised."""

    coordinator: CoordinatorClient
    subject_token: str
    context: CaracalContext
    heartbeat_interval: float | None = None
    status: str = "healthy"
    _auto_task: asyncio.Task[None] | None = field(
        default=None, init=False, repr=False, compare=False
    )

    @property
    def agent_session_id(self) -> str:
        return self.context.agent_session_id

    async def heartbeat(self, status: str = "healthy") -> None:
        await heartbeat_agent(
            self.coordinator,
            self.subject_token,
            self.context.zone_id,
            self.context.agent_session_id,
            status,
        )

    def _start_auto_heartbeat(self) -> None:
        if self.heartbeat_interval is None or self._auto_task is not None:
            return
        self._auto_task = asyncio.create_task(self._auto_heartbeat_loop())

    async def _auto_heartbeat_loop(self) -> None:
        assert self.heartbeat_interval is not None
        while True:
            await asyncio.sleep(self.heartbeat_interval)
            try:
                await self.heartbeat(self.status)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning(
                    "auto-heartbeat failed for agent %s; retrying next tick",
                    self.context.agent_session_id,
                    exc_info=True,
                )

    async def aclose(self) -> None:
        if self._auto_task is not None:
            self._auto_task.cancel()
            try:
                await self._auto_task
            except asyncio.CancelledError:
                pass
            self._auto_task = None
        await terminate_agent(
            self.coordinator,
            self.subject_token,
            self.context.zone_id,
            self.context.agent_session_id,
        )

    async def __aenter__(self) -> ServiceAgent:
        self._start_auto_heartbeat()
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()


async def spawn_service(
    *,
    coordinator: CoordinatorClient,
    zone_id: str,
    application_id: str,
    subject_token: str,
    parent_id: str | None = None,
    parent_ctx: CaracalContext | None = None,
    ttl_seconds: int | None = None,
    metadata: JsonObject | None = None,
    labels: list[str] | None = None,
    trace_id: str | None = None,
    heartbeat_interval: float | None = None,
    on_agent_start: LifecycleHook | None = None,
) -> ServiceAgent:
    """Spawn a long-lived service agent session and return a handle the caller
    owns. The session carries a heartbeat lease; renew it with
    :meth:`ServiceAgent.heartbeat` and retire it with :meth:`ServiceAgent.aclose`.

    Pass ``heartbeat_interval`` (seconds, well below the server lease) to renew
    the lease automatically from a background task — the lease keeps advancing
    even while the caller is blocked on a long provider/resource stream."""
    parent = parent_ctx if parent_ctx is not None else current()
    parent_agent_session_id = parent_id or (parent.agent_session_id if parent else None)

    res = await spawn_agent(
        coordinator,
        subject_token,
        SpawnRequest(
            zone_id=zone_id,
            application_id=application_id,
            parent_id=parent_agent_session_id,
            lifecycle=Lifecycle.SERVICE,
            ttl_seconds=ttl_seconds,
            metadata=metadata,
            labels=labels,
        ),
    )

    ctx = CaracalContext(
        subject_token=subject_token,
        zone_id=zone_id,
        application_id=application_id,
        agent_session_id=res.agent_session_id,
        parent_edge_id=parent.delegation_edge_id if parent else None,
        session_id=parent.session_id if parent else None,
        trace_id=trace_id or (parent.trace_id if parent else None),
        hop=parent.hop if parent else 0,
    )
    if on_agent_start is not None:
        await on_agent_start(ctx)
    agent = ServiceAgent(
        coordinator=coordinator,
        subject_token=subject_token,
        context=ctx,
        heartbeat_interval=heartbeat_interval,
    )
    agent._start_auto_heartbeat()
    return agent


@asynccontextmanager
async def delegate(
    *,
    coordinator: CoordinatorClient,
    to_agent_session_id: str,
    to_application_id: str,
    scopes: list[str],
    resource_id: str | None = None,
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
            issuer_application_id=ctx.application_id,
            source_session_id=ctx.agent_session_id,
            target_session_id=to_agent_session_id,
            receiver_application_id=to_application_id,
            parent_edge_id=ctx.delegation_edge_id,
            resource_id=resource_id,
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
