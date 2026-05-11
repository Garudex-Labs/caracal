"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Coordinator REST client for the Python SDK.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

import httpx


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


@dataclass
class DelegationConstraints:
    resources: list[str] | None = None
    actions: list[str] | None = None
    max_depth: int | None = None
    expires_at: str | None = None

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
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
    metadata: dict[str, Any] | None = None


@dataclass
class SpawnResponse:
    agent_session_id: str


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


async def spawn_agent(client: CoordinatorClient, bearer: str, req: SpawnRequest) -> SpawnResponse:
    body: dict[str, Any] = {
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

    resp = await client._http().post(
        f"{client.base_url}/zones/{req.zone_id}/agents",
        json=body,
        headers={"authorization": f"Bearer {bearer}"},
    )
    resp.raise_for_status()
    data = resp.json()
    return SpawnResponse(agent_session_id=data["agent_session_id"])


async def terminate_agent(
    client: CoordinatorClient, bearer: str, zone_id: str, agent_session_id: str
) -> None:
    try:
        resp = await client._http().delete(
            f"{client.base_url}/zones/{zone_id}/agents/{agent_session_id}",
            headers={"authorization": f"Bearer {bearer}"},
        )
        resp.raise_for_status()
    except Exception:
        pass


async def create_delegation(
    client: CoordinatorClient, bearer: str, req: DelegationRequest
) -> DelegationResponse:
    body: dict[str, Any] = {
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
    return DelegationResponse(delegation_edge_id=data["delegation_edge_id"])
