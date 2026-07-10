/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * SDK primitives: run governed sessions and delegate authority.
 */

import { bind, cloneBaggage, current, CaracalContext } from './context.js'
import {
  SessionStatus,
  CoordinatorClient,
  CoordinatorError,
  DelegationResponse,
  StartSessionResponse,
  startCoordinatorSession,
  terminateAgent,
  heartbeatAgent,
  createDelegation,
  Lifecycle,
  DelegationConstraints,
} from './coordinator.js'
import type { JsonObject } from './json.js'

const SESSION_RETRIES = 2
const MIN_AUTO_HEARTBEAT_MS = 1_000
const MAX_AUTO_HEARTBEAT_MS = 300_000
const FALLBACK_AUTO_HEARTBEAT_MS = 30_000

type WarnSink = (message: string, err?: unknown) => void

function defaultWarn(message: string, err?: unknown): void {
  if (err === undefined) console.warn(message)
  else console.warn(message, err)
}

/** A session the coordinator no longer holds live (terminated or reaped) counts as retired. */
function isGone(e: unknown): boolean {
  return e instanceof CoordinatorError && (e.status === 404 || e.status === 409)
}

// A server-requested Retry-After wins over the default backoff, capped so a
// hostile or misconfigured header cannot stall the caller for minutes.
const RETRY_AFTER_CAP_SECONDS = 10

function backoff(attempt: number, signal?: AbortSignal, hintSeconds?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      return
    }
    const delay =
      hintSeconds !== undefined
        ? Math.min(hintSeconds, RETRY_AFTER_CAP_SECONDS) * 1000 + Math.random() * 100
        : 250 * (attempt + 1) + Math.random() * 100
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delay)
    timer.unref?.()
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export type AuthorityMode = 'inherit' | 'narrow' | 'none'

/**
 * Authority handed to a child session. `inherit` (the default) carries the
 * parent's effective authority forward: the coordinator resolves the parent's
 * active narrowing delegation server-side and mirrors it onto the child (same
 * scopes, resource, constraints, and expiry), so least-privilege is transitive
 * by default. A parent holding no inbound delegation yields a child with the
 * application's policy-bounded authority; under the platform decision contract
 * resource mandates only mint over a delegation, so resource authority enters
 * a session tree through `narrow` or an accepted delegation. Inheritance never
 * crosses an application boundary. `narrow` issues a bounded delegation so the
 * child holds only the listed scopes; the server re-validates the subset, so a
 * narrow can never broaden. `none` starts an explicitly delegation-less child.
 */
export interface Authority {
  mode: AuthorityMode
  scopes?: string[]
  resourceId?: string
  constraints?: DelegationConstraints
  ttlSeconds?: number
}

export const Authority = {
  inherit(): Authority {
    return { mode: 'inherit' }
  },
  none(): Authority {
    return { mode: 'none' }
  },
  /**
   * A narrowing delegation defaults to a hop budget of 1; pass
   * `constraints: { maxHops: 2 }` (or more) when the child must re-delegate or
   * sub-narrow its slice further down the tree. A single scope may be passed
   * as a bare string.
   */
  narrow(scopes: string | string[], opts?: { resourceId?: string; constraints?: DelegationConstraints; ttlSeconds?: number }): Authority {
    return { mode: 'narrow', scopes: typeof scopes === 'string' ? [scopes] : scopes, ...opts }
  },
}

export interface SessionInput {
  coordinator: CoordinatorClient
  zoneId: string
  applicationId: string
  subjectToken: string
  tokenSource?: () => string | Promise<string>
  invalidate?: () => void
  /** Authority record attached to the Session for Coordinator attribution; it does not alone propagate the user sub to later mints. */
  subjectAuthorityRecordId?: string
  /** Session to parent under; defaults to the session bound on the calling context. */
  parentSessionId?: string
  authority?: Authority
  ttlSeconds?: number
  metadata?: JsonObject
  labels?: string[]
  traceId?: string
  /** Caller-supplied Session-start idempotency key; redelivery resumes the Session instead of creating a duplicate. */
  idempotencyKey?: string
  signal?: AbortSignal
  /** Receives operational warnings (cleanup failures); defaults to console.warn. */
  warn?: WarnSink
  onSessionStart?: (ctx: CaracalContext) => void | Promise<void>
  onSessionEnd?: (ctx: CaracalContext) => void | Promise<void>
}

interface EstablishInput {
  coordinator: CoordinatorClient
  zoneId: string
  applicationId: string
  subjectToken: string
  tokenSource?: () => string | Promise<string>
  invalidate?: () => void
  subjectAuthorityRecordId?: string
  parentSessionId?: string
  authority?: Authority
  ttlSeconds?: number
  metadata?: JsonObject
  labels?: string[]
  traceId?: string
  idempotencyKey?: string
  signal?: AbortSignal
  warn?: WarnSink
}

interface Established {
  sessionId: string
  ctx: CaracalContext
  bearer: () => Promise<string>
  heartbeatDeadlineAt?: string
}

/**
 * Lifecycle operations that outlive the establishing call (cleanup terminates,
 * lease heartbeats) resolve a fresh bearer from the token source when one is
 * configured, so a token that expired since the session started never strands
 * the session.
 */
async function establishSession(input: EstablishInput, lifecycle?: Lifecycle): Promise<Established> {
  const authority = input.authority ?? Authority.inherit()
  const parent = current()
  const parentId = input.parentSessionId ?? parent?.sessionId
  let token = input.subjectToken
  const bearer = async () => (input.tokenSource ? await input.tokenSource() : token)
  if (input.idempotencyKey !== undefined) validateIdempotencyKey(input.idempotencyKey)
  const generatedIdempotencyKey = input.idempotencyKey === undefined
  const startReq = {
    zoneId: input.zoneId,
    applicationId: input.applicationId,
    subjectAuthorityRecordId: input.subjectAuthorityRecordId,
    parentId,
    lifecycle,
    ttlSeconds: input.ttlSeconds,
    metadata: input.metadata,
    labels: input.labels,
    // Narrowed (or none) authority suppresses server-side inheritance: the
    // child must hold exactly the granted slice, not a mirrored copy of the
    // parent's wider delegation alongside it.
    parentAuthority: (authority.mode === 'inherit' ? 'inherit' : 'none') as 'inherit' | 'none',
    idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
    idempotencyKeyGenerated: generatedIdempotencyKey,
  }
  let res: StartSessionResponse | undefined
  let refreshed = false
  for (let attempt = 0; res === undefined; attempt++) {
    try {
      res = await startCoordinatorSession(input.coordinator, token, startReq, input.signal)
    } catch (e) {
      if (input.signal?.aborted) throw e
      // A cached token can be rejected before its exp (server-side session
      // revocation after a credential rotation); force one refresh and retry
      // the Session start once. The jittered pause spreads the refresh across a fleet
      // so a mass revocation cannot stampede the STS.
      if (e instanceof CoordinatorError && e.status === 401 && !refreshed && input.invalidate && input.tokenSource) {
        refreshed = true
        input.invalidate()
        await backoff(0, input.signal)
        token = await input.tokenSource()
        continue
      }
      // The idempotency key makes retrying a network failure or 5xx safe: the
      // coordinator replays the already-created session instead of minting a
      // duplicate.
      const transient = !(e instanceof CoordinatorError) || e.status >= 500
      if (!transient || attempt >= SESSION_RETRIES) throw e
      await backoff(attempt, input.signal, e instanceof CoordinatorError ? e.retryAfterSeconds : undefined)
    }
  }

  let delegationId = res.delegationId
  let hop = delegationId && parent ? parent.hop + 1 : (parent?.hop ?? 0)
  try {
    if (authority.mode === 'narrow') {
      if (!parent || !parent.sessionId) {
        throw new Error('Authority.narrow requires an active parent session')
      }
      const delRes = await createDelegation(
        input.coordinator,
        parent.subjectToken,
        {
          zoneId: input.zoneId,
          issuerApplicationId: parent.applicationId,
          sourceSessionId: parent.sessionId,
          targetSessionId: res.sessionId,
          receiverApplicationId: input.applicationId,
          parentEdgeId: parent.delegationId,
          resourceId: authority.resourceId,
          scopes: authority.scopes ?? [],
          constraints: authority.constraints,
          ttlSeconds: authority.ttlSeconds,
        },
        input.signal,
      )
      delegationId = delRes.delegationId
      hop = parent.hop + 1
    }
  } catch (e) {
    await retire(input.coordinator, bearer, input.zoneId, res.sessionId, input.warn)
    throw e
  }

  const ctx: CaracalContext = {
    subjectToken: token,
    zoneId: input.zoneId,
    applicationId: input.applicationId,
    sessionId: res.sessionId,
    delegationId,
    parentDelegationId: parent?.delegationId,
    subjectAuthorityRecordId: input.subjectAuthorityRecordId ?? parent?.subjectAuthorityRecordId,
    traceId: input.traceId ?? parent?.traceId,
    traceFlags: parent?.traceFlags,
    traceState: parent?.traceState,
    baggage: cloneBaggage(parent?.baggage),
    hop,
    ownToken: true,
  }
  return { sessionId: res.sessionId, ctx, bearer, heartbeatDeadlineAt: res.heartbeatDeadlineAt }
}

function validateIdempotencyKey(key: string): void {
  if (!key || key !== key.trim() || new TextEncoder().encode(key).length > 255 || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new Error(
      'idempotencyKey must be non-empty, at most 255 UTF-8 bytes, and contain no surrounding whitespace or control characters',
    )
  }
}

/**
 * Terminate a session on a cleanup path. A session the coordinator already
 * retired counts as success; any other failure is reported to the warn sink
 * rather than thrown so cleanup never masks the caller's primary outcome —
 * the coordinator's TTL sweeper retires whatever this misses.
 */
async function retire(
  coordinator: CoordinatorClient,
  bearer: () => Promise<string>,
  zoneId: string,
  sessionId: string,
  warn: WarnSink = defaultWarn,
): Promise<void> {
  try {
    await terminateAgent(coordinator, await bearer(), zoneId, sessionId)
  } catch (e) {
    if (isGone(e)) return
    warn(`caracal: terminate failed for session ${sessionId}; the coordinator TTL sweeper will retire it`, e)
  }
}

/**
 * Run fn inside a governed session bound to the calling context. The session
 * carries identity and bounded authority for whatever fn executes, records
 * audit attribution, and is retired when fn returns. By default the
 * coordinator carries the parent's effective authority forward by mirroring
 * its active narrowing delegation onto the child; pass
 * `authority: Authority.narrow([...])` to bound the child to a subset of
 * scopes instead.
 */
export async function session<T>(input: SessionInput, fn: (ctx: CaracalContext) => Promise<T>): Promise<T> {
  const established = await establishSession(input)
  const { ctx, sessionId, bearer } = established
  let started = false
  try {
    if (input.onSessionStart) await input.onSessionStart(ctx)
    started = true
    return await bind(ctx, () => fn(ctx))
  } finally {
    try {
      if (started && input.onSessionEnd) await input.onSessionEnd(ctx)
    } finally {
      await retire(input.coordinator, bearer, input.zoneId, sessionId, input.warn)
    }
  }
}

export interface DelegateInput {
  coordinator: CoordinatorClient
  toSessionId: string
  toApplicationId: string
  resourceId?: string
  scopes: string[]
  constraints?: DelegationConstraints
  ttlSeconds?: number
  signal?: AbortSignal
}

/** A delegation issued to a peer session: its id, the scopes it carries, and when it expires. */
export interface Delegation {
  delegationId: string
  scopes: string[]
  expiresAt?: string
}

/**
 * Delegate a slice of the current session's authority to an existing peer
 * session, typically one running under another application. The delegation is
 * created issuer-side and returned as a handle; it does not change the local
 * context, because the authority now belongs to the receiver. The receiving
 * session presents the delegation by binding it into its own context with
 * acceptDelegation.
 */
export async function delegate(input: DelegateInput): Promise<Delegation> {
  const ctx = current()
  if (!ctx) throw new Error('delegate requires a Caracal context bound on this path')
  if (!ctx.sessionId) {
    throw new Error('delegate requires an active session in context')
  }
  const req = {
    zoneId: ctx.zoneId,
    issuerApplicationId: ctx.applicationId,
    sourceSessionId: ctx.sessionId,
    targetSessionId: input.toSessionId,
    receiverApplicationId: input.toApplicationId,
    parentEdgeId: ctx.delegationId,
    resourceId: input.resourceId,
    scopes: input.scopes,
    constraints: input.constraints,
    ttlSeconds: input.ttlSeconds,
    // The key makes retrying a network failure or 5xx safe: the coordinator
    // replays the already-created delegation instead of issuing a duplicate.
    idempotencyKey: crypto.randomUUID(),
  }
  let res: DelegationResponse | undefined
  for (let attempt = 0; res === undefined; attempt++) {
    try {
      res = await createDelegation(input.coordinator, ctx.subjectToken, req, input.signal)
    } catch (e) {
      if (input.signal?.aborted) throw e
      const transient = !(e instanceof CoordinatorError) || e.status >= 500
      if (!transient || attempt >= 1) throw e
      await backoff(attempt, input.signal, e instanceof CoordinatorError ? e.retryAfterSeconds : undefined)
    }
  }
  return { delegationId: res.delegationId, scopes: res.scopes, expiresAt: res.expiresAt }
}

/**
 * Accept a delegation received from a peer: derive a context whose token
 * exchanges present the delegation. Call this in the receiving session, with
 * the receiver's own context, after the delegation id arrives over whatever
 * channel the two parties share.
 */
export function acceptDelegation(ctx: CaracalContext, delegationId: string): CaracalContext {
  return {
    ...ctx,
    parentDelegationId: ctx.delegationId,
    delegationId,
    baggage: cloneBaggage(ctx.baggage),
    hop: ctx.hop + 1,
  }
}

export interface StartSessionInput {
  coordinator: CoordinatorClient
  zoneId: string
  applicationId: string
  subjectToken: string
  tokenSource?: () => string | Promise<string>
  invalidate?: () => void
  /** Authority record attached to the Session for Coordinator attribution; it does not alone propagate the user sub to later mints. */
  subjectAuthorityRecordId?: string
  /** Session to parent under; defaults to the session bound on the calling context. */
  parentSessionId?: string
  authority?: Authority
  ttlSeconds?: number
  metadata?: JsonObject
  labels?: string[]
  traceId?: string
  /** Caller-supplied Session-start idempotency key; redelivery resumes the Session instead of creating a duplicate. */
  idempotencyKey?: string
  /**
   * Auto-heartbeat cadence. Leave unset to derive it from the server lease
   * (renewing at roughly a third of the remaining lease, with jitter); a
   * positive value fixes the interval; zero or a negative value disables the
   * background timer, leaving the lease to manual heartbeat calls.
   */
  heartbeatIntervalMs?: number
  /**
   * Called once if the coordinator reports the session permanently gone
   * (terminated or lease-reaped) so the holder can rebuild; the auto-heartbeat
   * timer stops at that point because no beat can revive the session.
   */
  onLeaseLost?: (err: unknown) => void
  onStateChange?: (status: string) => void
  signal?: AbortSignal
  /** Receives operational warnings (lease loss, heartbeat retries, cleanup failures); defaults to console.warn. */
  warn?: WarnSink
  onSessionStart?: (ctx: CaracalContext) => void | Promise<void>
  /** Called by close before the session terminates, mirroring session's end hook. */
  onSessionEnd?: (ctx: CaracalContext) => void | Promise<void>
}

/**
 * Handle for a long-lived session started with startSession. Unlike session,
 * it is not retired automatically when a block exits: a background timer
 * renews the lease by default (see StartSessionInput.heartbeatIntervalMs) and
 * the holder retires the session with close.
 */
export interface SessionHandle {
  context: CaracalContext
  sessionId: string
  /** The lease deadline the coordinator reported on the last renewal; undefined until the server reports one. */
  readonly deadlineAt: string | undefined
  readonly status: string
  heartbeat: (status?: SessionStatus) => Promise<void>
  close: () => Promise<void>
}

export async function startSession(input: StartSessionInput): Promise<SessionHandle> {
  const established = await establishSession(input, Lifecycle.Service)
  const { ctx, sessionId, bearer } = established
  if (input.onSessionStart) {
    try {
      await input.onSessionStart(ctx)
    } catch (e) {
      await retire(input.coordinator, bearer, input.zoneId, sessionId, input.warn)
      throw e
    }
  }
  return leaseHandle(input, ctx, sessionId, bearer, established.heartbeatDeadlineAt)
}

export interface AttachSessionInput {
  coordinator: CoordinatorClient
  zoneId: string
  applicationId: string
  subjectToken: string
  tokenSource?: () => string | Promise<string>
  invalidate?: () => void
  /** The service session to re-attach to, from a previous startSession in this or another process. */
  sessionId: string
  heartbeatIntervalMs?: number
  onLeaseLost?: (err: unknown) => void
  onStateChange?: (status: string) => void
  warn?: WarnSink
  onSessionEnd?: (ctx: CaracalContext) => void | Promise<void>
}

/**
 * Re-attach to a service session that already exists - typically after a
 * process restart, using a session id the previous holder persisted. The
 * session is validated with an immediate lease renewal (a session the
 * coordinator no longer holds live fails with CoordinatorError), and the
 * returned handle renews and retires it exactly like one from startSession.
 * The rebuilt context carries the session identity only; delegations bound by
 * the previous holder are re-presented with acceptDelegation.
 */
export async function attachSession(input: AttachSessionInput): Promise<SessionHandle> {
  let token = input.tokenSource ? await input.tokenSource() : input.subjectToken
  const bearer = async () => (input.tokenSource ? await input.tokenSource() : input.subjectToken)
  let first
  try {
    first = await heartbeatAgent(input.coordinator, token, input.zoneId, input.sessionId)
  } catch (err) {
    if (!(err instanceof CoordinatorError) || err.status !== 401 || !input.invalidate || !input.tokenSource) throw err
    input.invalidate()
    token = await input.tokenSource()
    first = await heartbeatAgent(input.coordinator, token, input.zoneId, input.sessionId)
  }
  const ctx: CaracalContext = {
    subjectToken: token,
    zoneId: input.zoneId,
    applicationId: input.applicationId,
    sessionId: input.sessionId,
    hop: 0,
    ownToken: true,
  }
  return leaseHandle(input, ctx, input.sessionId, bearer, first.heartbeatDeadlineAt, first.status)
}

interface LeaseInput {
  coordinator: CoordinatorClient
  zoneId: string
  invalidate?: () => void
  heartbeatIntervalMs?: number
  onLeaseLost?: (err: unknown) => void
  onStateChange?: (status: string) => void
  warn?: WarnSink
  onSessionEnd?: (ctx: CaracalContext) => void | Promise<void>
}

function leaseHandle(
  input: LeaseInput,
  ctx: CaracalContext,
  sessionId: string,
  bearer: () => Promise<string>,
  initialDeadlineAt: string | undefined,
  initialStatus = 'active',
): SessionHandle {
  const warn = input.warn ?? defaultWarn
  let deadlineAt = initialDeadlineAt
  let sessionStatus = initialStatus
  let suspendedNotified = false
  const heartbeat = async (status?: SessionStatus) => {
    let res
    try {
      res = await heartbeatAgent(input.coordinator, await bearer(), input.zoneId, sessionId, status)
    } catch (e) {
      // A cached token can be rejected before its exp (server-side session
      // revocation after a credential rotation); force one refresh and retry
      // so the lease survives the rotation.
      if (!(e instanceof CoordinatorError) || e.status !== 401 || !input.invalidate) throw e
      input.invalidate()
      res = await heartbeatAgent(input.coordinator, await bearer(), input.zoneId, sessionId, status)
    }
    deadlineAt = res.heartbeatDeadlineAt ?? deadlineAt
    if (res.status && res.status !== sessionStatus) {
      sessionStatus = res.status
      input.onStateChange?.(sessionStatus)
    }
    if (sessionStatus === 'suspended') {
      stopped = true
      if (!suspendedNotified) suspendedNotified = true
    }
  }
  const mode = input.heartbeatIntervalMs === undefined ? 'auto' : input.heartbeatIntervalMs > 0 ? 'fixed' : 'manual'
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let closing: Promise<void> | undefined
  const nextDelayMs = () => {
    if (mode === 'fixed') return input.heartbeatIntervalMs as number
    const jitter = 0.9 + Math.random() * 0.2
    const remainingMs = deadlineAt ? Date.parse(deadlineAt) - Date.now() : NaN
    if (!Number.isFinite(remainingMs)) return FALLBACK_AUTO_HEARTBEAT_MS * jitter
    return Math.min(Math.max(remainingMs / 3, MIN_AUTO_HEARTBEAT_MS), MAX_AUTO_HEARTBEAT_MS) * jitter
  }
  const run = async () => {
    try {
      await heartbeat()
    } catch (err) {
      if (isGone(err)) {
        stopped = true
        // A beat racing close sees the session gone because close terminated
        // it; that is an ordinary shutdown, not a lost lease.
        if (!closing) {
          warn(`caracal: lease lost for session ${sessionId}; auto-heartbeat stopped`, err)
          input.onLeaseLost?.(err)
        }
        return
      }
      warn(`caracal: auto-heartbeat failed for session ${sessionId}; retrying`, err)
    }
    schedule()
  }
  const schedule = () => {
    if (stopped) return
    timer = setTimeout(run, nextDelayMs())
    timer.unref?.()
  }
  if (mode !== 'manual') schedule()
  return {
    context: ctx,
    sessionId,
    get deadlineAt() {
      return deadlineAt
    },
    get status() {
      return sessionStatus
    },
    heartbeat,
    close: () =>
      (closing ??= (async () => {
        stopped = true
        if (timer) clearTimeout(timer)
        try {
          if (input.onSessionEnd) await input.onSessionEnd(ctx)
        } finally {
          try {
            await terminateAgent(input.coordinator, await bearer(), input.zoneId, sessionId)
          } catch (e) {
            if (!isGone(e)) throw e
          }
        }
      })()),
  }
}
