"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Coordinator REST client for the Python SDK.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from time import monotonic
from urllib.parse import quote

import httpx

from .errors import CoordinatorError
from .events import CaracalEvent, EventHook, emit_event
from .json_types import JsonObject, JsonValue


class Lifecycle(StrEnum):
    TASK = "task"
    SERVICE = "service"


@dataclass
class CoordinatorClient:
    base_url: str
    timeout: float = 10.0
    http_client: httpx.AsyncClient | None = field(default=None, repr=False)
    on_event: EventHook | None = field(default=None, repr=False)

    def _http(self) -> httpx.AsyncClient:
        if self.http_client is None:
            self.http_client = httpx.AsyncClient(timeout=self.timeout)
        return self.http_client

    async def aclose(self) -> None:
        """Close the lazy HTTP client. Idempotent and safe to call from FastAPI
        lifespan shutdown."""
        if self.http_client is not None:
            await self.http_client.aclose()
            self.http_client = None


async def _call(
    client: CoordinatorClient,
    method: str,
    path: str,
    bearer: str,
    json_body: dict[str, JsonValue] | None = None,
    headers: dict[str, str] | None = None,
) -> httpx.Response:
    request_headers = {"authorization": f"Bearer {bearer}"}
    if headers:
        request_headers.update(headers)
    start = monotonic()

    def finish(status: int, ok: bool) -> None:
        emit_event(
            client.on_event,
            CaracalEvent(
                type="coordinator.call",
                ok=ok,
                duration_ms=(monotonic() - start) * 1000.0,
                method=method,
                path=path,
                status=status,
            ),
        )

    try:
        resp = await client._http().request(
            method,
            client.base_url.rstrip("/") + path,
            json=json_body,
            headers=request_headers,
        )
    except Exception:
        finish(0, False)
        raise
    if resp.status_code >= 300:
        finish(resp.status_code, False)
        raise CoordinatorError(method, path, resp.status_code, resp.text)
    finish(resp.status_code, True)
    return resp


def _sync_call(
    client: CoordinatorClient,
    http: httpx.Client,
    method: str,
    path: str,
    bearer: str,
    json_body: dict[str, JsonValue] | None = None,
    headers: dict[str, str] | None = None,
) -> httpx.Response:
    request_headers = {"authorization": f"Bearer {bearer}"}
    if headers:
        request_headers.update(headers)
    start = monotonic()

    def finish(status: int, ok: bool) -> None:
        emit_event(
            client.on_event,
            CaracalEvent(
                type="coordinator.call",
                ok=ok,
                duration_ms=(monotonic() - start) * 1000.0,
                method=method,
                path=path,
                status=status,
            ),
        )

    try:
        resp = http.request(
            method,
            client.base_url.rstrip("/") + path,
            json=json_body,
            headers=request_headers,
        )
    except Exception:
        finish(0, False)
        raise
    if resp.status_code >= 300:
        finish(resp.status_code, False)
        raise CoordinatorError(method, path, resp.status_code, resp.text)
    finish(resp.status_code, True)
    return resp


@dataclass
class DelegationConstraints:
    resources: list[str] | None = None
    max_depth: int | None = None
    max_hops: int | None = None
    ttl_seconds: int | None = None
    budget: int | None = None
    policy_approved: bool | None = None
    expires_at: str | None = None
    broad_reason: str | None = None

    def to_wire(self) -> JsonObject:
        out: JsonObject = {}
        if self.resources is not None:
            out["resources"] = self.resources
        if self.max_depth is not None:
            out["max_depth"] = self.max_depth
        if self.max_hops is not None:
            out["max_hops"] = self.max_hops
        if self.ttl_seconds is not None:
            out["ttl_seconds"] = self.ttl_seconds
        if self.budget is not None:
            out["budget"] = self.budget
        if self.policy_approved is not None:
            out["policy_approved"] = self.policy_approved
        if self.expires_at is not None:
            out["expires_at"] = self.expires_at
        if self.broad_reason is not None:
            out["broad_reason"] = self.broad_reason
        return out


@dataclass
class SpawnRequest:
    zone_id: str
    application_id: str
    subject_session_id: str | None = None
    parent_id: str | None = None
    lifecycle: Lifecycle | None = None
    ttl_seconds: int | None = None
    metadata: JsonObject | None = None
    labels: list[str] | None = None
    idempotency_key: str | None = None
    parent_authority: str | None = None
    inherit_parent_edge_id: str | None = None


@dataclass
class SpawnResponse:
    agent_session_id: str
    delegation_edge_id: str | None = None
    heartbeat_deadline_at: str | None = None


@dataclass
class DelegationRequest:
    zone_id: str
    issuer_application_id: str
    source_session_id: str
    target_session_id: str
    receiver_application_id: str
    scopes: list[str]
    parent_edge_id: str | None = None
    resource_id: str | None = None
    constraints: DelegationConstraints | None = None
    ttl_seconds: int | None = None


@dataclass
class DelegationResponse:
    """The created delegation edge: its id, the scopes it bounds, and when it lapses."""

    delegation_edge_id: str
    scopes: list[str] = field(default_factory=list)
    expires_at: str | None = None


@dataclass
class HeartbeatResponse:
    status: str | None = None
    heartbeat_deadline_at: str | None = None


def _spawn_body(req: SpawnRequest) -> dict[str, JsonValue]:
    body: dict[str, JsonValue] = {
        "application_id": req.application_id,
    }
    if req.lifecycle is not None:
        body["lifecycle"] = str(req.lifecycle)
    if req.subject_session_id:
        body["subject_session_id"] = req.subject_session_id
    if req.parent_id:
        body["parent_id"] = req.parent_id
    if req.ttl_seconds:
        body["ttl_seconds"] = req.ttl_seconds
    if req.metadata:
        body["metadata"] = req.metadata
    if req.labels:
        body["labels"] = req.labels
    if req.parent_authority:
        body["parent_authority"] = req.parent_authority
    if req.inherit_parent_edge_id:
        body["inherit_parent_edge_id"] = req.inherit_parent_edge_id
    return body


def _parse_spawn(data: dict[str, JsonValue]) -> SpawnResponse:
    agent_session_id = data.get("agent_session_id")
    if not agent_session_id:
        raise ValueError("coordinator spawn response missing agent_session_id")
    return SpawnResponse(
        agent_session_id=str(agent_session_id),
        delegation_edge_id=data.get("delegation_edge_id"),
        heartbeat_deadline_at=data.get("heartbeat_deadline_at"),
    )


async def spawn_agent(
    client: CoordinatorClient, bearer: str, req: SpawnRequest
) -> SpawnResponse:
    headers = {"idempotency-key": req.idempotency_key} if req.idempotency_key else None

    resp = await _call(
        client,
        "POST",
        f"/zones/{quote(req.zone_id, safe='')}/agents",
        bearer,
        json_body=_spawn_body(req),
        headers=headers,
    )
    return _parse_spawn(resp.json())


def sync_spawn_agent(
    client: CoordinatorClient, http: httpx.Client, bearer: str, req: SpawnRequest
) -> SpawnResponse:
    headers = {"idempotency-key": req.idempotency_key} if req.idempotency_key else None

    resp = _sync_call(
        client,
        http,
        "POST",
        f"/zones/{quote(req.zone_id, safe='')}/agents",
        bearer,
        json_body=_spawn_body(req),
        headers=headers,
    )
    return _parse_spawn(resp.json())


async def terminate_agent(
    client: CoordinatorClient, bearer: str, zone_id: str, agent_session_id: str
) -> None:
    await _call(
        client,
        "DELETE",
        f"/zones/{quote(zone_id, safe='')}/agents/{quote(agent_session_id, safe='')}",
        bearer,
    )


def sync_terminate_agent(
    client: CoordinatorClient,
    http: httpx.Client,
    bearer: str,
    zone_id: str,
    agent_session_id: str,
) -> None:
    _sync_call(
        client,
        http,
        "DELETE",
        f"/zones/{quote(zone_id, safe='')}/agents/{quote(agent_session_id, safe='')}",
        bearer,
    )


async def heartbeat_agent(
    client: CoordinatorClient,
    bearer: str,
    zone_id: str,
    agent_session_id: str,
    status: str = "healthy",
) -> HeartbeatResponse:
    """Renew a service agent's lease. A service session is reaped by the
    coordinator if it stops heartbeating before the lease expires; the
    response reports the renewed deadline so callers can pace renewals."""
    resp = await _call(
        client,
        "POST",
        f"/zones/{quote(zone_id, safe='')}/agents/{quote(agent_session_id, safe='')}/heartbeat",
        bearer,
        json_body={"status": status},
    )
    if resp.status_code == 204 or not resp.content:
        return HeartbeatResponse()
    agent = resp.json().get("agent") or {}
    return HeartbeatResponse(
        status=agent.get("status"),
        heartbeat_deadline_at=agent.get("heartbeat_deadline_at"),
    )


def _delegation_body(req: DelegationRequest) -> dict[str, JsonValue]:
    body: dict[str, JsonValue] = {
        "issuer_application_id": req.issuer_application_id,
        "source_session_id": req.source_session_id,
        "target_session_id": req.target_session_id,
        "receiver_application_id": req.receiver_application_id,
        "scopes": req.scopes,
    }
    if req.resource_id is not None:
        body["resource_id"] = req.resource_id
    if req.parent_edge_id is not None:
        body["parent_edge_id"] = req.parent_edge_id
    if req.constraints is not None:
        body["constraints"] = req.constraints.to_wire()
    if req.ttl_seconds:
        body["ttl_seconds"] = req.ttl_seconds
    return body


def _parse_delegation(data: dict[str, JsonValue]) -> DelegationResponse:
    delegation_edge_id = data.get("delegation_edge_id")
    if not delegation_edge_id:
        raise ValueError("coordinator delegation response missing delegation_edge_id")
    return DelegationResponse(
        delegation_edge_id=str(delegation_edge_id),
        scopes=data.get("scopes") or [],
        expires_at=data.get("expires_at"),
    )


async def create_delegation(
    client: CoordinatorClient, bearer: str, req: DelegationRequest
) -> DelegationResponse:
    resp = await _call(
        client,
        "POST",
        f"/zones/{quote(req.zone_id, safe='')}/delegations",
        bearer,
        json_body=_delegation_body(req),
    )
    return _parse_delegation(resp.json())


def sync_create_delegation(
    client: CoordinatorClient, http: httpx.Client, bearer: str, req: DelegationRequest
) -> DelegationResponse:
    resp = _sync_call(
        client,
        http,
        "POST",
        f"/zones/{quote(req.zone_id, safe='')}/delegations",
        bearer,
        json_body=_delegation_body(req),
    )
    return _parse_delegation(resp.json())
