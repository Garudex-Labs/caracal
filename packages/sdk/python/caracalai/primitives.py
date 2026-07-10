"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SDK primitives: run governed sessions, delegate authority, and accept delegations.
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
    StartSessionRequest,
    create_delegation,
    heartbeat_session,
    start_coordinator_session,
    terminate_session,
)
from .errors import CoordinatorError
from .json_types import JsonObject

logger = logging.getLogger("caracalai")

LifecycleHook = Callable[[CaracalContext], Awaitable[None]]

_SESSION_RETRIES = 2
_MIN_AUTO_HEARTBEAT = 1.0
_MAX_AUTO_HEARTBEAT = 300.0
_FALLBACK_AUTO_HEARTBEAT = 30.0
# A server-requested Retry-After wins over the default backoff, capped so a
# hostile or misconfigured header cannot stall the caller for minutes.
_RETRY_AFTER_CAP_SECONDS = 10.0


def _retry_delay(attempt: int, exc: BaseException) -> float:
    hinted = getattr(exc, "retry_after_seconds", None)
    if hinted is not None:
        return min(hinted, _RETRY_AFTER_CAP_SECONDS) + random.random() * 0.1
    return 0.25 * (attempt + 1) + random.random() * 0.1


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
    session_id: str,
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
            await terminate_session(coordinator, bearer, zone_id, session_id)
        except Exception as exc:
            if _is_gone(exc):
                return
            if propagate:
                raise
            logger.warning(
                "terminate failed for session %s; the coordinator TTL sweeper will retire it",
                session_id,
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
                        "terminate for session %s failed after caller cancellation",
                        session_id,
                        exc_info=task.exception(),
                    )

            cleanup.add_done_callback(log_result)
        raise


@dataclass(frozen=True)
class Authority:
    """Authority handed to a child session.

    ``inherit`` (the default) carries the parent's effective authority forward:
    the coordinator resolves the parent's active narrowing delegation
    server-side and mirrors it onto the child, so least-privilege is transitive
    by default. A parent that holds no delegation yields a child running under
    the application's policy-bounded authority; the platform decision contract
    mints resource mandates only over a delegation, so a delegation-less
    session cannot present delegated authority. Inheritance never crosses an
    application boundary. ``narrow`` issues a bounded delegation so the child
    holds only the listed scopes; the server re-validates the subset, so a
    narrow can never broaden. A narrowing delegation defaults to a hop budget
    of 1; pass ``constraints=DelegationConstraints(max_hops=2)`` (or more) when
    the child must re-delegate or sub-narrow. ``none`` starts the child
    explicitly delegation-less, suppressing server-side inheritance.
    """

    mode: str = "inherit"
    scopes: tuple[str, ...] = ()
    resource_id: str | None = None
    constraints: DelegationConstraints | None = None
    ttl_seconds: int | None = None

    @staticmethod
    def inherit() -> Authority:
        return Authority(mode="inherit")

    @staticmethod
    def none() -> Authority:
        return Authority(mode="none")

    @staticmethod
    def narrow(
        scopes: list[str] | str,
        *,
        resource_id: str | None = None,
        constraints: DelegationConstraints | None = None,
        ttl_seconds: int | None = None,
    ) -> Authority:
        return Authority(
            mode="narrow",
            scopes=(scopes,) if isinstance(scopes, str) else tuple(scopes),
            resource_id=resource_id,
            constraints=constraints,
            ttl_seconds=ttl_seconds,
        )


@dataclass
class _Established:
    session_id: str
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
    subject_authority_record_id: str | None,
    parent_id: str | None,
    parent_ctx: CaracalContext | None,
    authority: Authority | None,
    ttl_seconds: int | None,
    metadata: JsonObject | None,
    labels: list[str] | None,
    trace_id: str | None,
    idempotency_key: str | None = None,
    lifecycle: Lifecycle | None = None,
) -> _Established:
    if idempotency_key is not None:
        _validate_idempotency_key(idempotency_key)
    authority = authority or Authority.inherit()
    parent = parent_ctx if parent_ctx is not None else current()
    parent_session_id = parent_id or (parent.session_id if parent else None)
    bearer = subject_token

    # Narrowed (or none) authority suppresses server-side inheritance: the
    # child must hold exactly the granted slice, not a mirrored copy of the
    # parent's wider delegation alongside it.
    req = StartSessionRequest(
        zone_id=zone_id,
        application_id=application_id,
        subject_authority_record_id=subject_authority_record_id,
        parent_id=parent_session_id,
        lifecycle=lifecycle,
        ttl_seconds=ttl_seconds,
        metadata=metadata,
        labels=labels,
        idempotency_key=idempotency_key or uuid.uuid4().hex,
        idempotency_key_generated=idempotency_key is None,
        parent_authority="inherit" if authority.mode == "inherit" else "none",
    )
    refreshed = False
    attempt = 0
    while True:
        try:
            res = await start_coordinator_session(coordinator, bearer, req)
            break
        except CoordinatorError as exc:
            # A cached token can be rejected before its exp (server-side
            # session revocation after a credential rotation); force one
            # refresh and retry the Session start once. The jittered pause spreads
            # the refresh across a fleet so a mass revocation cannot
            # stampede the STS.
            if (
                exc.status == 401
                and not refreshed
                and invalidate is not None
                and token_source is not None
            ):
                refreshed = True
                invalidate()
                await asyncio.sleep(random.random() * 0.25)
                bearer = await _resolve_bearer(token_source, subject_token)
                continue
            # The idempotency key makes retrying a 5xx safe: the coordinator
            # replays the already-created session instead of minting a
            # duplicate.
            if exc.status < 500 or attempt >= _SESSION_RETRIES:
                raise
            await asyncio.sleep(_retry_delay(attempt, exc))
            attempt += 1
        except httpx.TransportError:
            if attempt >= _SESSION_RETRIES:
                raise
            attempt += 1
            await asyncio.sleep(0.25 * attempt + random.random() * 0.1)

    delegation_id: str | None = res.delegation_id
    hop = (
        parent.hop + 1
        if (delegation_id is not None and parent is not None)
        else (parent.hop if parent else 0)
    )
    try:
        if authority.mode == "narrow":
            if parent is None or not parent.session_id:
                raise RuntimeError("authority=narrow requires an active parent session")
            deleg = await create_delegation(
                coordinator,
                parent.subject_token,
                DelegationRequest(
                    zone_id=zone_id,
                    issuer_application_id=parent.application_id,
                    source_session_id=parent.session_id,
                    target_session_id=res.session_id,
                    receiver_application_id=application_id,
                    parent_edge_id=parent.delegation_id,
                    resource_id=authority.resource_id,
                    scopes=list(authority.scopes),
                    constraints=authority.constraints,
                    ttl_seconds=authority.ttl_seconds,
                ),
            )
            delegation_id = deleg.delegation_id
            hop = parent.hop + 1
    except (asyncio.CancelledError, Exception):
        await _terminate_shielded(
            coordinator,
            zone_id,
            res.session_id,
            token_source=token_source,
            fallback_token=bearer,
        )
        raise

    ctx = CaracalContext(
        subject_token=bearer,
        zone_id=zone_id,
        application_id=application_id,
        session_id=res.session_id,
        delegation_id=delegation_id,
        parent_delegation_id=parent.delegation_id if parent else None,
        subject_authority_record_id=subject_authority_record_id
        or (parent.subject_authority_record_id if parent else None),
        trace_id=trace_id or (parent.trace_id if parent else None),
        trace_flags=parent.trace_flags if parent else None,
        trace_state=parent.trace_state if parent else None,
        baggage=parent.baggage if parent else (),
        hop=hop,
        own_token=True,
    )
    return _Established(res.session_id, ctx, bearer, res.heartbeat_deadline_at)


def _validate_idempotency_key(key: str) -> None:
    if (
        not key
        or key != key.strip()
        or len(key.encode("utf-8")) > 255
        or any(ord(char) < 32 or ord(char) == 127 for char in key)
    ):
        raise ValueError(
            "idempotency_key must be non-empty, at most 255 UTF-8 bytes, and "
            "contain no surrounding whitespace or control characters"
        )


@asynccontextmanager
async def session(
    *,
    coordinator: CoordinatorClient,
    zone_id: str,
    application_id: str,
    subject_token: str,
    token_source: TokenSource | None = None,
    invalidate: Callable[[], None] | None = None,
    subject_authority_record_id: str | None = None,
    parent_session_id: str | None = None,
    parent_ctx: CaracalContext | None = None,
    authority: Authority | None = None,
    ttl_seconds: int | None = None,
    metadata: JsonObject | None = None,
    labels: list[str] | None = None,
    trace_id: str | None = None,
    idempotency_key: str | None = None,
    on_session_start: LifecycleHook | None = None,
    on_session_end: LifecycleHook | None = None,
) -> AsyncGenerator[CaracalContext, None]:
    """Run the block inside a governed session bound to the current task.

    The session is a bounded identity Caracal establishes around whatever the
    block executes - an AI agent step, a job, a tool call, any code. By
    default the coordinator carries the parent's effective authority forward
    by mirroring its active narrowing delegation onto the child, so a child of
    a narrowed parent stays narrowed (transitive least-privilege) and a child
    of a delegation-less parent runs under the application's policy-bounded
    authority. Pass ``authority=Authority.narrow([...])`` to issue a bounded
    delegation so the child holds only a subset. ``parent_ctx`` overrides the
    bound :func:`current` lookup; pass it explicitly when the orchestrator
    owns the parent context but the session starts on a different task
    (asyncio TaskGroup, thread pool, framework worker) where the parent's
    contextvar is not visible.

    Session scopes bind via a contextvar and must nest: exit them in reverse
    order of entry on any given task. Cleanup terminates the session with a
    fresh bearer from ``token_source`` when one is provided, so a token that
    expired while the body ran cannot strand the session.
    """
    established = await _establish_session(
        coordinator=coordinator,
        zone_id=zone_id,
        application_id=application_id,
        subject_token=subject_token,
        token_source=token_source,
        invalidate=invalidate,
        subject_authority_record_id=subject_authority_record_id,
        parent_id=parent_session_id,
        parent_ctx=parent_ctx,
        authority=authority,
        ttl_seconds=ttl_seconds,
        metadata=metadata,
        labels=labels,
        trace_id=trace_id,
        idempotency_key=idempotency_key,
    )
    ctx = established.ctx

    token = None
    started = False
    try:
        if on_session_start is not None:
            await on_session_start(ctx)
        started = True
        token = _ctx_var.set(ctx)
        yield ctx
    finally:
        if token is not None:
            _ctx_var.reset(token)
        try:
            if started and on_session_end is not None:
                await on_session_end(ctx)
        finally:
            await _terminate_shielded(
                coordinator,
                zone_id,
                established.session_id,
                token_source=token_source,
                fallback_token=established.subject_token,
            )


class SessionHandle:
    """Handle for a long-lived session started with :func:`start_session`.
    Unlike :func:`session`, it is not terminated automatically when a block
    exits: a background task renews the lease by default and the holder
    retires the session with :meth:`aclose`.

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
        status: str = "active",
        on_lease_lost: Callable[[BaseException], None] | None = None,
        on_state_change: Callable[[str], None] | None = None,
        on_session_end: LifecycleHook | None = None,
    ) -> None:
        self.context = context
        self.heartbeat_deadline_at = heartbeat_deadline_at
        self._coordinator = coordinator
        self._subject_token = subject_token
        self._heartbeat_interval = heartbeat_interval
        self._token_source = token_source
        self._invalidate = invalidate
        self._on_lease_lost = on_lease_lost
        self._on_state_change = on_state_change
        self._status = status
        self._on_session_end = on_session_end
        self._refresh_lock = asyncio.Lock()
        self._auto_task: asyncio.Task[None] | None = None
        self._closing: asyncio.Task[None] | None = None

    @property
    def session_id(self) -> str:
        return self.context.session_id

    @property
    def status(self) -> str:
        return self._status

    async def _bearer(self) -> str:
        return await _resolve_bearer(self._token_source, self._subject_token)

    async def heartbeat(self, status: str = "healthy") -> None:
        bearer = await self._bearer()
        try:
            res = await heartbeat_session(
                self._coordinator,
                bearer,
                self.context.zone_id,
                self.context.session_id,
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
            res = await heartbeat_session(
                self._coordinator,
                fresh,
                self.context.zone_id,
                self.context.session_id,
                status,
            )
        if res.heartbeat_deadline_at:
            self.heartbeat_deadline_at = res.heartbeat_deadline_at
        if res.status and res.status != self._status:
            self._status = res.status
            if self._on_state_change is not None:
                try:
                    self._on_state_change(self._status)
                except Exception:
                    logger.warning(
                        "state-change callback failed for session %s",
                        self.context.session_id,
                        exc_info=True,
                    )
        if self._status == "suspended" and self._auto_task is not None:
            self._auto_task.cancel()

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
                        "lease lost for session %s; auto-heartbeat stopped",
                        self.context.session_id,
                        exc_info=True,
                    )
                    if self._on_lease_lost is not None:
                        self._on_lease_lost(exc)
                    return
                logger.warning(
                    "auto-heartbeat failed for session %s; retrying next tick",
                    self.context.session_id,
                    exc_info=True,
                )

    async def _close(self) -> None:
        if self._auto_task is not None:
            self._auto_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._auto_task
            self._auto_task = None
        try:
            if self._on_session_end is not None:
                await self._on_session_end(self.context)
        finally:
            await _terminate_shielded(
                self._coordinator,
                self.context.zone_id,
                self.context.session_id,
                token_source=self._token_source,
                fallback_token=self._subject_token,
                propagate=True,
            )

    async def aclose(self) -> None:
        if self._closing is None:
            self._closing = asyncio.ensure_future(self._close())
        await asyncio.shield(self._closing)

    async def __aenter__(self) -> SessionHandle:
        self._start_auto_heartbeat()
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()


async def start_session(
    *,
    coordinator: CoordinatorClient,
    zone_id: str,
    application_id: str,
    subject_token: str,
    token_source: TokenSource | None = None,
    invalidate: Callable[[], None] | None = None,
    subject_authority_record_id: str | None = None,
    parent_session_id: str | None = None,
    parent_ctx: CaracalContext | None = None,
    authority: Authority | None = None,
    ttl_seconds: int | None = None,
    metadata: JsonObject | None = None,
    labels: list[str] | None = None,
    trace_id: str | None = None,
    idempotency_key: str | None = None,
    heartbeat_interval: float | None = None,
    on_lease_lost: Callable[[BaseException], None] | None = None,
    on_state_change: Callable[[str], None] | None = None,
    on_session_start: LifecycleHook | None = None,
    on_session_end: LifecycleHook | None = None,
) -> SessionHandle:
    """Start a governed session that outlives a block and return a handle the
    caller owns. A background task renews the heartbeat lease by default;
    retire the session with :meth:`SessionHandle.aclose`.

    Authority follows the same model as :func:`session`: the coordinator
    mirrors the parent's active narrowing delegation onto the session by
    default, and ``authority=Authority.narrow([...])`` issues a bounded
    delegation so the handle holds only a subset.

    Leave ``heartbeat_interval`` unset to derive the renewal cadence from the
    server lease; pass a positive value to fix it, or zero to disable the
    background task and renew with :meth:`SessionHandle.heartbeat` manually.
    ``on_lease_lost`` fires once if the coordinator reports the session
    permanently gone. ``on_session_end`` runs inside
    :meth:`SessionHandle.aclose` before the session terminates, mirroring
    :func:`session`'s end hook. With ``token_source`` set, every lease renewal
    and the final terminate resolve a fresh bearer, so the handle outlives the
    token minted at start."""
    established = await _establish_session(
        coordinator=coordinator,
        zone_id=zone_id,
        application_id=application_id,
        subject_token=subject_token,
        token_source=token_source,
        invalidate=invalidate,
        subject_authority_record_id=subject_authority_record_id,
        parent_id=parent_session_id,
        parent_ctx=parent_ctx,
        authority=authority,
        ttl_seconds=ttl_seconds,
        metadata=metadata,
        labels=labels,
        trace_id=trace_id,
        idempotency_key=idempotency_key,
        lifecycle=Lifecycle.SERVICE,
    )
    ctx = established.ctx
    if on_session_start is not None:
        try:
            await on_session_start(ctx)
        except (asyncio.CancelledError, Exception):
            await _terminate_shielded(
                coordinator,
                zone_id,
                established.session_id,
                token_source=token_source,
                fallback_token=established.subject_token,
            )
            raise
    handle = SessionHandle(
        coordinator=coordinator,
        subject_token=established.subject_token,
        context=ctx,
        heartbeat_interval=heartbeat_interval,
        token_source=token_source,
        invalidate=invalidate,
        heartbeat_deadline_at=established.heartbeat_deadline_at,
        on_lease_lost=on_lease_lost,
        on_state_change=on_state_change,
        on_session_end=on_session_end,
    )
    handle._start_auto_heartbeat()
    return handle


async def attach_session(
    *,
    coordinator: CoordinatorClient,
    zone_id: str,
    application_id: str,
    subject_token: str,
    session_id: str,
    token_source: TokenSource | None = None,
    invalidate: Callable[[], None] | None = None,
    heartbeat_interval: float | None = None,
    on_lease_lost: Callable[[BaseException], None] | None = None,
    on_state_change: Callable[[str], None] | None = None,
    on_session_end: LifecycleHook | None = None,
) -> SessionHandle:
    """Re-attach to a service session that already exists - typically after a
    process restart, using a session id the previous holder persisted. The
    session is validated with an immediate lease renewal (a session the
    coordinator no longer holds live fails with :class:`CoordinatorError`),
    and the returned handle renews and retires it exactly like one from
    :func:`start_session`. The rebuilt context carries the session identity
    only; delegations bound by the previous holder are re-presented with
    :func:`accept_delegation`."""
    bearer = await _resolve_bearer(token_source, subject_token)
    try:
        first = await heartbeat_session(coordinator, bearer, zone_id, session_id)
    except CoordinatorError as exc:
        if exc.status != 401 or invalidate is None or token_source is None:
            raise
        invalidate()
        bearer = await _resolve_bearer(token_source, subject_token)
        first = await heartbeat_session(coordinator, bearer, zone_id, session_id)
    ctx = CaracalContext(
        subject_token=bearer,
        zone_id=zone_id,
        application_id=application_id,
        session_id=session_id,
        hop=0,
        own_token=True,
    )
    handle = SessionHandle(
        coordinator=coordinator,
        subject_token=bearer,
        context=ctx,
        heartbeat_interval=heartbeat_interval,
        token_source=token_source,
        invalidate=invalidate,
        heartbeat_deadline_at=first.heartbeat_deadline_at,
        status=first.status or "active",
        on_lease_lost=on_lease_lost,
        on_state_change=on_state_change,
        on_session_end=on_session_end,
    )
    handle._start_auto_heartbeat()
    return handle


@dataclass(frozen=True)
class Delegation:
    """A delegation issued to a peer session: its id, the scopes it carries,
    and when it expires."""

    delegation_id: str
    scopes: tuple[str, ...]
    expires_at: str | None


async def delegate(
    *,
    coordinator: CoordinatorClient,
    to_session_id: str,
    to_application_id: str,
    scopes: list[str],
    resource_id: str | None = None,
    constraints: DelegationConstraints | None = None,
    ttl_seconds: int | None = None,
) -> Delegation:
    """Delegate a slice of the bound session's authority to a peer session.

    The caller is the issuer: its own context is unchanged, because a
    delegation grants authority to the receiver rather than to the issuer.
    The returned handle identifies the created delegation; hand its
    ``delegation_id`` to the receiving session, which presents it by deriving
    its context with :func:`accept_delegation`.
    """
    ctx = current()
    if ctx is None or not ctx.session_id:
        raise RuntimeError("delegate requires an active session in context")

    req = DelegationRequest(
        zone_id=ctx.zone_id,
        issuer_application_id=ctx.application_id,
        source_session_id=ctx.session_id,
        target_session_id=to_session_id,
        receiver_application_id=to_application_id,
        parent_edge_id=ctx.delegation_id,
        resource_id=resource_id,
        scopes=scopes,
        constraints=constraints,
        ttl_seconds=ttl_seconds,
        idempotency_key=uuid.uuid4().hex,
    )
    # The idempotency key makes one retry of a transient failure safe: the
    # coordinator replays the already-created edge instead of issuing a
    # duplicate delegation.
    attempt = 0
    while True:
        try:
            res = await create_delegation(coordinator, ctx.subject_token, req)
            break
        except CoordinatorError as exc:
            if exc.status < 500 or attempt >= 1:
                raise
            await asyncio.sleep(_retry_delay(0, exc))
            attempt += 1
        except httpx.TransportError:
            if attempt >= 1:
                raise
            attempt += 1
            await asyncio.sleep(0.25 + random.random() * 0.1)
    return Delegation(
        delegation_id=res.delegation_id,
        scopes=tuple(res.scopes),
        expires_at=res.expires_at,
    )


def accept_delegation(ctx: CaracalContext, delegation_id: str) -> CaracalContext:
    """Derive a receiver context that presents the given delegation.

    The receiving session calls this with its own context and the delegation
    id the issuer handed over; calls made under the derived context carry the
    delegation's bounded authority. The source context is untouched.
    """
    return replace(
        ctx,
        parent_delegation_id=ctx.delegation_id,
        delegation_id=delegation_id,
        hop=ctx.hop + 1,
    )
