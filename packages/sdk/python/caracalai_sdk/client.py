"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal: drop-in bound client wrapping zone, application, subject token, and coordinator.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, AsyncGenerator, Awaitable, Callable, Mapping
from urllib.parse import urlparse, urlunparse

import httpx

from .context import (
    CaracalContext,
    _ctx_var,
    current,
    from_envelope,
    to_envelope,
)
from .coordinator import AgentKind, CoordinatorClient, DelegationConstraints
from .envelope import decode_envelope, to_headers
from .primitives import LifecycleHook, delegate, spawn

if TYPE_CHECKING:
    from .http import ASGIApp, CaracalASGIMiddleware


@dataclass
class ResourceBinding:
    resource_id: str
    upstream_prefix: str


@dataclass
class CaracalConfig:
    coordinator: CoordinatorClient
    zone_id: str
    application_id: str
    subject_token: str
    gateway_url: str | None = None
    resources: list[ResourceBinding] = field(default_factory=list)
    default_kind: AgentKind = AgentKind.INSTANCE
    default_ttl_seconds: int | None = None


def _parse_resource_bindings(raw: str | None) -> list[ResourceBinding]:
    if not raw:
        return []
    out: list[ResourceBinding] = []
    for entry in raw.split(","):
        trimmed = entry.strip()
        if not trimmed:
            continue
        idx = trimmed.find("=")
        if idx <= 0:
            continue
        rid = trimmed[:idx].strip()
        prefix = trimmed[idx + 1 :].strip()
        if rid and prefix:
            out.append(ResourceBinding(resource_id=rid, upstream_prefix=prefix))
    return out


class Caracal:
    def __init__(self, config: CaracalConfig) -> None:
        self.config = config
        self._agent_start_hooks: list[LifecycleHook] = []
        self._agent_end_hooks: list[LifecycleHook] = []

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Caracal":
        e = env if env is not None else os.environ
        required = {
            "CARACAL_COORDINATOR_URL": e.get("CARACAL_COORDINATOR_URL"),
            "CARACAL_ZONE_ID": e.get("CARACAL_ZONE_ID"),
            "CARACAL_APPLICATION_ID": e.get("CARACAL_APPLICATION_ID"),
            "CARACAL_SUBJECT_TOKEN": e.get("CARACAL_SUBJECT_TOKEN"),
        }
        missing = [k for k, v in required.items() if not v]
        if missing:
            raise RuntimeError(f"Caracal.from_env: missing {', '.join(missing)}")
        return cls(
            CaracalConfig(
                coordinator=CoordinatorClient(base_url=required["CARACAL_COORDINATOR_URL"]),
                zone_id=required["CARACAL_ZONE_ID"],
                application_id=required["CARACAL_APPLICATION_ID"],
                subject_token=required["CARACAL_SUBJECT_TOKEN"],
                gateway_url=e.get("CARACAL_GATEWAY_URL") or None,
                resources=_parse_resource_bindings(e.get("CARACAL_RESOURCES")),
            )
        )

    def on_agent_start(self, cb: LifecycleHook) -> None:
        self._agent_start_hooks.append(cb)

    def on_agent_end(self, cb: LifecycleHook) -> None:
        self._agent_end_hooks.append(cb)

    async def _fire(self, hooks: list[LifecycleHook], ctx: CaracalContext) -> None:
        for h in hooks:
            await h(ctx)

    @asynccontextmanager
    async def spawn(
        self,
        *,
        kind: AgentKind | None = None,
        ttl_seconds: int | None = None,
        session_sid: str | None = None,
        parent_id: str | None = None,
        metadata: dict[str, Any] | None = None,
        trace_id: str | None = None,
    ) -> AsyncGenerator[CaracalContext, None]:
        on_start: LifecycleHook | None = (
            (lambda c: self._fire(self._agent_start_hooks, c)) if self._agent_start_hooks else None
        )
        on_end: LifecycleHook | None = (
            (lambda c: self._fire(self._agent_end_hooks, c)) if self._agent_end_hooks else None
        )
        async with spawn(
            coordinator=self.config.coordinator,
            zone_id=self.config.zone_id,
            application_id=self.config.application_id,
            subject_token=self.config.subject_token,
            session_sid=session_sid,
            parent_id=parent_id,
            kind=kind or self.config.default_kind,
            ttl_seconds=ttl_seconds if ttl_seconds is not None else self.config.default_ttl_seconds,
            metadata=metadata,
            trace_id=trace_id,
            on_agent_start=on_start,
            on_agent_end=on_end,
        ) as ctx:
            yield ctx

    @asynccontextmanager
    async def delegate(
        self,
        *,
        to: str,
        to_application_id: str,
        scopes: list[str],
        constraints: DelegationConstraints | None = None,
        ttl_seconds: int | None = None,
    ) -> AsyncGenerator[CaracalContext, None]:
        async with delegate(
            coordinator=self.config.coordinator,
            to_agent_session_id=to,
            to_application_id=to_application_id,
            scopes=scopes,
            constraints=constraints,
            ttl_seconds=ttl_seconds,
        ) as ctx:
            yield ctx

    def headers(self) -> dict[str, str]:
        ctx = current()
        if ctx is None:
            from .envelope import Envelope

            return to_headers(Envelope(subject_token=self.config.subject_token, hop=0))
        return to_headers(to_envelope(ctx))

    @asynccontextmanager
    async def bind_from_headers(
        self,
        headers: Mapping[str, str],
    ) -> AsyncGenerator[CaracalContext, None]:
        def get(name: str) -> str | None:
            lower = name.lower()
            for k, v in headers.items():
                if k.lower() == lower:
                    return v
            return None

        env = decode_envelope(get)
        if not env.subject_token:
            env.subject_token = self.config.subject_token
        ctx = from_envelope(
            env,
            zone_id=self.config.zone_id,
            client_id=self.config.application_id,
        )
        token = _ctx_var.set(ctx)
        try:
            yield ctx
        finally:
            _ctx_var.reset(token)

    def current(self) -> CaracalContext | None:
        return current()

    def middleware(self) -> Callable[[ASGIApp], CaracalASGIMiddleware]:
        from .http import CaracalASGIMiddleware

        outer = self

        def factory(app: ASGIApp) -> CaracalASGIMiddleware:
            return CaracalASGIMiddleware(app, outer)

        return factory

    def transport(self, **kwargs: Any) -> httpx.AsyncClient:
        """Returns an httpx.AsyncClient that auto-injects the envelope on every request
        and rewrites resource-bound calls through the configured Caracal gateway. Pass
        to any provider SDK that accepts a custom httpx client."""
        outer = self

        class _CaracalAuth(httpx.Auth):
            requires_request_body = False

            def auth_flow(self, request: httpx.Request):
                rewritten = outer._route_through_gateway(
                    request.url, request.headers.get("X-Caracal-Resource")
                )
                if rewritten is not None:
                    request.url = httpx.URL(rewritten[0])
                    request.headers["host"] = request.url.host
                    request.headers["X-Caracal-Resource"] = rewritten[1]
                    ctx = current()
                    token = ctx.subject_token if ctx is not None else outer.config.subject_token
                    request.headers["Authorization"] = f"Bearer {token}"
                for k, v in outer.headers().items():
                    if k not in request.headers:
                        request.headers[k] = v
                yield request

        return httpx.AsyncClient(auth=_CaracalAuth(), **kwargs)

    def _route_through_gateway(
        self,
        target: httpx.URL | str,
        explicit_resource: str | None,
    ) -> tuple[str, str] | None:
        gw = self.config.gateway_url
        if not gw:
            return None
        target_url = str(target)
        try:
            parsed = urlparse(target_url)
        except ValueError:
            return None
        if not parsed.scheme or not parsed.netloc:
            return None
        gw_parsed = urlparse(gw)
        if parsed.scheme == gw_parsed.scheme and parsed.netloc == gw_parsed.netloc:
            return None
        binding: ResourceBinding | None = None
        if explicit_resource:
            for b in self.config.resources:
                if b.resource_id == explicit_resource:
                    binding = b
                    break
        else:
            for b in self.config.resources:
                if _url_matches_prefix(parsed, b.upstream_prefix):
                    binding = b
                    break
            if binding is None:
                return None
        suffix = parsed.path or "/"
        if binding is not None:
            prefix = urlparse(binding.upstream_prefix)
            if prefix.path and prefix.path != "/" and parsed.path.startswith(prefix.path):
                trimmed = parsed.path[len(prefix.path) :] or "/"
                if not trimmed.startswith("/"):
                    trimmed = "/" + trimmed
                suffix = trimmed
        base_path = gw_parsed.path.rstrip("/")
        rewritten = urlunparse(
            (gw_parsed.scheme, gw_parsed.netloc, base_path + suffix, "", parsed.query, "")
        )
        rid = binding.resource_id if binding is not None else (explicit_resource or "")
        return rewritten, rid


def _url_matches_prefix(target, prefix: str) -> bool:
    p = urlparse(prefix)
    if p.scheme != target.scheme or p.netloc != target.netloc:
        return False
    if not p.path or p.path == "/":
        return True
    if target.path == p.path:
        return True
    pp = p.path if p.path.endswith("/") else p.path + "/"
    return target.path.startswith(pp)
