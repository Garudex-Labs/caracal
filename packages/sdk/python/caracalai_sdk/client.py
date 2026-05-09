"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal: drop-in bound client wrapping zone, application, subject token, and coordinator.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, AsyncGenerator, Callable, Mapping

import httpx

from .context import (
    CaracalContext,
    _ctx_var,
    from_envelope,
    to_envelope,
    try_current,
)
from .coordinator import AgentKind, CoordinatorClient
from .envelope import decode_envelope, to_headers
from .primitives import with_agent, with_delegation

if TYPE_CHECKING:
    from .http import ASGIApp, CaracalASGIMiddleware


@dataclass
class CaracalConfig:
    coordinator: CoordinatorClient
    zone_id: str
    application_id: str
    subject_token: str
    default_kind: AgentKind = "instance"
    default_ttl_seconds: int | None = None


class Caracal:
    def __init__(self, config: CaracalConfig) -> None:
        self.config = config

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
            )
        )

    @asynccontextmanager
    async def run(
        self,
        *,
        kind: AgentKind | None = None,
        ttl_seconds: int | None = None,
        session_sid: str | None = None,
        parent_id: str | None = None,
        metadata: dict[str, Any] | None = None,
        trace_id: str | None = None,
    ) -> AsyncGenerator[CaracalContext, None]:
        async with with_agent(
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
        ) as ctx:
            yield ctx

    @asynccontextmanager
    async def delegate(
        self,
        *,
        to: str,
        to_application_id: str,
        scopes: list[str],
        constraints: dict[str, Any] | None = None,
        ttl_seconds: int | None = None,
    ) -> AsyncGenerator[CaracalContext, None]:
        async with with_delegation(
            coordinator=self.config.coordinator,
            to_agent_session_id=to,
            to_application_id=to_application_id,
            scopes=scopes,
            constraints=constraints,
            ttl_seconds=ttl_seconds,
        ) as ctx:
            yield ctx

    def headers(self) -> dict[str, str]:
        ctx = try_current()
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

    def context(self) -> CaracalContext:
        ctx = try_current()
        if ctx is None:
            raise RuntimeError("Caracal context is not bound on this execution path")
        return ctx

    def try_context(self) -> CaracalContext | None:
        return try_current()

    def middleware(self) -> Callable[[ASGIApp], CaracalASGIMiddleware]:
        from .http import CaracalASGIMiddleware

        outer = self

        def factory(app: ASGIApp) -> CaracalASGIMiddleware:
            return CaracalASGIMiddleware(app, outer)

        return factory

    def httpx_client(self, **kwargs: Any) -> httpx.AsyncClient:
        """Returns an httpx.AsyncClient that auto-injects the envelope on every request."""
        outer = self

        class _CaracalAuth(httpx.Auth):
            requires_request_body = False

            def auth_flow(self, request: httpx.Request):
                for k, v in outer.headers().items():
                    if k not in request.headers:
                        request.headers[k] = v
                yield request

        return httpx.AsyncClient(auth=_CaracalAuth(), **kwargs)
