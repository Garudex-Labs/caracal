"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Coordinator REST client for the Python SDK.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum

import httpx

from .json_types import JsonObject, JsonValue


class AgentKind(StrEnum):
    SERVICE = "service"
    INSTANCE = "instance"
    EPHEMERAL = "ephemeral"


@dataclass
class CoordinatorClient:
    base_url: str
    timeout: float = 10.0
    _client: httpx.AsyncClient | None = field(default=None, repr=False)

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self.timeout)
        return self._client

    async def close(self) -> None:
        """Close the lazy HTTP client. Idempotent and safe to call from FastAPI
        lifespan shutdown."""
        if self._client is not None:
            await self._client.aclose()
            self._client = None


@dataclass
class DelegationConstraints:
    resources: list[str] | None = None
    actions: list[str] | None = None
    max_depth: int | None = None
    expires_at: str | None = None

    def to_wire(self) -> JsonObject:
        out: JsonObject = {}
        if self.resources is not None:
            out["resources"] = self.resources
        if self.actions is not None:
            out["actions"] = self.actions
        if self.max_depth is not None:
            out["max_depth"] = self.max_depth
        if self.expires_at is not None:
            out["expires_at"] = self.expires_at
        return out


@dataclass
class SpawnRequest:
    zone_id: str
    application_id: str
    session_sid: str | None = None
    parent_id: str | None = None
    kind: AgentKind = AgentKind.INSTANCE
    ttl_seconds: int | None = None
    metadata: JsonObject | None = None
    idempotency_key: str | None = None


@dataclass
class SpawnResponse:
    agent_session_id: str
    id: str | None = None


@dataclass
class DelegationRequest:
    zone_id: str
    issuer_application_id: str
    source_session_id: str
    target_session_id: str
    receiver_application_id: str
    scopes: list[str]
    constraints: DelegationConstraints | None = None
    ttl_seconds: int | None = None


@dataclass
class DelegationResponse:
    delegation_edge_id: str
    id: str | None = None


async def spawn_agent(client: CoordinatorClient, bearer: str, req: SpawnRequest) -> SpawnResponse:
    body: dict[str, JsonValue] = {
        "application_id": req.application_id,
        "kind": str(req.kind),
    }
    if req.session_sid:
        body["session_sid"] = req.session_sid
    if req.parent_id:
        body["parent_id"] = req.parent_id
    if req.ttl_seconds:
        body["ttl_seconds"] = req.ttl_seconds
    if req.metadata:
        body["metadata"] = req.metadata

    headers = {"authorization": f"Bearer {bearer}"}
    key = req.idempotency_key or _derive_idempotency_key(req)
    if key:
        headers["idempotency-key"] = key

    resp = await client._http().post(
        f"{client.base_url}/zones/{req.zone_id}/agents",
        json=body,
        headers=headers,
    )
    resp.raise_for_status()
    data = resp.json()
    agent_session_id = data.get("agent_session_id") or data.get("id")
    if not agent_session_id:
        raise KeyError("agent_session_id")
    return SpawnResponse(agent_session_id=agent_session_id, id=data.get("id"))


def _derive_idempotency_key(req: SpawnRequest) -> str | None:
    """Stable key for SDK-issued spawn retries. Skipped when the caller has
    given no stable inputs (no session_sid and no parent_id) — in that case a
    retry would still need a fresh session anyway."""
    import hashlib

    if not req.session_sid and not req.parent_id:
        return None
    seed = "|".join([
        req.application_id,
        req.session_sid or "",
        req.parent_id or "",
        str(req.kind),
    ])
    return hashlib.sha256(seed.encode("utf-8")).hexdigest()


async def terminate_agent(
    client: CoordinatorClient, bearer: str, zone_id: str, agent_session_id: str
) -> None:
    resp = await client._http().delete(
        f"{client.base_url}/zones/{zone_id}/agents/{agent_session_id}",
        headers={"authorization": f"Bearer {bearer}"},
    )
    resp.raise_for_status()


async def create_delegation(
    client: CoordinatorClient, bearer: str, req: DelegationRequest
) -> DelegationResponse:
    body: dict[str, JsonValue] = {
        "issuer_application_id": req.issuer_application_id,
        "source_session_id": req.source_session_id,
        "target_session_id": req.target_session_id,
        "receiver_application_id": req.receiver_application_id,
        "scopes": req.scopes,
    }
    if req.constraints is not None:
        body["constraints"] = req.constraints.to_wire()
    if req.ttl_seconds:
        body["ttl_seconds"] = req.ttl_seconds

    resp = await client._http().post(
        f"{client.base_url}/zones/{req.zone_id}/delegations",
        json=body,
        headers={"authorization": f"Bearer {bearer}"},
    )
    resp.raise_for_status()
    data = resp.json()
    delegation_edge_id = data.get("delegation_edge_id") or data.get("id")
    if not delegation_edge_id:
        raise KeyError("delegation_edge_id")
    return DelegationResponse(delegation_edge_id=delegation_edge_id, id=data.get("id"))
