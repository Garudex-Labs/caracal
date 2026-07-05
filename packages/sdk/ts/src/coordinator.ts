/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Coordinator REST client used by SDK primitives.
 */

import type { JsonObject } from './json.js'

/** One completed coordinator request and its outcome; status 0 means no response arrived. */
export interface CoordinatorCallEvent {
  type: 'coordinator.call'
  method: string
  path: string
  status: number
  ok: boolean
  durationMs: number
}

export interface CoordinatorClient {
  baseUrl: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** Observability sink attached by the Caracal facade; failures inside it never reach the caller. */
  onEvent?: (event: CoordinatorCallEvent) => void
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

export type AgentStatus = 'starting' | 'healthy' | 'degraded' | 'unhealthy'

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
  parentAuthority?: 'inherit' | 'none'
}

export interface SpawnResponse {
  agentSessionId: string
  delegationEdgeId?: string
  heartbeatDeadlineAt?: string
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

/** The created delegation edge: its id, the scopes it bounds, and when it lapses. */
export interface DelegationResponse {
  delegationEdgeId: string
  scopes: string[]
  expiresAt?: string
}

export interface HeartbeatResponse {
  status?: string
  heartbeatDeadlineAt?: string
}

async function call<T>(
  client: CoordinatorClient,
  method: string,
  path: string,
  bearer: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  const fetchFn = client.fetchImpl ?? fetch
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${bearer}`,
    ...(extraHeaders ?? {}),
  }
  const start = performance.now()
  const emit = (status: number, ok: boolean): void => {
    if (!client.onEvent) return
    try {
      client.onEvent({ type: 'coordinator.call', method, path, status, ok, durationMs: performance.now() - start })
    } catch {
      // The observability sink must never break the coordinator path.
    }
  }
  const timeout = AbortSignal.timeout(client.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  // Trailing slashes are trimmed with a linear scan: a quantified-regex trim backtracks
  // quadratically on long slash runs (js/polynomial-redos), and the URL is library input.
  let baseEnd = client.baseUrl.length
  while (baseEnd > 0 && client.baseUrl[baseEnd - 1] === '/') baseEnd--
  let res: Response
  try {
    res = await fetchFn(`${client.baseUrl.slice(0, baseEnd)}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    })
  } catch (err) {
    emit(0, false)
    throw err
  }
  if (!res.ok) {
    const text = await res.text()
    emit(res.status, false)
    throw new CoordinatorError(method, path, res.status, text)
  }
  emit(res.status, true)
  if (res.status === 204) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export async function spawnAgent(
  client: CoordinatorClient,
  bearer: string,
  req: SpawnRequest,
  signal?: AbortSignal,
): Promise<SpawnResponse> {
  const headers = req.idempotencyKey ? { 'idempotency-key': req.idempotencyKey } : undefined
  const res = await call<{ agent_session_id?: string; delegation_edge_id?: string | null; heartbeat_deadline_at?: string | null }>(
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
      parent_authority: req.parentAuthority,
    },
    headers,
    signal,
  )
  if (!res?.agent_session_id) throw new Error('coordinator spawn response missing agent_session_id')
  return {
    agentSessionId: res.agent_session_id,
    delegationEdgeId: res.delegation_edge_id ?? undefined,
    heartbeatDeadlineAt: res.heartbeat_deadline_at ?? undefined,
  }
}

export async function terminateAgent(client: CoordinatorClient, bearer: string, zoneId: string, agentSessionId: string): Promise<void> {
  await call<unknown>(client, 'DELETE', `/zones/${encodeURIComponent(zoneId)}/agents/${encodeURIComponent(agentSessionId)}`, bearer)
}

export async function createDelegation(
  client: CoordinatorClient,
  bearer: string,
  req: DelegationRequest,
  signal?: AbortSignal,
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
    : undefined
  const res = await call<{ delegation_edge_id?: string; scopes?: string[]; expires_at?: string | null }>(
    client,
    'POST',
    `/zones/${encodeURIComponent(req.zoneId)}/delegations`,
    bearer,
    {
      issuer_application_id: req.issuerApplicationId,
      source_session_id: req.sourceSessionId,
      target_session_id: req.targetSessionId,
      receiver_application_id: req.receiverApplicationId,
      parent_edge_id: req.parentEdgeId,
      resource_id: req.resourceId,
      scopes: req.scopes,
      constraints,
      ttl_seconds: req.ttlSeconds,
    },
    undefined,
    signal,
  )
  if (!res?.delegation_edge_id) throw new Error('coordinator delegation response missing delegation_edge_id')
  return {
    delegationEdgeId: res.delegation_edge_id,
    scopes: res.scopes ?? [],
    expiresAt: res.expires_at ?? undefined,
  }
}

export async function heartbeatAgent(
  client: CoordinatorClient,
  bearer: string,
  zoneId: string,
  agentSessionId: string,
  status: AgentStatus = 'healthy',
): Promise<HeartbeatResponse> {
  const res = await call<{ agent?: { status?: string; heartbeat_deadline_at?: string | null } }>(
    client,
    'POST',
    `/zones/${encodeURIComponent(zoneId)}/agents/${encodeURIComponent(agentSessionId)}/heartbeat`,
    bearer,
    { status },
  )
  return { status: res?.agent?.status, heartbeatDeadlineAt: res?.agent?.heartbeat_deadline_at ?? undefined }
}
