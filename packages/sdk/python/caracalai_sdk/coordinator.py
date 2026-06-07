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


class AgentLifecycle(StrEnum):
    AGENT = "agent"
    SERVICE = "service"


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
    lifecycle: AgentLifecycle | None = None
    ttl_seconds: int | None = None
    metadata: JsonObject | None = None
    labels: list[str] | None = None
    idempotency_key: str | None = None


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
    parent_edge_id: str | None = None
    resource_id: str | None = None
    constraints: DelegationConstraints | None = None
    ttl_seconds: int | None = None


@dataclass
class DelegationResponse:
    delegation_edge_id: str


async def spawn_agent(client: CoordinatorClient, bearer: str, req: SpawnRequest) -> SpawnResponse:
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
    agent_session_id = data.get("agent_session_id")
    if not agent_session_id:
        raise KeyError("agent_session_id")
    return SpawnResponse(agent_session_id=agent_session_id)


def _derive_idempotency_key(req: SpawnRequest) -> str | None:
    """Stable key for SDK-issued spawn retries. Skipped when the caller has
    given no stable inputs (no subject_session_id and no parent_id): in that case a
    retry would still need a fresh session anyway."""
    import hashlib

    if not req.subject_session_id and not req.parent_id:
        return None
    seed = "|".join([
        req.application_id,
        req.subject_session_id or "",
        req.parent_id or "",
        str(req.lifecycle or ""),
        ",".join(req.labels or []),
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


async def heartbeat_agent(
    client: CoordinatorClient,
    bearer: str,
    zone_id: str,
    agent_session_id: str,
    status: str = "healthy",
) -> None:
    """Renew a service agent's lease. A service session is reaped by the
    coordinator if it stops heartbeating before the lease expires."""
    resp = await client._http().post(
        f"{client.base_url}/zones/{zone_id}/agents/{agent_session_id}/heartbeat",
        json={"status": status},
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
    if req.resource_id is not None:
        body["resource_id"] = req.resource_id
    if req.parent_edge_id is not None:
        body["parent_edge_id"] = req.parent_edge_id
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
    delegation_edge_id = data.get("delegation_edge_id")
    if not delegation_edge_id:
        raise KeyError("delegation_edge_id")
    return DelegationResponse(delegation_edge_id=delegation_edge_id)
