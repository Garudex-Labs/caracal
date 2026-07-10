"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Coordinator REST client for the Python SDK.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from email.utils import parsedate_to_datetime
from enum import StrEnum
from time import monotonic
import time
import re
import secrets
from urllib.parse import quote

import httpx

from caracalai_oauth import CaracalEvent, EventHook, emit_event

from .errors import CoordinatorError
from .json_types import JsonObject, JsonValue


class Lifecycle(StrEnum):
    TASK = "task"
    SERVICE = "service"


def _trace_headers(
    trace_id: str | None,
    trace_flags: str | None = None,
    trace_state: str | None = None,
) -> dict[str, str]:
    if (
        not trace_id
        or not re.fullmatch(r"[0-9a-f]{32}", trace_id)
        or trace_id == "0" * 32
    ):
        return {}
    flags = (
        trace_flags
        if trace_flags and re.fullmatch(r"[0-9a-f]{2}", trace_flags)
        else "01"
    )
    return {
        "traceparent": f"00-{trace_id}-{secrets.token_hex(8)}-{flags}",
        **({"tracestate": trace_state} if trace_state else {}),
    }


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


def _retry_after_seconds(resp: httpx.Response) -> float | None:
    raw = resp.headers.get("retry-after")
    if not raw:
        return None
    try:
        secs = float(raw)
        return secs if secs >= 0 else None
    except ValueError:
        pass
    try:
        at = parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        return None
    return max(0.0, at.timestamp() - time.time())


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

    def finish(
        status: int,
        ok: bool,
        *,
        code: str = "",
        request_id: str = "",
        replayed: bool = False,
    ) -> None:
        emit_event(
            client.on_event,
            CaracalEvent(
                type="coordinator.call",
                ok=ok,
                duration_ms=(monotonic() - start) * 1000.0,
                method=method,
                path=path,
                status=status,
                code=code,
                request_id=request_id,
                replayed=replayed,
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
        try:
            error = resp.json()
        except ValueError:
            error = {}
        code = error.get("error") if isinstance(error.get("error"), str) else None
        request_id = (
            error.get("request_id")
            if isinstance(error.get("request_id"), str)
            else resp.headers.get("x-request-id")
        )
        finish(resp.status_code, False, code=code or "", request_id=request_id or "")
        raise CoordinatorError(
            method,
            path,
            resp.status_code,
            resp.text,
            _retry_after_seconds(resp),
            code,
            request_id,
        )
    finish(
        resp.status_code,
        True,
        replayed=resp.headers.get("idempotency-replayed") == "true",
    )
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

    def finish(
        status: int,
        ok: bool,
        *,
        code: str = "",
        request_id: str = "",
        replayed: bool = False,
    ) -> None:
        emit_event(
            client.on_event,
            CaracalEvent(
                type="coordinator.call",
                ok=ok,
                duration_ms=(monotonic() - start) * 1000.0,
                method=method,
                path=path,
                status=status,
                code=code,
                request_id=request_id,
                replayed=replayed,
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
        try:
            error = resp.json()
        except ValueError:
            error = {}
        code = error.get("error") if isinstance(error.get("error"), str) else None
        request_id = (
            error.get("request_id")
            if isinstance(error.get("request_id"), str)
            else resp.headers.get("x-request-id")
        )
        finish(resp.status_code, False, code=code or "", request_id=request_id or "")
        raise CoordinatorError(
            method,
            path,
            resp.status_code,
            resp.text,
            _retry_after_seconds(resp),
            code,
            request_id,
        )
    finish(
        resp.status_code,
        True,
        replayed=resp.headers.get("idempotency-replayed") == "true",
    )
    return resp


@dataclass
class DelegationConstraints:
    """Typed Delegation limits and audit metadata."""

    resources: list[str] | None = None
    max_depth: int | None = None
    max_hops: int | None = None
    ttl_seconds: int | None = None
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
        if self.policy_approved is not None:
            out["policy_approved"] = self.policy_approved
        if self.expires_at is not None:
            out["expires_at"] = self.expires_at
        if self.broad_reason is not None:
            out["broad_reason"] = self.broad_reason
        return out


@dataclass
class StartSessionRequest:
    zone_id: str
    application_id: str
    subject_authority_record_id: str | None = None
    subject_authority_record_token: str | None = None
    parent_id: str | None = None
    lifecycle: Lifecycle | None = None
    ttl_seconds: int | None = None
    metadata: JsonObject | None = None
    labels: list[str] | None = None
    idempotency_key: str | None = None
    idempotency_key_generated: bool = False
    parent_authority: str | None = None
    inherit_parent_edge_id: str | None = None
    trace_id: str | None = None
    trace_flags: str | None = None
    trace_state: str | None = None


@dataclass
class StartSessionResponse:
    session_id: str
    delegation_id: str | None = None
    heartbeat_deadline_at: str | None = None
    lease_generation: int = 0


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
    idempotency_key: str | None = None
    trace_id: str | None = None
    trace_flags: str | None = None
    trace_state: str | None = None


@dataclass
class DelegationResponse:
    """The created Delegation: its ID, the scopes it bounds, and when it lapses."""

    delegation_id: str
    scopes: list[str] = field(default_factory=list)
    expires_at: str | None = None


@dataclass
class InboundDelegation:
    """A delegation issued to a session, as the coordinator holds it."""

    delegation_id: str
    status: str
    expires_at: str | None = None


@dataclass
class HeartbeatResponse:
    status: str | None = None
    heartbeat_deadline_at: str | None = None
    lease_generation: int = 0


def _session_body(req: StartSessionRequest) -> dict[str, JsonValue]:
    body: dict[str, JsonValue] = {
        "application_id": req.application_id,
    }
    if req.lifecycle is not None:
        body["lifecycle"] = str(req.lifecycle)
    if req.subject_authority_record_id:
        body["subject_session_id"] = req.subject_authority_record_id
    if req.subject_authority_record_token:
        body["subject_token"] = req.subject_authority_record_token
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


def _parse_session(data: dict[str, JsonValue]) -> StartSessionResponse:
    session_id = data.get("agent_session_id")
    if not session_id:
        raise ValueError("coordinator session response missing agent_session_id")
    lease_generation = data.get("lease_generation", 0)
    if not isinstance(lease_generation, int) or isinstance(lease_generation, bool):
        raise ValueError("coordinator session response missing valid lease_generation")
    return StartSessionResponse(
        session_id=str(session_id),
        delegation_id=data.get("delegation_edge_id"),
        heartbeat_deadline_at=data.get("heartbeat_deadline_at"),
        lease_generation=lease_generation,
    )


async def start_coordinator_session(
    client: CoordinatorClient, bearer: str, req: StartSessionRequest
) -> StartSessionResponse:
    headers = (
        {
            "idempotency-key": req.idempotency_key,
            **(
                {"idempotency-key-kind": "generated"}
                if req.idempotency_key_generated
                else {}
            ),
        }
        if req.idempotency_key
        else None
    )
    headers = {
        **(headers or {}),
        **_trace_headers(req.trace_id, req.trace_flags, req.trace_state),
    }

    resp = await _call(
        client,
        "POST",
        f"/zones/{quote(req.zone_id, safe='')}/agents",
        bearer,
        json_body=_session_body(req),
        headers=headers,
    )
    parsed = _parse_session(resp.json())
    if req.lifecycle == Lifecycle.SERVICE and parsed.lease_generation < 1:
        raise ValueError("coordinator session response missing valid lease_generation")
    return parsed


def sync_start_coordinator_session(
    client: CoordinatorClient, http: httpx.Client, bearer: str, req: StartSessionRequest
) -> StartSessionResponse:
    headers = {"idempotency-key": req.idempotency_key} if req.idempotency_key else None

    resp = _sync_call(
        client,
        http,
        "POST",
        f"/zones/{quote(req.zone_id, safe='')}/agents",
        bearer,
        json_body=_session_body(req),
        headers=headers,
    )
    parsed = _parse_session(resp.json())
    if req.lifecycle == Lifecycle.SERVICE and parsed.lease_generation < 1:
        raise ValueError("coordinator session response missing valid lease_generation")
    return parsed


async def terminate_session(
    client: CoordinatorClient,
    bearer: str,
    zone_id: str,
    session_id: str,
    lease_generation: int | None = None,
    trace_id: str | None = None,
    trace_flags: str | None = None,
    trace_state: str | None = None,
) -> None:
    await _call(
        client,
        "DELETE",
        f"/zones/{quote(zone_id, safe='')}/agents/{quote(session_id, safe='')}",
        bearer,
        json_body=(
            {"lease_generation": lease_generation}
            if lease_generation is not None
            else None
        ),
        headers=_trace_headers(trace_id, trace_flags, trace_state),
    )


def sync_terminate_session(
    client: CoordinatorClient,
    http: httpx.Client,
    bearer: str,
    zone_id: str,
    session_id: str,
    lease_generation: int | None = None,
) -> None:
    _sync_call(
        client,
        http,
        "DELETE",
        f"/zones/{quote(zone_id, safe='')}/agents/{quote(session_id, safe='')}",
        bearer,
        json_body=(
            {"lease_generation": lease_generation}
            if lease_generation is not None
            else None
        ),
    )


async def heartbeat_session(
    client: CoordinatorClient,
    bearer: str,
    zone_id: str,
    session_id: str,
    lease_generation: int,
    status: str = "healthy",
    trace_id: str | None = None,
    trace_flags: str | None = None,
    trace_state: str | None = None,
) -> HeartbeatResponse:
    """Renew a long-lived Session's lease. The Session is reaped by the
    coordinator if it stops heartbeating before the lease expires; the
    response reports the renewed deadline so callers can pace renewals."""
    resp = await _call(
        client,
        "POST",
        f"/zones/{quote(zone_id, safe='')}/agents/{quote(session_id, safe='')}/heartbeat",
        bearer,
        json_body={"status": status, "lease_generation": lease_generation},
        headers=_trace_headers(trace_id, trace_flags, trace_state),
    )
    if resp.status_code == 204 or not resp.content:
        return HeartbeatResponse()
    agent = resp.json().get("agent") or {}
    generation = agent.get("lease_generation")
    if (
        not isinstance(generation, int)
        or isinstance(generation, bool)
        or generation < 1
    ):
        raise ValueError(
            "coordinator heartbeat response missing valid lease_generation"
        )
    return HeartbeatResponse(
        status=agent.get("status"),
        heartbeat_deadline_at=agent.get("heartbeat_deadline_at"),
        lease_generation=generation,
    )


async def acquire_session_lease(
    client: CoordinatorClient,
    bearer: str,
    zone_id: str,
    session_id: str,
    trace_id: str | None = None,
    trace_flags: str | None = None,
    trace_state: str | None = None,
) -> HeartbeatResponse:
    """Acquire a new generation for an active long-lived Session lease."""
    resp = await _call(
        client,
        "POST",
        f"/zones/{quote(zone_id, safe='')}/agents/{quote(session_id, safe='')}/lease",
        bearer,
        headers=_trace_headers(trace_id, trace_flags, trace_state),
    )
    data = resp.json()
    generation = data.get("lease_generation")
    if (
        not isinstance(generation, int)
        or isinstance(generation, bool)
        or generation < 1
    ):
        raise ValueError("coordinator lease response missing valid lease_generation")
    return HeartbeatResponse(
        status=data.get("status"),
        heartbeat_deadline_at=data.get("heartbeat_deadline_at"),
        lease_generation=generation,
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
    delegation_id = data.get("delegation_edge_id")
    if not delegation_id:
        raise ValueError("coordinator delegation response missing delegation_id")
    return DelegationResponse(
        delegation_id=str(delegation_id),
        scopes=data.get("scopes") or [],
        expires_at=data.get("expires_at"),
    )


async def create_delegation(
    client: CoordinatorClient, bearer: str, req: DelegationRequest
) -> DelegationResponse:
    headers = {
        **({"idempotency-key": req.idempotency_key} if req.idempotency_key else {}),
        **_trace_headers(req.trace_id, req.trace_flags, req.trace_state),
    }
    resp = await _call(
        client,
        "POST",
        f"/zones/{quote(req.zone_id, safe='')}/delegations",
        bearer,
        json_body=_delegation_body(req),
        headers=headers,
    )
    return _parse_delegation(resp.json())


async def revoke_delegation(
    client: CoordinatorClient, bearer: str, zone_id: str, delegation_id: str
) -> None:
    await _call(
        client,
        "PATCH",
        f"/zones/{quote(zone_id, safe='')}/delegations/{quote(delegation_id, safe='')}/revoke",
        bearer,
    )


async def list_inbound_delegations(
    client: CoordinatorClient, bearer: str, zone_id: str, session_id: str
) -> list[InboundDelegation]:
    """List the delegations issued to a session, letting a receiver confirm a
    handed-over delegation id is live before presenting it."""
    resp = await _call(
        client,
        "GET",
        f"/zones/{quote(zone_id, safe='')}/delegations/inbound/{quote(session_id, safe='')}",
        bearer,
    )
    items = resp.json().get("items") or []
    return [
        InboundDelegation(
            delegation_id=str(item["id"]),
            status=str(item.get("status") or ""),
            expires_at=item.get("expires_at"),
        )
        for item in items
        if item.get("id")
    ]


async def get_inbound_delegation(
    client: CoordinatorClient,
    bearer: str,
    zone_id: str,
    session_id: str,
    delegation_id: str,
) -> InboundDelegation:
    resp = await _call(
        client,
        "GET",
        f"/zones/{quote(zone_id, safe='')}/delegations/inbound/{quote(session_id, safe='')}/{quote(delegation_id, safe='')}",
        bearer,
    )
    item = resp.json()
    if not item.get("id"):
        item = next(
            (
                candidate
                for candidate in item.get("items", [])
                if candidate.get("id") == delegation_id
            ),
            {},
        )
    if not item.get("id"):
        raise ValueError("coordinator inbound delegation response missing id")
    return InboundDelegation(
        delegation_id=str(item["id"]),
        status=str(item.get("status") or ""),
        expires_at=item.get("expires_at"),
    )


def sync_create_delegation(
    client: CoordinatorClient, http: httpx.Client, bearer: str, req: DelegationRequest
) -> DelegationResponse:
    headers = {"idempotency-key": req.idempotency_key} if req.idempotency_key else None
    resp = _sync_call(
        client,
        http,
        "POST",
        f"/zones/{quote(req.zone_id, safe='')}/delegations",
        bearer,
        json_body=_delegation_body(req),
        headers=headers,
    )
    return _parse_delegation(resp.json())
