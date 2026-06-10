"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Agent lifecycle runner that binds every spawned swarm agent to its own Caracal session.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Callable
from uuid import uuid4

from app import caracal, tenancy
from app.events import types as ev
from app.events.bus import bus

log = logging.getLogger("lynx.runner")

SPAWN_TIMEOUT_SECONDS = 60.0


class AgentHandle:
    def __init__(
        self,
        id: str,
        role: str,
        scope: str,
        parent_id: str | None,
        layer: str,
        region: str | None,
        run_id: str,
        authority: caracal.WorkerAuthority | None = None,
    ) -> None:
        self.id = id
        self.role = role
        self.scope = scope
        self.parent_id = parent_id
        self.layer = layer
        self.region = region
        self.run_id = run_id
        self.authority = authority
        self.status = "spawned"
        self._terminated = False
        self._release: Callable[[], None] | None = None

    def start(self) -> None:
        self.status = "running"
        bus.publish(ev.agent_start(self.run_id, self.id))

    def end(self, result: dict | None = None) -> None:
        bus.publish(ev.agent_end(self.run_id, self.id, result))

    def terminate(self, status: str = "completed") -> None:
        if self._terminated:
            raise RuntimeError(f"Agent {self.id} already terminated.")
        self._terminated = True
        self.status = status
        bus.publish(ev.agent_terminate(self.run_id, self.id, status))
        if self._release is not None:
            self._release()


class _SessionKeeper:
    """Holds one Caracal session open, keeping the spawn context's enter and exit
    inside a single loop task so the SDK's context binding stays valid."""

    def __init__(self) -> None:
        self._done = asyncio.Event()
        self.task: asyncio.Task | None = None

    async def open(self, cm) -> caracal.CaracalContext:
        loop = asyncio.get_running_loop()
        ready: asyncio.Future = loop.create_future()
        self.task = loop.create_task(self._hold(cm, ready))
        return await ready

    async def _hold(self, cm, ready: asyncio.Future) -> None:
        try:
            async with cm as ctx:
                ready.set_result(ctx)
                await self._done.wait()
        except BaseException as exc:
            if not ready.done():
                ready.set_exception(exc)
            else:
                log.warning("caracal session close failed: %s", exc)

    def release(self, loop: asyncio.AbstractEventLoop) -> None:
        loop.call_soon_threadsafe(self._done.set)


class AgentRunner:
    """Spawns and retires the run's agents. Every agent gets a local handle for the
    event stream and, when Caracal is enabled, its own labeled agent session: workers
    under their application's per-run root with a delegation edge narrowed to the
    role's scopes and views, orchestrators under the operations boundary."""

    def __init__(self, run_id: str) -> None:
        self.run_id = run_id
        self._handles: dict[str, AgentHandle] = {}
        self._children: dict[str, list[str]] = {}
        self._loop: asyncio.AbstractEventLoop | None = None
        self._keepers: list[_SessionKeeper] = []
        self._roots: dict[str, caracal.CaracalContext] = {}
        self._root_lock = asyncio.Lock()

    async def aspawn(
        self,
        role: str,
        scope: str,
        parent: AgentHandle | None,
        layer: str,
        region: str | None = None,
    ) -> AgentHandle:
        if self._loop is None:
            self._loop = asyncio.get_running_loop()
        agent_id = str(uuid4())
        parent_id = parent.id if parent else None
        authority: caracal.WorkerAuthority | None = None
        release: Callable[[], None] | None = None
        if caracal.enabled():
            authority, release = await self._open_session(role, scope, parent, agent_id, region)

        handle = AgentHandle(
            id=agent_id,
            role=role,
            scope=scope,
            parent_id=parent_id,
            layer=layer,
            region=region,
            run_id=self.run_id,
            authority=authority,
        )
        handle._release = release
        self._handles[agent_id] = handle
        if parent_id:
            self._children.setdefault(parent_id, []).append(agent_id)

        bus.publish(ev.agent_spawn(self.run_id, agent_id, role, scope, parent_id, layer, region))
        if parent_id:
            bus.publish(ev.delegation(self.run_id, parent_id, agent_id, scope))
        return handle

    def spawn(
        self,
        role: str,
        scope: str,
        parent: AgentHandle | None,
        layer: str,
        region: str | None = None,
    ) -> AgentHandle:
        """Thread-safe spawn for tools running in executor threads. On the loop thread
        use aspawn; a blocking wait there would deadlock the run."""
        if not caracal.enabled():
            return self._local_spawn(role, scope, parent, layer, region)
        if self._loop is None:
            raise RuntimeError("AgentRunner has no loop; spawn the run root with aspawn first")
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is self._loop:
            raise RuntimeError("spawn called on the run loop; use aspawn")
        future = asyncio.run_coroutine_threadsafe(
            self.aspawn(role, scope, parent, layer, region), self._loop,
        )
        return future.result(timeout=SPAWN_TIMEOUT_SECONDS)

    def _local_spawn(
        self,
        role: str,
        scope: str,
        parent: AgentHandle | None,
        layer: str,
        region: str | None,
    ) -> AgentHandle:
        agent_id = str(uuid4())
        parent_id = parent.id if parent else None
        handle = AgentHandle(
            id=agent_id, role=role, scope=scope, parent_id=parent_id,
            layer=layer, region=region, run_id=self.run_id,
        )
        self._handles[agent_id] = handle
        if parent_id:
            self._children.setdefault(parent_id, []).append(agent_id)
        bus.publish(ev.agent_spawn(self.run_id, agent_id, role, scope, parent_id, layer, region))
        if parent_id:
            bus.publish(ev.delegation(self.run_id, parent_id, agent_id, scope))
        return handle

    async def _open_session(
        self,
        role: str,
        scope: str,
        parent: AgentHandle | None,
        agent_id: str,
        region: str | None,
    ) -> tuple[caracal.WorkerAuthority | None, Callable[[], None] | None]:
        model = tenancy.load_model()
        spec = model.role(role)
        if spec.dynamic:
            plan = self._partner_plan(scope)
            if plan is None:
                return None, None
            app_key, scopes, views = plan
        else:
            app_key, scopes, views = spec.application, list(spec.scopes), tenancy.role_views(role, model)

        runtime = caracal.runtime(app_key)
        if parent is not None and parent.authority is not None and parent.authority.application == app_key:
            parent_ctx = parent.authority.ctx
        elif parent is None and not scopes:
            parent_ctx = None
        else:
            parent_ctx = await self._root(app_key)

        grant = caracal.worker_grant(scopes, views) if scopes else None
        keeper = _SessionKeeper()
        ctx = await keeper.open(runtime.client.spawn(
            grant=grant,
            labels=tenancy.agent_labels(role),
            metadata=tenancy.agent_metadata(self.run_id, agent_id, scope, region),
            parent_ctx=parent_ctx,
            ttl_seconds=caracal.WORKER_TTL_SECONDS,
            trace_id=self.run_id,
        ))
        self._keepers.append(keeper)
        loop = self._loop
        return caracal.WorkerAuthority(runtime, ctx, role, scopes), lambda: keeper.release(loop)

    def _partner_plan(self, scope: str) -> tuple[str, list[str], list[str]] | None:
        """Resolve a dynamic partner-integration spawn from its work scope, shaped
        partner:<provider-id>:<operation>."""
        parts = scope.split(":", 2)
        if len(parts) != 3 or parts[0] != "partner":
            return None
        plan = tenancy.partner_plan(parts[1], parts[2])
        if plan is None:
            return None
        app_key, op_scope, view = plan
        return app_key, [op_scope], [view]

    async def _root(self, app_key: str) -> caracal.CaracalContext:
        """The application's per-run dispatcher session that workers spawn under; spawn
        cannot cross application boundaries, so each boundary roots its own subtree."""
        async with self._root_lock:
            ctx = self._roots.get(app_key)
            if ctx is not None:
                return ctx
            runtime = caracal.runtime(app_key)
            keeper = _SessionKeeper()
            ctx = await keeper.open(runtime.client.spawn(
                labels=["dispatcher", "lynx-swarm"],
                metadata={"run_id": self.run_id, "application": app_key},
                trace_id=self.run_id,
            ))
            self._keepers.append(keeper)
            self._roots[app_key] = ctx
            return ctx

    async def aclose(self) -> None:
        """Retire every Caracal session the run opened, workers and roots alike."""
        loop = asyncio.get_running_loop()
        tasks = []
        for keeper in self._keepers:
            keeper.release(loop)
            if keeper.task is not None:
                tasks.append(keeper.task)
        self._keepers.clear()
        self._roots.clear()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def cancel_subtree(self, agent_id: str) -> None:
        for child_id in list(self._children.get(agent_id, [])):
            self.cancel_subtree(child_id)
        handle = self._handles.get(agent_id)
        if handle and not handle._terminated:
            handle.terminate("cancelled")

    def handle(self, agent_id: str) -> AgentHandle | None:
        return self._handles.get(agent_id)

    def all_handles(self) -> list[AgentHandle]:
        return list(self._handles.values())


_runners: dict[str, AgentRunner] = {}


def create_runner(run_id: str) -> AgentRunner:
    runner = AgentRunner(run_id)
    _runners[run_id] = runner
    return runner


def get_runner(run_id: str) -> AgentRunner | None:
    return _runners.get(run_id)
