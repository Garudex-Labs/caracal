/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Coordinator REST client used by SDK primitives.
 */

import { createHash } from "node:crypto";
import type { JsonObject } from "./json.js";

export interface CoordinatorClient {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export const Lifecycle = {
  Task: "task",
  Service: "service",
} as const;

export type Lifecycle = typeof Lifecycle[keyof typeof Lifecycle];

export interface DelegationConstraints {
  resources?: string[];
  maxDepth?: number;
  maxHops?: number;
  ttlSeconds?: number;
  budget?: number;
  policyApproved?: boolean;
  expiresAt?: string;
  broadReason?: string;
}

export interface SpawnRequest {
  zoneId: string;
  applicationId: string;
  subjectSessionId?: string;
  parentId?: string;
  lifecycle?: Lifecycle;
  ttlSeconds?: number;
  metadata?: JsonObject;
  labels?: string[];
  idempotencyKey?: string;
  inheritParentEdgeId?: string;
}

export interface SpawnResponse {
  agent_session_id: string;
  delegation_edge_id?: string | null;
}

export interface DelegationRequest {
  zoneId: string;
  issuerApplicationId: string;
  sourceSessionId: string;
  targetSessionId: string;
  receiverApplicationId: string;
  parentEdgeId?: string;
  resourceId?: string;
  scopes: string[];
  constraints?: DelegationConstraints;
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
      subject_session_id: req.subjectSessionId,
      parent_id: req.parentId,
      lifecycle: req.lifecycle,
      ttl_seconds: req.ttlSeconds,
      metadata: req.metadata,
      labels: req.labels,
      inherit_parent_edge_id: req.inheritParentEdgeId,
    },
    headers,
  );
  return res;
}

/**
 * Stable key for SDK-issued spawn retries. Returns undefined when no stable
 * inputs are present: in that case the caller's retry would still require a
 * fresh session.
 */
function deriveIdempotencyKey(req: SpawnRequest): string | undefined {
  if (!req.subjectSessionId && !req.parentId) return undefined;
  const seed = [
    req.applicationId,
    req.subjectSessionId ?? "",
    req.parentId ?? "",
    String(req.lifecycle ?? ""),
    (req.labels ?? []).join(","),
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
        max_depth: req.constraints.maxDepth,
        max_hops: req.constraints.maxHops,
        ttl_seconds: req.constraints.ttlSeconds,
        budget: req.constraints.budget,
        policy_approved: req.constraints.policyApproved,
        expires_at: req.constraints.expiresAt,
        broad_reason: req.constraints.broadReason,
      }
    : undefined;
  return call<DelegationResponse>(client, "POST", `/zones/${encodeURIComponent(req.zoneId)}/delegations`, bearer, {
    issuer_application_id: req.issuerApplicationId,
    source_session_id: req.sourceSessionId,
    target_session_id: req.targetSessionId,
    receiver_application_id: req.receiverApplicationId,
    parent_edge_id: req.parentEdgeId,
    resource_id: req.resourceId ?? null,
    scopes: req.scopes,
    constraints,
    ttl_seconds: req.ttlSeconds,
  });
}

export async function heartbeatAgent(
  client: CoordinatorClient,
  bearer: string,
  zoneId: string,
  agentSessionId: string,
  status: "starting" | "healthy" | "degraded" | "unhealthy" = "healthy",
): Promise<void> {
  await call<unknown>(
    client,
    "POST",
    `/zones/${encodeURIComponent(zoneId)}/agents/${encodeURIComponent(agentSessionId)}/heartbeat`,
    bearer,
    { status },
  );
}
