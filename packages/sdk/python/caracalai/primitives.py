"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SDK primitives: spawn an agent session and delegate authority as async context managers.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field, replace
from collections.abc import AsyncGenerator, Awaitable, Callable

import httpx

from .auth import TokenSource
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


async def _resolve_bearer(token_source: TokenSource | None, fallback: str) -> str:
    if token_source is not None:
        return await asyncio.to_thread(token_source)
    return fallback


async def _terminate_shielded(
    coordinator: CoordinatorClient,
    zone_id: str,
    agent_session_id: str,
    *,
    token_source: TokenSource | None,
    fallback_token: str,
) -> None:
    """Retire a session even while the awaiting task is being cancelled: the
    terminate call runs as a shielded task, so caller cancellation cannot
    orphan a live server-side session."""

    async def retire() -> None:
        bearer = await _resolve_bearer(token_source, fallback_token)
        await terminate_agent(coordinator, bearer, zone_id, agent_session_id)

    cleanup = asyncio.ensure_future(retire())
    try:
        await asyncio.shield(cleanup)
    except asyncio.CancelledError:
        if not cleanup.done():

            def log_result(task: asyncio.Task[None]) -> None:
                if not task.cancelled() and task.exception() is not None:
                    logger.warning(
                        "terminate for agent %s failed after caller cancellation",
                        agent_session_id,
                        exc_info=task.exception(),
                    )

            cleanup.add_done_callback(log_result)
        raise


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
    token_source: TokenSource | None = None,
    subject_session_id: str | None = None,
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

    Spawn scopes bind via a contextvar and must nest: exit them in reverse order
    of entry on any given task. Cleanup terminates the session with a fresh
    bearer from ``token_source`` when one is provided, so a token that expired
    while the body ran cannot strand the session.
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
            subject_session_id=subject_session_id,
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
    except (asyncio.CancelledError, Exception):
        await _terminate_shielded(
            coordinator,
            zone_id,
            res.agent_session_id,
            token_source=token_source,
            fallback_token=bearer,
        )
        raise

    ctx = CaracalContext(
        subject_token=bearer,
        zone_id=zone_id,
        application_id=application_id,
        agent_session_id=res.agent_session_id,
        delegation_edge_id=delegation_edge_id,
        parent_edge_id=parent.delegation_edge_id if parent else None,
        session_id=subject_session_id or (parent.session_id if parent else None),
        trace_id=trace_id or (parent.trace_id if parent else None),
        trace_flags=parent.trace_flags if parent else None,
        trace_state=parent.trace_state if parent else None,
        baggage=parent.baggage if parent else (),
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
        try:
            if started and on_agent_end is not None:
                await on_agent_end(ctx)
        finally:
            await _terminate_shielded(
                coordinator,
                zone_id,
                res.agent_session_id,
                token_source=token_source,
                fallback_token=bearer,
            )


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
    token_source: TokenSource | None = None
    invalidate: Callable[[], None] | None = None
    _auto_task: asyncio.Task[None] | None = field(
        default=None, init=False, repr=False, compare=False
    )
    _closed: bool = field(default=False, init=False, repr=False, compare=False)

    @property
    def agent_session_id(self) -> str:
        return self.context.agent_session_id

    async def _bearer(self) -> str:
        return await _resolve_bearer(self.token_source, self.subject_token)

    async def heartbeat(self, status: str = "healthy") -> None:
        try:
            await heartbeat_agent(
                self.coordinator,
                await self._bearer(),
                self.context.zone_id,
                self.context.agent_session_id,
                status,
            )
        except httpx.HTTPStatusError as exc:
            # A cached token can be rejected before its exp (server-side
            # session revocation after a credential rotation); force one
            # refresh and retry so the lease survives the rotation.
            if exc.response.status_code != 401 or self.invalidate is None:
                raise
            self.invalidate()
            await heartbeat_agent(
                self.coordinator,
                await self._bearer(),
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
        if self._closed:
            return
        self._closed = True
        if self._auto_task is not None:
            self._auto_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._auto_task
            self._auto_task = None
        await _terminate_shielded(
            self.coordinator,
            self.context.zone_id,
            self.context.agent_session_id,
            token_source=self.token_source,
            fallback_token=self.subject_token,
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
    token_source: TokenSource | None = None,
    invalidate: Callable[[], None] | None = None,
    subject_session_id: str | None = None,
    parent_id: str | None = None,
    parent_ctx: CaracalContext | None = None,
    grant: Grant | None = None,
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

    Authority follows the same model as :func:`spawn`: the session inherits its
    parent's effective authority by default, and ``grant=Grant.narrow([...])``
    issues a bounded delegation edge so the handle holds only a subset.

    Pass ``heartbeat_interval`` (seconds, well below the server lease) to renew
    the lease automatically from a background task - the lease keeps advancing
    even while the caller is blocked on a long provider/resource stream. With
    ``token_source`` set, every lease renewal and the final terminate resolve a
    fresh bearer, so the handle outlives the token minted at spawn."""
    grant = grant or Grant.inherit()
    parent = parent_ctx if parent_ctx is not None else current()
    parent_agent_session_id = parent_id or (parent.agent_session_id if parent else None)

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
        subject_token,
        SpawnRequest(
            zone_id=zone_id,
            application_id=application_id,
            subject_session_id=subject_session_id,
            parent_id=parent_agent_session_id,
            lifecycle=Lifecycle.SERVICE,
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
    except (asyncio.CancelledError, Exception):
        await _terminate_shielded(
            coordinator,
            zone_id,
            res.agent_session_id,
            token_source=token_source,
            fallback_token=subject_token,
        )
        raise

    ctx = CaracalContext(
        subject_token=subject_token,
        zone_id=zone_id,
        application_id=application_id,
        agent_session_id=res.agent_session_id,
        delegation_edge_id=delegation_edge_id,
        parent_edge_id=parent.delegation_edge_id if parent else None,
        session_id=subject_session_id or (parent.session_id if parent else None),
        trace_id=trace_id or (parent.trace_id if parent else None),
        trace_flags=parent.trace_flags if parent else None,
        trace_state=parent.trace_state if parent else None,
        baggage=parent.baggage if parent else (),
        hop=hop,
    )
    if on_agent_start is not None:
        try:
            await on_agent_start(ctx)
        except (asyncio.CancelledError, Exception):
            await _terminate_shielded(
                coordinator,
                zone_id,
                res.agent_session_id,
                token_source=token_source,
                fallback_token=subject_token,
            )
            raise
    agent = ServiceAgent(
        coordinator=coordinator,
        subject_token=subject_token,
        context=ctx,
        heartbeat_interval=heartbeat_interval,
        token_source=token_source,
        invalidate=invalidate,
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
