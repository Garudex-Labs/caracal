"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Shared contract for provider domain modules: per-provider state, request context, scope helpers, and the operation/seeder registries.
"""
from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Callable


class DomainError(Exception):
    """Raised when a domain operation rejects a request the way a real provider would."""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


@dataclass
class State:
    """Per-provider mutable domain state, isolated to one running provider app."""

    provider_id: str
    lock: threading.Lock = field(default_factory=threading.Lock)
    tables: dict[str, dict] = field(default_factory=dict)
    jobs: dict[str, dict] = field(default_factory=dict)
    seq: int = 0
    seeded: bool = False

    def table(self, name: str) -> dict:
        return self.tables.setdefault(name, {})

    def next_id(self, prefix: str) -> str:
        self.seq += 1
        return f"{prefix}_{self.seq:06d}"


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


@dataclass
class Ctx:
    """One domain request: the provider, its state, the operation, payload, and caller principal."""

    provider: object
    state: State
    op: str
    payload: dict
    principal: dict

    def require(self, *names: str) -> None:
        missing = [n for n in names if self.payload.get(n) in (None, "")]
        if missing:
            raise DomainError(422, "invalid_request",
                              f"missing required field(s): {', '.join(missing)}")

    def scopes(self) -> set[str]:
        raw = self.principal.get("scope")
        if raw is None:
            return set()
        if isinstance(raw, str):
            return {s for s in raw.split() if s}
        return {str(s) for s in raw}

    def require_scope(self, scope: str) -> None:
        if self.principal.get("auth") in ("oauth", "caracal_mandate") and scope not in self.scopes():
            raise DomainError(403, "insufficient_scope", f"operation requires scope {scope!r}")

    def get(self, name: str, default=None):
        return self.payload.get(name, default)

    def paginate(self, items: list, *, size_default: int = 25) -> dict:
        page = max(1, int(self.payload.get("page", 1)))
        size = max(1, min(int(self.payload.get("pageSize", size_default)), 100))
        start = (page - 1) * size
        window = items[start:start + size]
        return {"page": page, "pageSize": size, "total": len(items),
                "items": window, "hasMore": start + size < len(items)}


HANDLERS: dict[str, dict[str, Callable[[Ctx], dict]]] = {}
SEEDERS: dict[str, Callable[[State], None]] = {}
TOOLSPECS: dict[str, dict[str, dict]] = {}
RESOURCES: dict[str, list[dict]] = {}
GRPC_SERVICES: dict[str, dict] = {}


def grpc_service(provider_id: str, *, package: str, services: list[dict]) -> None:
    """Register the gRPC service surface a provider exposes.

    Each service entry is ``{"name": <ServiceName>, "rpcs": [{"name": <Rpc>,
    "operation": <op>, "request": <Msg>, "response": <Msg>,
    "server_streaming": bool}]}``. The lab serves these methods over the shared
    HTTP transport, but the descriptor lets the control surface present the
    provider as the gRPC service it models."""
    GRPC_SERVICES[provider_id] = {"package": package, "services": services}



def op(provider_id: str, name: str, *, title: str | None = None,
       description: str | None = None, input_schema: dict | None = None,
       output_schema: dict | None = None, annotations: dict | None = None,
       hidden: bool = False) -> Callable:
    """Register a handler for one provider operation.

    Optional metadata describes the operation as an MCP tool (title, JSON Schema
    input/output, behavior annotations). Hidden operations stay callable for
    dispatch but are not advertised in the tool catalog."""
    def deco(fn: Callable[[Ctx], dict]) -> Callable[[Ctx], dict]:
        HANDLERS.setdefault(provider_id, {})[name] = fn
        if not hidden:
            spec: dict = {"name": name,
                          "description": (description or (fn.__doc__ or "")).strip(),
                          "inputSchema": input_schema or {"type": "object", "properties": {}}}
            if title:
                spec["title"] = title
            if output_schema:
                spec["outputSchema"] = output_schema
            if annotations:
                spec["annotations"] = annotations
            TOOLSPECS.setdefault(provider_id, {})[name] = spec
        return fn
    return deco


def resource(provider_id: str, *, uri: str, name: str, description: str,
             mime_type: str = "application/json") -> Callable:
    """Register an MCP resource backed by a hidden read handler keyed by its URI."""
    def deco(fn: Callable[[Ctx], dict]) -> Callable[[Ctx], dict]:
        HANDLERS.setdefault(provider_id, {})[uri] = fn
        RESOURCES.setdefault(provider_id, []).append(
            {"uri": uri, "name": name, "description": description, "mimeType": mime_type})
        return fn
    return deco


def seeder(provider_id: str) -> Callable:
    """Register the dataset seeding function for a provider."""
    def deco(fn: Callable[[State], None]) -> Callable[[State], None]:
        SEEDERS[provider_id] = fn
        return fn
    return deco


def dispatch(provider, state: State, operation: str, payload: dict, principal: dict) -> dict:
    """Resolve one domain operation against provider state, returning a realistic body."""
    handlers = HANDLERS.get(provider.id)
    if not handlers:
        raise DomainError(404, "unknown_resource", f"no domain registered for {provider.id}")
    handler = handlers.get(operation)
    if handler is None:
        raise DomainError(404, "unknown_operation", operation)
    with state.lock:
        if not state.seeded:
            seed = SEEDERS.get(provider.id)
            if seed is not None:
                seed(state)
            state.seeded = True
        return handler(Ctx(provider, state, operation, payload, principal))


def now() -> int:
    return int(time.time())
