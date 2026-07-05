"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SDK primitives: spawn agent sessions, delegate authority, and adopt delegation edges.
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
import uuid
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, replace
from datetime import datetime
from collections.abc import AsyncGenerator, Awaitable, Callable

import httpx

from caracalai_oauth import TokenSource

from .context import CaracalContext, current, _ctx_var
from .coordinator import (
    Lifecycle,
    CoordinatorClient,
    DelegationConstraints,
    DelegationRequest,
    DelegationResponse,
    SpawnRequest,
    create_delegation,
    heartbeat_agent,
    spawn_agent,
    terminate_agent,
)
from .errors import CoordinatorError
from .json_types import JsonObject


logger = logging.getLogger("caracalai")

LifecycleHook = Callable[[CaracalContext], Awaitable[None]]

_SPAWN_RETRIES = 2
_MIN_AUTO_HEARTBEAT = 1.0
_MAX_AUTO_HEARTBEAT = 300.0
_FALLBACK_AUTO_HEARTBEAT = 30.0


def _is_gone(exc: BaseException) -> bool:
    """A session the coordinator no longer holds live (terminated or reaped)
    counts as retired."""
    return isinstance(exc, CoordinatorError) and exc.status in (404, 409)


def _parse_deadline(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value).timestamp()
    except ValueError:
        return None


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
    propagate: bool = False,
) -> None:
    """Retire a session even while the awaiting task is being cancelled: the
    terminate call runs as a shielded task, so caller cancellation cannot
    orphan a live server-side session. A session the coordinator already
    retired counts as success; other failures raise only when ``propagate``
    is set - cleanup paths log instead so they never mask the caller's
    primary outcome, and the coordinator's TTL sweeper retires whatever this
    misses."""

    async def retire() -> None:
        bearer = await _resolve_bearer(token_source, fallback_token)
        try:
            await terminate_agent(coordinator, bearer, zone_id, agent_session_id)
        except Exception as exc:
            if _is_gone(exc):
                return
            if propagate:
                raise
            logger.warning(
                "terminate failed for agent %s; the coordinator TTL sweeper will retire it",
                agent_session_id,
                exc_info=True,
            )

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

    ``inherit`` (the default) carries the parent's effective authority forward:
    the coordinator resolves the parent's active narrowing edge server-side and
    mirrors it onto the child, so least-privilege is transitive by default. A
    parent that holds no edge yields an edge-less child running under the
    application's policy-bounded authority; the platform decision contract
    mints resource mandates only over a delegation edge, so an edge-less
    session cannot present delegated authority. Inheritance never crosses an
    application boundary. ``narrow`` issues a bounded delegation edge so the
    child holds only the listed scopes; the server re-validates the subset, so
    a narrow can never broaden. A narrow edge defaults to a hop budget of 1;
    pass ``constraints=DelegationConstraints(max_hops=2)`` (or more) when the
    child must re-delegate or sub-narrow. ``none`` spawns the child explicitly
    edge-less, suppressing server-side inheritance.
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


@dataclass
class _Session:
    agent_session_id: str
    ctx: CaracalContext
    subject_token: str
    heartbeat_deadline_at: str | None


async def _establish_session(
    *,
    coordinator: CoordinatorClient,
    zone_id: str,
    application_id: str,
    subject_token: str,
    token_source: TokenSource | None,
    invalidate: Callable[[], None] | None,
    subject_session_id: str | None,
    parent_id: str | None,
    parent_ctx: CaracalContext | None,
    grant: Grant | None,
    ttl_seconds: int | None,
    metadata: JsonObject | None,
    labels: list[str] | None,
    trace_id: str | None,
    lifecycle: Lifecycle | None = None,
) -> _Session:
    grant = grant or Grant.inherit()
    parent = parent_ctx if parent_ctx is not None else current()
    parent_agent_session_id = parent_id or (parent.agent_session_id if parent else None)
    bearer = subject_token

    # A narrowing (or none) grant suppresses server-side edge inheritance: the
    # child must hold exactly the granted slice, not a mirrored copy of the
    # parent's wider edge alongside it.
    req = SpawnRequest(
        zone_id=zone_id,
        application_id=application_id,
        subject_session_id=subject_session_id,
        parent_id=parent_agent_session_id,
        lifecycle=lifecycle,
        ttl_seconds=ttl_seconds,
        metadata=metadata,
        labels=labels,
        idempotency_key=uuid.uuid4().hex,
        parent_authority="inherit" if grant.mode == "inherit" else "none",
    )
    refreshed = False
    attempt = 0
    while True:
        try:
            res = await spawn_agent(coordinator, bearer, req)
            break
        except CoordinatorError as exc:
            # A cached token can be rejected before its exp (server-side
            # session revocation after a credential rotation); force one
            # refresh and retry the spawn once.
            if (
                exc.status == 401
                and not refreshed
                and invalidate is not None
                and token_source is not None
            ):
                refreshed = True
                invalidate()
                bearer = await _resolve_bearer(token_source, subject_token)
                continue
            # The idempotency key makes retrying a 5xx safe: the coordinator
            # replays the already-created session instead of minting a
            # duplicate.
            if exc.status < 500 or attempt >= _SPAWN_RETRIES:
                raise
            attempt += 1
            await asyncio.sleep(0.25 * attempt + random.random() * 0.1)
        except httpx.TransportError:
            if attempt >= _SPAWN_RETRIES:
                raise
            attempt += 1
            await asyncio.sleep(0.25 * attempt + random.random() * 0.1)

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
        own_token=True,
    )
    return _Session(res.agent_session_id, ctx, bearer, res.heartbeat_deadline_at)


@asynccontextmanager
async def spawn(
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
    on_agent_start: LifecycleHook | None = None,
    on_agent_end: LifecycleHook | None = None,
) -> AsyncGenerator[CaracalContext, None]:
    """Spawn a child agent session and bind it to the current task.

    By default the coordinator carries the parent's effective authority forward
    by mirroring its active narrowing edge onto the child, so a child of a
    narrowed parent stays narrowed (transitive least-privilege) and a child of
    an edge-less parent runs edge-less under the application's policy-bounded
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
    session = await _establish_session(
        coordinator=coordinator,
        zone_id=zone_id,
        application_id=application_id,
        subject_token=subject_token,
        token_source=token_source,
        invalidate=invalidate,
        subject_session_id=subject_session_id,
        parent_id=parent_id,
        parent_ctx=parent_ctx,
        grant=grant,
        ttl_seconds=ttl_seconds,
        metadata=metadata,
        labels=labels,
        trace_id=trace_id,
    )
    ctx = session.ctx

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
                session.agent_session_id,
                token_source=token_source,
                fallback_token=session.subject_token,
            )


class ServiceAgent:
    """Handle for a long-lived service agent session. Unlike :func:`spawn`,
    a service session is not terminated automatically: a background task
    renews the lease by default and the holder retires the session with
    :meth:`aclose`.

    With ``heartbeat_interval`` unset the renewal cadence is derived from the
    server lease (renewing at roughly a third of the remaining lease, with
    jitter); a positive value fixes the cadence, and zero or a negative value
    disables the background task, leaving the lease to manual
    :meth:`heartbeat` calls. The renewal runs on its own loop iteration, so
    the lease keeps advancing even while the calling coroutine is awaiting a
    long provider/resource stream. A transient renewal error is logged and
    retried; if the coordinator reports the session permanently gone the task
    stops and ``on_lease_lost`` fires once."""

    def __init__(
        self,
        *,
        coordinator: CoordinatorClient,
        subject_token: str,
        context: CaracalContext,
        heartbeat_interval: float | None = None,
        token_source: TokenSource | None = None,
        invalidate: Callable[[], None] | None = None,
        heartbeat_deadline_at: str | None = None,
        on_lease_lost: Callable[[BaseException], None] | None = None,
        on_agent_end: LifecycleHook | None = None,
    ) -> None:
        self.context = context
        self.heartbeat_deadline_at = heartbeat_deadline_at
        self._coordinator = coordinator
        self._subject_token = subject_token
        self._heartbeat_interval = heartbeat_interval
        self._token_source = token_source
        self._invalidate = invalidate
        self._on_lease_lost = on_lease_lost
        self._on_agent_end = on_agent_end
        self._refresh_lock = asyncio.Lock()
        self._auto_task: asyncio.Task[None] | None = None
        self._closing: asyncio.Task[None] | None = None

    @property
    def agent_session_id(self) -> str:
        return self.context.agent_session_id

    async def _bearer(self) -> str:
        return await _resolve_bearer(self._token_source, self._subject_token)

    async def heartbeat(self, status: str = "healthy") -> None:
        bearer = await self._bearer()
        try:
            res = await heartbeat_agent(
                self._coordinator,
                bearer,
                self.context.zone_id,
                self.context.agent_session_id,
                status,
            )
        except CoordinatorError as exc:
            # A cached token can be rejected before its exp (server-side
            # session revocation after a credential rotation); force one
            # refresh and retry so the lease survives the rotation. The lock
            # single-flights the refresh so concurrent beats do not each
            # invalidate the cache and stampede the token endpoint: only the
            # beat that still sees the rejected bearer invalidates it.
            if exc.status != 401 or self._invalidate is None:
                raise
            async with self._refresh_lock:
                fresh = await self._bearer()
                if fresh == bearer:
                    self._invalidate()
                    fresh = await self._bearer()
            res = await heartbeat_agent(
                self._coordinator,
                fresh,
                self.context.zone_id,
                self.context.agent_session_id,
                status,
            )
        if res.heartbeat_deadline_at:
            self.heartbeat_deadline_at = res.heartbeat_deadline_at

    def _start_auto_heartbeat(self) -> None:
        if self._closing is not None or self._auto_task is not None:
            return
        if self._heartbeat_interval is not None and self._heartbeat_interval <= 0:
            return
        self._auto_task = asyncio.create_task(self._auto_heartbeat_loop())

    def _next_delay(self) -> float:
        if self._heartbeat_interval is not None:
            return self._heartbeat_interval
        jitter = 0.9 + random.random() * 0.2
        deadline = _parse_deadline(self.heartbeat_deadline_at)
        if deadline is None:
            return _FALLBACK_AUTO_HEARTBEAT * jitter
        remaining = deadline - time.time()
        return (
            min(max(remaining / 3, _MIN_AUTO_HEARTBEAT), _MAX_AUTO_HEARTBEAT) * jitter
        )

    async def _auto_heartbeat_loop(self) -> None:
        while True:
            await asyncio.sleep(self._next_delay())
            try:
                await self.heartbeat()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if _is_gone(exc):
                    # A beat racing aclose sees the session gone because close
                    # terminated it; that is an ordinary shutdown, not a lost
                    # lease.
                    if self._closing is not None:
                        return
                    logger.warning(
                        "lease lost for agent %s; auto-heartbeat stopped",
                        self.context.agent_session_id,
                        exc_info=True,
                    )
                    if self._on_lease_lost is not None:
                        self._on_lease_lost(exc)
                    return
                logger.warning(
                    "auto-heartbeat failed for agent %s; retrying next tick",
                    self.context.agent_session_id,
                    exc_info=True,
                )

    async def _close(self) -> None:
        if self._auto_task is not None:
            self._auto_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._auto_task
            self._auto_task = None
        try:
            if self._on_agent_end is not None:
                await self._on_agent_end(self.context)
        finally:
            await _terminate_shielded(
                self._coordinator,
                self.context.zone_id,
                self.context.agent_session_id,
                token_source=self._token_source,
                fallback_token=self._subject_token,
                propagate=True,
            )

    async def aclose(self) -> None:
        if self._closing is None:
            self._closing = asyncio.ensure_future(self._close())
        await asyncio.shield(self._closing)

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
    on_lease_lost: Callable[[BaseException], None] | None = None,
    on_agent_start: LifecycleHook | None = None,
    on_agent_end: LifecycleHook | None = None,
) -> ServiceAgent:
    """Spawn a long-lived service agent session and return a handle the caller
    owns. A background task renews the heartbeat lease by default; retire the
    session with :meth:`ServiceAgent.aclose`.

    Authority follows the same model as :func:`spawn`: the coordinator mirrors
    the parent's active narrowing edge onto the session by default, and
    ``grant=Grant.narrow([...])`` issues a bounded delegation edge so the
    handle holds only a subset.

    Leave ``heartbeat_interval`` unset to derive the renewal cadence from the
    server lease; pass a positive value to fix it, or zero to disable the
    background task and renew with :meth:`ServiceAgent.heartbeat` manually.
    ``on_lease_lost`` fires once if the coordinator reports the session
    permanently gone. ``on_agent_end`` runs inside :meth:`ServiceAgent.aclose`
    before the session terminates, mirroring :func:`spawn`'s end hook. With
    ``token_source`` set, every lease renewal and the final terminate resolve
    a fresh bearer, so the handle outlives the token minted at spawn."""
    session = await _establish_session(
        coordinator=coordinator,
        zone_id=zone_id,
        application_id=application_id,
        subject_token=subject_token,
        token_source=token_source,
        invalidate=invalidate,
        subject_session_id=subject_session_id,
        parent_id=parent_id,
        parent_ctx=parent_ctx,
        grant=grant,
        ttl_seconds=ttl_seconds,
        metadata=metadata,
        labels=labels,
        trace_id=trace_id,
        lifecycle=Lifecycle.SERVICE,
    )
    ctx = session.ctx
    if on_agent_start is not None:
        try:
            await on_agent_start(ctx)
        except (asyncio.CancelledError, Exception):
            await _terminate_shielded(
                coordinator,
                zone_id,
                session.agent_session_id,
                token_source=token_source,
                fallback_token=session.subject_token,
            )
            raise
    agent = ServiceAgent(
        coordinator=coordinator,
        subject_token=session.subject_token,
        context=ctx,
        heartbeat_interval=heartbeat_interval,
        token_source=token_source,
        invalidate=invalidate,
        heartbeat_deadline_at=session.heartbeat_deadline_at,
        on_lease_lost=on_lease_lost,
        on_agent_end=on_agent_end,
    )
    agent._start_auto_heartbeat()
    return agent


async def delegate(
    *,
    coordinator: CoordinatorClient,
    to_agent_session_id: str,
    to_application_id: str,
    scopes: list[str],
    resource_id: str | None = None,
    constraints: DelegationConstraints | None = None,
    ttl_seconds: int | None = None,
) -> DelegationResponse:
    """Create a delegation edge from the bound agent session to a peer.

    The caller is the issuer: its own context is unchanged, because issuing an
    edge grants authority to the receiver rather than to the issuer. The
    returned handle identifies the created edge; hand its
    ``delegation_edge_id`` to the receiving session, which presents the edge by
    deriving its context with :func:`adopt_delegation`.
    """
    ctx = current()
    if ctx is None or not ctx.agent_session_id:
        raise RuntimeError("delegate requires an active agent session in context")

    return await create_delegation(
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


def adopt_delegation(ctx: CaracalContext, delegation_edge_id: str) -> CaracalContext:
    """Derive a receiver context that presents the given delegation edge.

    The receiving session calls this with its own context and the edge id the
    issuer handed over; calls made under the derived context carry the edge's
    bounded authority. The source context is untouched.
    """
    return replace(
        ctx,
        parent_edge_id=ctx.delegation_edge_id,
        delegation_edge_id=delegation_edge_id,
        hop=ctx.hop + 1,
    )
