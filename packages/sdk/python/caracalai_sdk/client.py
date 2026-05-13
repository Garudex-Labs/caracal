"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal: drop-in bound client wrapping zone, application, subject token, and coordinator.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
from collections.abc import AsyncGenerator, Callable, Mapping
from urllib.parse import urlparse, urlunparse

import httpx

from .context import (
    CaracalContext,
    _ctx_var,
    current,
    from_envelope,
    to_envelope,
)
from .auth import ClientSecretExchanger, TokenSource, _decode_jwt_exp
from .coordinator import AgentKind, CoordinatorClient, DelegationConstraints
from .envelope import decode_envelope, to_headers
from .primitives import LifecycleHook, delegate, delegate_to_spawn, spawn

if TYPE_CHECKING:
    from .http import ASGIApp, CaracalASGIMiddleware


@dataclass
class ResourceBinding:
    resource_id: str
    upstream_prefix: str


class CaracalConfig:
    """Bound configuration for a Caracal client.

    `subject_token` may be supplied either as a static string or implicitly via
    `token_source` — a callable returning a fresh STS access token on demand.
    Exactly one must be provided.
    """

    def __init__(
        self,
        *,
        coordinator: CoordinatorClient,
        zone_id: str,
        application_id: str,
        subject_token: str | None = None,
        token_source: TokenSource | None = None,
        gateway_url: str | None = None,
        resources: list[ResourceBinding] | None = None,
        default_kind: AgentKind = AgentKind.INSTANCE,
        default_ttl_seconds: int | None = None,
    ) -> None:
        if (subject_token is None) == (token_source is None):
            raise ValueError(
                "CaracalConfig requires exactly one of subject_token or token_source"
            )
        self.coordinator = coordinator
        self.zone_id = zone_id
        self.application_id = application_id
        self._static_token = subject_token
        self._token_source = token_source
        self.gateway_url = gateway_url
        self.resources = sort_bindings_longest_first(resources or [])
        self.default_kind = default_kind
        self.default_ttl_seconds = default_ttl_seconds

    @property
    def subject_token(self) -> str:
        if self._token_source is not None:
            return self._token_source()
        assert self._static_token is not None
        return self._static_token


def sort_bindings_longest_first(bindings: list[ResourceBinding]) -> list[ResourceBinding]:
    """Sort resource bindings by upstream prefix length descending so the most
    specific prefix wins during gateway routing. Stable across equal lengths."""
    return sorted(bindings, key=lambda b: len(b.upstream_prefix), reverse=True)


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


def _load_resource_bindings_file(path: str | None) -> list[ResourceBinding]:
    if not path:
        return []
    import json

    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    if isinstance(data, dict):
        items = data.items()
    elif isinstance(data, list):
        items = ((d["resource_id"], d["upstream_prefix"]) for d in data)
    else:
        raise ValueError(f"CARACAL_RESOURCES_FILE: unsupported JSON shape in {path!r}")
    return [ResourceBinding(resource_id=str(rid), upstream_prefix=str(prefix))
            for rid, prefix in items if rid and prefix]


def _resource_ids_from_env(env: Mapping[str, str], bindings: list[ResourceBinding]) -> list[str]:
    explicit = env.get("CARACAL_APP_RESOURCES")
    if explicit:
        ids = [s.strip() for s in explicit.split(",") if s.strip()]
        if ids:
            return ids
    if bindings:
        return [b.resource_id for b in bindings]
    raise RuntimeError(
        "Caracal.from_env: client-secret mode requires resources via "
        "CARACAL_APP_RESOURCES, CARACAL_RESOURCES, or CARACAL_RESOURCES_FILE"
    )


def _default_config_path():
    from pathlib import Path

    explicit = os.environ.get("CARACAL_CONFIG")
    if explicit:
        return Path(explicit)
    xdg = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(xdg) / "caracal" / "caracal.toml"


def _required_str(cfg: dict, key: str) -> str:
    v = cfg.get(key)
    if not isinstance(v, str) or not v:
        raise RuntimeError(f"caracal.toml missing required field {key!r}")
    return v


def _validate_subject_token(token: str) -> None:
    """Local sanity check on a static bootstrap subject token. Rejects JWTs
    whose `exp` claim is already in the past. Opaque tokens are accepted
    unchanged. Signature verification is the verifier's responsibility."""
    import time

    exp = _decode_jwt_exp(token)
    if exp is None:
        return
    if exp <= time.time():
        raise RuntimeError(
            "CARACAL_SUBJECT_TOKEN is expired or has an invalid `exp` claim — "
            "refresh the bootstrap token before starting the application"
        )


class Caracal:
    def __init__(self, config: CaracalConfig) -> None:
        self.config = config
        self._agent_start_hooks: list[LifecycleHook] = []
        self._agent_end_hooks: list[LifecycleHook] = []

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Caracal:
        """Build a Caracal client from environment variables.

        Two authentication shapes are supported:

        * **Static subject token** — set `CARACAL_SUBJECT_TOKEN` directly.
        * **Application client secret** — set `CARACAL_APP_CLIENT_SECRET` and
          `CARACAL_STS_URL`; the SDK exchanges the secret for a fresh access
          token on demand and refreshes it before expiry.

        Required in both modes: `CARACAL_COORDINATOR_URL`, `CARACAL_ZONE_ID`,
        `CARACAL_APPLICATION_ID`.
        """
        e = env if env is not None else os.environ
        coordinator_url = e.get("CARACAL_COORDINATOR_URL")
        zone_id = e.get("CARACAL_ZONE_ID")
        application_id = e.get("CARACAL_APPLICATION_ID")
        missing = [
            k for k, v in {
                "CARACAL_COORDINATOR_URL": coordinator_url,
                "CARACAL_ZONE_ID": zone_id,
                "CARACAL_APPLICATION_ID": application_id,
            }.items() if not v
        ]
        if missing:
            raise RuntimeError(f"Caracal.from_env: missing {', '.join(missing)}")

        bindings = (
            _load_resource_bindings_file(e.get("CARACAL_RESOURCES_FILE"))
            + _parse_resource_bindings(e.get("CARACAL_RESOURCES"))
        )
        gateway_url = e.get("CARACAL_GATEWAY_URL") or None

        client_secret = e.get("CARACAL_APP_CLIENT_SECRET")
        sts_url = e.get("CARACAL_STS_URL")
        subject_token = e.get("CARACAL_SUBJECT_TOKEN")

        if client_secret:
            if not sts_url:
                raise RuntimeError(
                    "Caracal.from_env: CARACAL_APP_CLIENT_SECRET requires CARACAL_STS_URL"
                )
            resources = _resource_ids_from_env(e, bindings)
            exchanger = ClientSecretExchanger(
                sts_url=sts_url,
                zone_id=zone_id,
                application_id=application_id,
                client_secret=client_secret,
                resources=resources,
            )
            return cls(
                CaracalConfig(
                    coordinator=CoordinatorClient(base_url=coordinator_url),
                    zone_id=zone_id,
                    application_id=application_id,
                    token_source=exchanger.get_token,
                    gateway_url=gateway_url,
                    resources=bindings,
                )
            )

        if not subject_token:
            raise RuntimeError(
                "Caracal.from_env: provide CARACAL_APP_CLIENT_SECRET (+CARACAL_STS_URL) "
                "or CARACAL_SUBJECT_TOKEN"
            )
        _validate_subject_token(subject_token)
        return cls(
            CaracalConfig(
                coordinator=CoordinatorClient(base_url=coordinator_url),
                zone_id=zone_id,
                application_id=application_id,
                subject_token=subject_token,
                gateway_url=gateway_url,
                resources=bindings,
            )
        )

    @classmethod
    def from_client_secret(
        cls,
        *,
        coordinator_url: str,
        sts_url: str,
        zone_id: str,
        application_id: str,
        client_secret: str,
        resources: list[str] | list[ResourceBinding],
        gateway_url: str | None = None,
        scope: str = "agent:lifecycle",
    ) -> Caracal:
        """Build a Caracal client that exchanges an application client_secret
        for an STS access token and refreshes the token automatically.

        `resources` may be either a list of resource IDs (the STS audiences) or
        a list of ResourceBinding objects (when gateway routing is also
        required). When ResourceBinding objects are supplied their
        `resource_id`s are used as the STS audiences.
        """
        bindings: list[ResourceBinding] = []
        resource_ids: list[str] = []
        for r in resources:
            if isinstance(r, ResourceBinding):
                bindings.append(r)
                resource_ids.append(r.resource_id)
            else:
                resource_ids.append(str(r))
        if not resource_ids:
            raise ValueError("from_client_secret requires at least one resource")
        exchanger = ClientSecretExchanger(
            sts_url=sts_url,
            zone_id=zone_id,
            application_id=application_id,
            client_secret=client_secret,
            resources=resource_ids,
            scope=scope,
        )
        return cls(
            CaracalConfig(
                coordinator=CoordinatorClient(base_url=coordinator_url),
                zone_id=zone_id,
                application_id=application_id,
                token_source=exchanger.get_token,
                gateway_url=gateway_url,
                resources=bindings,
            )
        )

    @classmethod
    def from_config(cls, path: str | os.PathLike[str] | None = None) -> Caracal:
        """Build a Caracal client from a `caracal.toml` produced by
        `caracal init`. The config supplies zone, application, STS URL,
        client_secret, and resource bindings; tokens are exchanged on demand."""
        import tomllib
        from pathlib import Path

        cfg_path = Path(path) if path is not None else _default_config_path()
        if not cfg_path.exists():
            raise RuntimeError(
                f"Caracal config not found at {cfg_path}; run `caracal init` first."
            )
        cfg = tomllib.loads(cfg_path.read_text())

        zone_id = _required_str(cfg, "zone_id")
        application_id = _required_str(cfg, "application_id")
        client_secret = _required_str(cfg, "app_client_secret")
        sts_url = (
            cfg.get("sts_url")
            or cfg.get("zone_url")
            or os.environ.get("CARACAL_STS_URL")
        )
        if not sts_url:
            raise RuntimeError(
                "caracal.toml missing sts_url and CARACAL_STS_URL is unset"
            )
        coordinator_url = (
            cfg.get("coordinator_url")
            or os.environ.get("CARACAL_COORDINATOR_URL")
        )
        if not coordinator_url:
            raise RuntimeError(
                "caracal.toml missing coordinator_url and CARACAL_COORDINATOR_URL is unset"
            )
        gateway_url = cfg.get("gateway_url") or os.environ.get("CARACAL_GATEWAY_URL")

        credentials = cfg.get("credentials") or []
        bindings: list[ResourceBinding] = []
        resource_ids: list[str] = []
        for cred in credentials:
            rid = cred.get("resource")
            if not rid:
                continue
            resource_ids.append(str(rid))
            prefix = cred.get("upstream_prefix")
            if prefix:
                bindings.append(ResourceBinding(resource_id=str(rid), upstream_prefix=str(prefix)))
        if not resource_ids:
            resource_ids = ["resource://example"]

        return cls.from_client_secret(
            coordinator_url=coordinator_url,
            sts_url=sts_url,
            zone_id=zone_id,
            application_id=application_id,
            client_secret=client_secret,
            resources=bindings or resource_ids,
            gateway_url=gateway_url,
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

    @asynccontextmanager
    async def delegate_to_spawn(
        self,
        *,
        scopes: list[str],
        constraints: DelegationConstraints | None = None,
        delegation_ttl_seconds: int | None = None,
        kind: AgentKind | None = None,
        ttl_seconds: int | None = None,
        metadata: dict[str, Any] | None = None,
        trace_id: str | None = None,
    ) -> AsyncGenerator[CaracalContext, None]:
        on_start: LifecycleHook | None = (
            (lambda c: self._fire(self._agent_start_hooks, c)) if self._agent_start_hooks else None
        )
        on_end: LifecycleHook | None = (
            (lambda c: self._fire(self._agent_end_hooks, c)) if self._agent_end_hooks else None
        )
        async with delegate_to_spawn(
            coordinator=self.config.coordinator,
            zone_id=self.config.zone_id,
            application_id=self.config.application_id,
            subject_token=self.config.subject_token,
            scopes=scopes,
            constraints=constraints,
            delegation_ttl_seconds=delegation_ttl_seconds,
            kind=kind or self.config.default_kind,
            ttl_seconds=ttl_seconds if ttl_seconds is not None else self.config.default_ttl_seconds,
            metadata=metadata,
            trace_id=trace_id,
            on_agent_start=on_start,
            on_agent_end=on_end,
        ) as ctx:
            yield ctx

    @asynccontextmanager
    async def bind(
        self,
        ctx: CaracalContext,
    ) -> AsyncGenerator[CaracalContext, None]:
        """Rebind an existing CaracalContext into the current async task.

        Use when handing a child context off to a background task (e.g.
        `asyncio.create_task`) — the contextvar from the parent task is not
        visible there, so the receiving coroutine must reattach explicitly.
        """
        token = _ctx_var.set(ctx)
        try:
            yield ctx
        finally:
            _ctx_var.reset(token)

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

    async def close(self) -> None:
        """Release the coordinator's HTTP client. Idempotent."""
        await self.config.coordinator.close()

    def middleware(self) -> Callable[[ASGIApp], CaracalASGIMiddleware]:
        """ASGI middleware factory. Install at module load — `app.add_middleware()`
        only registers middleware before Starlette/FastAPI startup, so this cannot
        be called from inside a `lifespan` context manager.

            caracal = Caracal.from_env()
            app = FastAPI()
            app.add_middleware(caracal.middleware())
        """
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

    def sync_transport(self, **kwargs: Any) -> httpx.Client:
        """Sync counterpart to transport(): returns an httpx.Client that auto-injects
        the envelope on every request and rewrites resource-bound calls through the
        configured Caracal gateway. Use with sync httpx-based SDKs."""
        outer = self

        class _CaracalSyncAuth(httpx.Auth):
            requires_request_body = False

            def sync_auth_flow(self, request: httpx.Request):
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

        return httpx.Client(auth=_CaracalSyncAuth(), **kwargs)

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
