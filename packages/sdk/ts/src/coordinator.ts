/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Coordinator REST client used by SDK primitives.
 */

export interface CoordinatorClient {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export type AgentKind = "service" | "instance" | "ephemeral";

export interface SpawnRequest {
  zoneId: string;
  applicationId: string;
  sessionSid?: string;
  parentId?: string;
  kind?: AgentKind;
  ttlSeconds?: number;
  metadata?: Record<string, unknown>;
}

export interface SpawnResponse {
  agent_session_id: string;
}

export interface DelegationRequest {
  zoneId: string;
  issuerApplicationId: string;
  sourceSessionId: string;
  targetSessionId: string;
  receiverApplicationId: string;
  scopes: string[];
  constraints?: Record<string, unknown>;
  ttlSeconds?: number;
}

export interface DelegationResponse {
  delegation_edge_id: string;
}

async function call<T>(
  client: CoordinatorClient,
  method: string,
  path: string,
  bearer: string,
  body?: unknown,
): Promise<T> {
  const fetchFn = client.fetchImpl ?? fetch;
  const res = await fetchFn(`${client.baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bearer}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`coordinator ${method} ${path} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

export async function spawnAgent(
  client: CoordinatorClient,
  bearer: string,
  req: SpawnRequest,
): Promise<SpawnResponse> {
  return call(client, "POST", `/zones/${encodeURIComponent(req.zoneId)}/agents`, bearer, {
    application_id: req.applicationId,
    session_sid: req.sessionSid,
    parent_id: req.parentId,
    kind: req.kind ?? "instance",
    ttl_seconds: req.ttlSeconds,
    metadata: req.metadata,
  });
}

export async function terminateAgent(
  client: CoordinatorClient,
  bearer: string,
  zoneId: string,
  agentSessionId: string,
): Promise<void> {
  const fetchFn = client.fetchImpl ?? fetch;
  await fetchFn(
    `${client.baseUrl}/zones/${encodeURIComponent(zoneId)}/agents/${encodeURIComponent(agentSessionId)}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${bearer}` },
    },
  ).catch(() => undefined);
}

export async function createDelegation(
  client: CoordinatorClient,
  bearer: string,
  req: DelegationRequest,
): Promise<DelegationResponse> {
  return call(client, "POST", `/zones/${encodeURIComponent(req.zoneId)}/delegations`, bearer, {
    issuer_application_id: req.issuerApplicationId,
    source_session_id: req.sourceSessionId,
    target_session_id: req.targetSessionId,
    receiver_application_id: req.receiverApplicationId,
    scopes: req.scopes,
    constraints: req.constraints,
    ttl_seconds: req.ttlSeconds,
  });
}
