/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Coordinator REST client used by SDK primitives.
 */

import type { JsonObject } from './json.js'

export interface CoordinatorClient {
  baseUrl: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 10_000

/** Coordinator rejected a request; carries the HTTP status so callers can branch on it. */
export class CoordinatorError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    body: string,
  ) {
    super(`coordinator ${method} ${path} failed: ${status} ${body}`)
    this.name = 'CoordinatorError'
  }
}

export const Lifecycle = {
  Task: 'task',
  Service: 'service',
} as const

export type Lifecycle = (typeof Lifecycle)[keyof typeof Lifecycle]

export interface DelegationConstraints {
  resources?: string[]
  maxDepth?: number
  maxHops?: number
  ttlSeconds?: number
  budget?: number
  policyApproved?: boolean
  expiresAt?: string
  broadReason?: string
}

export interface SpawnRequest {
  zoneId: string
  applicationId: string
  subjectSessionId?: string
  parentId?: string
  lifecycle?: Lifecycle
  ttlSeconds?: number
  metadata?: JsonObject
  labels?: string[]
  idempotencyKey?: string
  inheritParentEdgeId?: string
}

export interface SpawnResponse {
  agent_session_id: string
  delegation_edge_id?: string | null
}

export interface DelegationRequest {
  zoneId: string
  issuerApplicationId: string
  sourceSessionId: string
  targetSessionId: string
  receiverApplicationId: string
  parentEdgeId?: string
  resourceId?: string
  scopes: string[]
  constraints?: DelegationConstraints
  ttlSeconds?: number
}

export interface DelegationResponse {
  delegation_edge_id: string
}

async function call<T>(
  client: CoordinatorClient,
  method: string,
  path: string,
  bearer: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const fetchFn = client.fetchImpl ?? fetch
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${bearer}`,
    ...(extraHeaders ?? {}),
  }
  const res = await fetchFn(`${client.baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(client.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new CoordinatorError(method, path, res.status, text)
  }
  if (res.status === 204) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export async function spawnAgent(client: CoordinatorClient, bearer: string, req: SpawnRequest): Promise<SpawnResponse> {
  const headers = req.idempotencyKey ? { 'idempotency-key': req.idempotencyKey } : undefined
  const res = await call<SpawnResponse>(
    client,
    'POST',
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
  )
  return res
}

export async function terminateAgent(client: CoordinatorClient, bearer: string, zoneId: string, agentSessionId: string): Promise<void> {
  await call<unknown>(
    client,
    'DELETE',
    `/zones/${encodeURIComponent(zoneId)}/agents/${encodeURIComponent(agentSessionId)}`,
    bearer,
  )
}

export async function createDelegation(client: CoordinatorClient, bearer: string, req: DelegationRequest): Promise<DelegationResponse> {
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
    : undefined
  return call<DelegationResponse>(client, 'POST', `/zones/${encodeURIComponent(req.zoneId)}/delegations`, bearer, {
    issuer_application_id: req.issuerApplicationId,
    source_session_id: req.sourceSessionId,
    target_session_id: req.targetSessionId,
    receiver_application_id: req.receiverApplicationId,
    parent_edge_id: req.parentEdgeId,
    resource_id: req.resourceId ?? null,
    scopes: req.scopes,
    constraints,
    ttl_seconds: req.ttlSeconds,
  })
}

export async function heartbeatAgent(
  client: CoordinatorClient,
  bearer: string,
  zoneId: string,
  agentSessionId: string,
  status: 'starting' | 'healthy' | 'degraded' | 'unhealthy' = 'healthy',
): Promise<void> {
  await call<unknown>(
    client,
    'POST',
    `/zones/${encodeURIComponent(zoneId)}/agents/${encodeURIComponent(agentSessionId)}/heartbeat`,
    bearer,
    { status },
  )
}
