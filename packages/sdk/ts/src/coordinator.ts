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
  /** True when the Coordinator returned a durable idempotency receipt instead of creating a new resource. */
  replayed?: boolean
  /** Structured Coordinator error code, when the response used the standard JSON envelope. */
  code?: string
  requestId?: string
}

export interface CoordinatorClient {
  baseUrl: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** Observability sink attached by the Caracal facade; failures inside it never reach the caller. */
  onEvent?: (event: CoordinatorCallEvent) => void
}

const DEFAULT_TIMEOUT_MS = 10_000

// Error bodies are capped so an oversized or sensitive-payload response never
// lands wholesale in logs and error trackers.
const ERROR_BODY_CAP = 2048

/** Coordinator rejected a request; carries the HTTP status so callers can branch on it. */
export class CoordinatorError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    body: string,
    /** Server-requested retry delay parsed from Retry-After, when present. */
    readonly retryAfterSeconds?: number,
    readonly code?: string,
    readonly requestId?: string,
  ) {
    super(
      `coordinator ${method} ${path} failed: ${status} ${body.length > ERROR_BODY_CAP ? `${body.slice(0, ERROR_BODY_CAP)}… (truncated)` : body}`,
    )
    this.name = 'CoordinatorError'
  }
}

function retryAfterSeconds(res: Response): number | undefined {
  const raw = res.headers.get('retry-after')
  if (!raw) return undefined
  const secs = Number(raw)
  if (Number.isFinite(secs) && secs >= 0) return secs
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, (at - Date.now()) / 1000)
}

/**
 * Session kinds: a Task session lives by its wall-clock TTL and suits bounded
 * work; a Service session lives by its heartbeat lease and suits daemons and
 * workers. session() records a task, startSession() records a service.
 */
export const Lifecycle = {
  Task: 'task',
  Service: 'service',
} as const

export type Lifecycle = (typeof Lifecycle)[keyof typeof Lifecycle]

export type SessionStatus = 'starting' | 'healthy' | 'degraded' | 'unhealthy'

export interface DelegationConstraints {
  resources?: string[]
  maxDepth?: number
  maxHops?: number
  ttlSeconds?: number
  /** Audit and display metadata; it does not itself authorize the Delegation. */
  policyApproved?: boolean
  expiresAt?: string
  /** Audit and display metadata describing an elevated resource-unbounded offer. */
  broadReason?: string
}

export interface StartSessionRequest {
  zoneId: string
  applicationId: string
  subjectAuthorityRecordId?: string
  subjectAuthorityRecordToken?: string
  parentId?: string
  lifecycle?: Lifecycle
  ttlSeconds?: number
  metadata?: JsonObject
  labels?: string[]
  idempotencyKey?: string
  idempotencyKeyGenerated?: boolean
  parentAuthority?: 'inherit' | 'none'
}

export interface StartSessionResponse {
  sessionId: string
  delegationId?: string
  heartbeatDeadlineAt?: string
  leaseGeneration: number
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
  idempotencyKey?: string
}

/** The created Delegation: its ID, the scopes it bounds, and when it lapses. */
export interface DelegationResponse {
  delegationId: string
  scopes: string[]
  expiresAt?: string
}

export interface HeartbeatResponse {
  status?: string
  heartbeatDeadlineAt?: string
  leaseGeneration: number
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
  // A content-type on a body-less request (DELETE, heartbeat POSTs without payload) makes
  // strict JSON parsers reject the empty body, so the header rides only with a body.
  const headers: Record<string, string> = {
    ...(body ? { 'content-type': 'application/json' } : {}),
    authorization: `Bearer ${bearer}`,
    ...(extraHeaders ?? {}),
  }
  const start = performance.now()
  const emit = (status: number, ok: boolean, details: { replayed?: boolean; code?: string; requestId?: string } = {}): void => {
    if (!client.onEvent) return
    try {
      client.onEvent({ type: 'coordinator.call', method, path, status, ok, durationMs: performance.now() - start, ...details })
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
    let error: { error?: unknown; request_id?: unknown } = {}
    try {
      error = JSON.parse(text)
    } catch {
      // Non-JSON responses remain available through the bounded error body.
    }
    const code = typeof error.error === 'string' ? error.error : undefined
    const requestId = typeof error.request_id === 'string' ? error.request_id : (res.headers.get('x-request-id') ?? undefined)
    emit(res.status, false, { code, requestId })
    throw new CoordinatorError(method, path, res.status, text, retryAfterSeconds(res), code, requestId)
  }
  emit(res.status, true, { replayed: res.headers.get('idempotency-replayed') === 'true' })
  if (res.status === 204) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export async function startCoordinatorSession(
  client: CoordinatorClient,
  bearer: string,
  req: StartSessionRequest,
  signal?: AbortSignal,
): Promise<StartSessionResponse> {
  const headers = req.idempotencyKey
    ? {
        'idempotency-key': req.idempotencyKey,
        ...(req.idempotencyKeyGenerated ? { 'idempotency-key-kind': 'generated' } : {}),
      }
    : undefined
  const res = await call<{
    agent_session_id?: string
    delegation_edge_id?: string | null
    heartbeat_deadline_at?: string | null
    lease_generation?: number
  }>(
    client,
    'POST',
    `/zones/${encodeURIComponent(req.zoneId)}/agents`,
    bearer,
    {
      application_id: req.applicationId,
      subject_session_id: req.subjectAuthorityRecordId,
      subject_token: req.subjectAuthorityRecordToken,
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
  if (!res?.agent_session_id) throw new Error('coordinator session response missing agent_session_id')
  if (!Number.isSafeInteger(res.lease_generation) || (req.lifecycle === Lifecycle.Service && res.lease_generation < 1)) {
    throw new Error('coordinator session response missing valid lease_generation')
  }
  return {
    sessionId: res.agent_session_id,
    delegationId: res.delegation_edge_id ?? undefined,
    heartbeatDeadlineAt: res.heartbeat_deadline_at ?? undefined,
    leaseGeneration: res.lease_generation,
  }
}

export async function terminateSession(
  client: CoordinatorClient,
  bearer: string,
  zoneId: string,
  sessionId: string,
  leaseGeneration?: number,
): Promise<void> {
  await call<unknown>(
    client,
    'DELETE',
    `/zones/${encodeURIComponent(zoneId)}/agents/${encodeURIComponent(sessionId)}`,
    bearer,
    leaseGeneration === undefined ? undefined : { lease_generation: leaseGeneration },
  )
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
    req.idempotencyKey ? { 'idempotency-key': req.idempotencyKey } : undefined,
    signal,
  )
  if (!res?.delegation_edge_id) throw new Error('coordinator delegation response missing delegation_edge_id')
  return {
    delegationId: res.delegation_edge_id,
    scopes: res.scopes ?? [],
    expiresAt: res.expires_at ?? undefined,
  }
}

export async function revokeDelegation(
  client: CoordinatorClient,
  bearer: string,
  zoneId: string,
  delegationId: string,
  signal?: AbortSignal,
): Promise<void> {
  await call<unknown>(
    client,
    'PATCH',
    `/zones/${encodeURIComponent(zoneId)}/delegations/${encodeURIComponent(delegationId)}/revoke`,
    bearer,
    undefined,
    undefined,
    signal,
  )
}

/** One delegation offered to a session, as the coordinator lists it. */
export interface InboundDelegation {
  delegationId: string
  status: string
  expiresAt?: string
}

export async function listInboundDelegations(
  client: CoordinatorClient,
  bearer: string,
  zoneId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<InboundDelegation[]> {
  const res = await call<{ items?: Array<{ id?: string; status?: string; expires_at?: string | null }> }>(
    client,
    'GET',
    `/zones/${encodeURIComponent(zoneId)}/delegations/inbound/${encodeURIComponent(sessionId)}`,
    bearer,
    undefined,
    undefined,
    signal,
  )
  return (res?.items ?? []).flatMap((item) =>
    item.id ? [{ delegationId: item.id, status: item.status ?? '', expiresAt: item.expires_at ?? undefined }] : [],
  )
}

export async function getInboundDelegation(
  client: CoordinatorClient,
  bearer: string,
  zoneId: string,
  sessionId: string,
  delegationId: string,
  signal?: AbortSignal,
): Promise<InboundDelegation> {
  const response = await call<{
    id?: string
    status?: string
    expires_at?: string | null
    items?: Array<{ id?: string; status?: string; expires_at?: string | null }>
  }>(
    client,
    'GET',
    `/zones/${encodeURIComponent(zoneId)}/delegations/inbound/${encodeURIComponent(sessionId)}/${encodeURIComponent(delegationId)}`,
    bearer,
    undefined,
    undefined,
    signal,
  )
  const item = response.id ? response : response.items?.find((candidate) => candidate.id === delegationId)
  if (!item) throw new Error('coordinator inbound delegation response missing id')
  if (!item.id) throw new Error('coordinator inbound delegation response missing id')
  return { delegationId: item.id, status: item.status ?? '', expiresAt: item.expires_at ?? undefined }
}

export async function heartbeatSession(
  client: CoordinatorClient,
  bearer: string,
  zoneId: string,
  sessionId: string,
  leaseGeneration: number,
  status: SessionStatus = 'healthy',
): Promise<HeartbeatResponse> {
  const res = await call<{ agent?: { status?: string; heartbeat_deadline_at?: string | null; lease_generation?: number } }>(
    client,
    'POST',
    `/zones/${encodeURIComponent(zoneId)}/agents/${encodeURIComponent(sessionId)}/heartbeat`,
    bearer,
    { status, lease_generation: leaseGeneration },
  )
  if (!Number.isSafeInteger(res?.agent?.lease_generation) || (res?.agent?.lease_generation ?? 0) < 1) {
    throw new Error('coordinator heartbeat response missing valid lease_generation')
  }
  return {
    status: res.agent?.status,
    heartbeatDeadlineAt: res.agent?.heartbeat_deadline_at ?? undefined,
    leaseGeneration: res.agent.lease_generation,
  }
}

export async function acquireSessionLease(
  client: CoordinatorClient,
  bearer: string,
  zoneId: string,
  sessionId: string,
): Promise<HeartbeatResponse> {
  const res = await call<{ status?: string; heartbeat_deadline_at?: string | null; lease_generation?: number }>(
    client,
    'POST',
    `/zones/${encodeURIComponent(zoneId)}/agents/${encodeURIComponent(sessionId)}/lease`,
    bearer,
  )
  if (!Number.isSafeInteger(res.lease_generation) || (res.lease_generation ?? 0) < 1) {
    throw new Error('coordinator lease response missing valid lease_generation')
  }
  return {
    status: res.status,
    heartbeatDeadlineAt: res.heartbeat_deadline_at ?? undefined,
    leaseGeneration: res.lease_generation,
  }
}
