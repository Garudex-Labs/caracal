/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Coordinator REST client used by SDK primitives.
 */

import { createHash } from "node:crypto";

export interface CoordinatorClient {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export const AgentKind = {
  Service: "service",
  Instance: "instance",
  Ephemeral: "ephemeral",
} as const;

export type AgentKind = typeof AgentKind[keyof typeof AgentKind];

export interface DelegationConstraints {
  resources?: string[];
  actions?: string[];
  maxDepth?: number;
  expiresAt?: string;
}

export interface SpawnRequest {
  zoneId: string;
  applicationId: string;
  sessionSid?: string;
  parentId?: string;
  kind?: AgentKind;
  ttlSeconds?: number;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface SpawnResponse {
  id?: string;
  agent_session_id: string;
}

export interface DelegationRequest {
  zoneId: string;
  issuerApplicationId: string;
  sourceSessionId: string;
  targetSessionId: string;
  receiverApplicationId: string;
  scopes: string[];
  constraints?: DelegationConstraints;
  ttlSeconds?: number;
}

export interface DelegationResponse {
  id?: string;
  delegation_edge_id: string;
}

async function call<T>(
  client: CoordinatorClient,
  method: string,
  path: string,
  bearer: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const fetchFn = client.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${bearer}`,
    ...(extraHeaders ?? {}),
  };
  const res = await fetchFn(`${client.baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`coordinator ${method} ${path} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

export async function spawnAgent(
  client: CoordinatorClient,
  bearer: string,
  req: SpawnRequest,
): Promise<SpawnResponse> {
  const key = req.idempotencyKey ?? deriveIdempotencyKey(req);
  const headers = key ? { "idempotency-key": key } : undefined;
  const res = await call<SpawnResponse>(
    client,
    "POST",
    `/zones/${encodeURIComponent(req.zoneId)}/agents`,
    bearer,
    {
      application_id: req.applicationId,
      session_sid: req.sessionSid,
      parent_id: req.parentId,
      kind: req.kind ?? AgentKind.Instance,
      ttl_seconds: req.ttlSeconds,
      metadata: req.metadata,
    },
    headers,
  );
  if (!res.agent_session_id && res.id) res.agent_session_id = res.id;
  return res;
}

/**
 * Stable key for SDK-issued spawn retries. Returns undefined when no stable
 * inputs are present — in that case the caller's retry would still require a
 * fresh session.
 */
function deriveIdempotencyKey(req: SpawnRequest): string | undefined {
  if (!req.sessionSid && !req.parentId) return undefined;
  const seed = [
    req.applicationId,
    req.sessionSid ?? "",
    req.parentId ?? "",
    String(req.kind ?? AgentKind.Instance),
  ].join("|");
  return sha256Hex(seed);
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export async function terminateAgent(
  client: CoordinatorClient,
  bearer: string,
  zoneId: string,
  agentSessionId: string,
): Promise<void> {
  const fetchFn = client.fetchImpl ?? fetch;
  const del = await fetchFn(
    `${client.baseUrl}/zones/${encodeURIComponent(zoneId)}/agents/${encodeURIComponent(agentSessionId)}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${bearer}` },
    },
  );
  if (!del.ok) {
    const text = await del.text();
    throw new Error(`coordinator DELETE /zones/${zoneId}/agents/${agentSessionId} failed: ${del.status} ${text}`);
  }
}

export async function createDelegation(
  client: CoordinatorClient,
  bearer: string,
  req: DelegationRequest,
): Promise<DelegationResponse> {
  const constraints = req.constraints
    ? {
        resources: req.constraints.resources,
        actions: req.constraints.actions,
        max_depth: req.constraints.maxDepth,
        expires_at: req.constraints.expiresAt,
      }
    : undefined;
  const res = await call<DelegationResponse>(client, "POST", `/zones/${encodeURIComponent(req.zoneId)}/delegations`, bearer, {
    issuer_application_id: req.issuerApplicationId,
    source_session_id: req.sourceSessionId,
    target_session_id: req.targetSessionId,
    receiver_application_id: req.receiverApplicationId,
    scopes: req.scopes,
    constraints,
    ttl_seconds: req.ttlSeconds,
  });
  if (!res.delegation_edge_id && res.id) res.delegation_edge_id = res.id;
  return res;
}
