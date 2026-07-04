/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * SDK primitives: spawn an agent session and delegate authority.
 */

import { bind, cloneBaggage, current, CaracalContext } from './context.js'
import {
  AgentStatus,
  CoordinatorClient,
  CoordinatorError,
  DelegationResponse,
  SpawnResponse,
  spawnAgent,
  terminateAgent,
  heartbeatAgent,
  createDelegation,
  Lifecycle,
  DelegationConstraints,
} from './coordinator.js'
import type { JsonObject } from './json.js'

const SPAWN_RETRIES = 2
const MIN_AUTO_HEARTBEAT_MS = 1_000
const MAX_AUTO_HEARTBEAT_MS = 300_000
const FALLBACK_AUTO_HEARTBEAT_MS = 30_000

/** A session the coordinator no longer holds live (terminated or reaped) counts as retired. */
function isGone(e: unknown): boolean {
  return e instanceof CoordinatorError && (e.status === 404 || e.status === 409)
}

function backoff(attempt: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, 250 * (attempt + 1) + Math.random() * 100)
    timer.unref?.()
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export type GrantMode = 'inherit' | 'narrow' | 'none'

/**
 * Authority handed to a spawned child. `inherit` (the default) carries the
 * parent's effective authority forward: the coordinator resolves the parent's
 * active narrowing edge server-side and mirrors it onto the child (same scopes,
 * resource, constraints, and expiry), so least-privilege is transitive by
 * default. A parent with no inbound edge yields an edge-less child holding the
 * application's policy-bounded authority; under the platform decision contract
 * resource mandates only mint over a delegation edge, so resource authority
 * enters a tree through `narrow` or an adopted delegation. Inheritance never
 * crosses an application boundary. `narrow` issues a bounded delegation edge so
 * the child holds only the listed scopes; the server re-validates the subset,
 * so a narrow can never broaden. `none` spawns an explicitly edge-less child.
 */
export interface Grant {
  mode: GrantMode
  scopes?: string[]
  resourceId?: string
  constraints?: DelegationConstraints
  ttlSeconds?: number
}

export const Grant = {
  inherit(): Grant {
    return { mode: 'inherit' }
  },
  none(): Grant {
    return { mode: 'none' }
  },
  /**
   * A narrow edge defaults to a hop budget of 1; pass
   * `constraints: { maxHops: 2 }` (or more) when the child must re-delegate or
   * sub-narrow its slice further down the tree.
   */
  narrow(scopes: string[], opts?: { resourceId?: string; constraints?: DelegationConstraints; ttlSeconds?: number }): Grant {
    return { mode: 'narrow', scopes, ...opts }
  },
}

export interface SpawnInput {
  coordinator: CoordinatorClient
  zoneId: string
  applicationId: string
  subjectToken: string
  tokenSource?: () => string | Promise<string>
  invalidate?: () => void
  subjectSessionId?: string
  parentId?: string
  grant?: Grant
  ttlSeconds?: number
  metadata?: JsonObject
  labels?: string[]
  traceId?: string
  signal?: AbortSignal
  onAgentStart?: (ctx: CaracalContext) => void | Promise<void>
  onAgentEnd?: (ctx: CaracalContext) => void | Promise<void>
}

interface SessionInput {
  coordinator: CoordinatorClient
  zoneId: string
  applicationId: string
  subjectToken: string
  tokenSource?: () => string | Promise<string>
  invalidate?: () => void
  subjectSessionId?: string
  parentId?: string
  grant?: Grant
  ttlSeconds?: number
  metadata?: JsonObject
  labels?: string[]
  traceId?: string
  signal?: AbortSignal
}

interface Session {
  agentSessionId: string
  ctx: CaracalContext
  bearer: () => Promise<string>
  heartbeatDeadlineAt?: string
}

/**
 * Lifecycle operations that outlive the spawn call (cleanup terminates,
 * service heartbeats) resolve a fresh bearer from the token source when one is
 * configured, so a token that expired since spawn never strands the session.
 */
async function establishSession(input: SessionInput, lifecycle?: Lifecycle): Promise<Session> {
  const grant = input.grant ?? Grant.inherit()
  const parent = current()
  const parentId = input.parentId ?? parent?.agentSessionId
  let token = input.subjectToken
  const bearer = async () => (input.tokenSource ? await input.tokenSource() : token)
  const spawnReq = {
    zoneId: input.zoneId,
    applicationId: input.applicationId,
    subjectSessionId: input.subjectSessionId,
    parentId,
    lifecycle,
    ttlSeconds: input.ttlSeconds,
    metadata: input.metadata,
    labels: input.labels,
    // A narrowing (or none) grant suppresses server-side edge inheritance:
    // the child must hold exactly the granted slice, not a mirrored copy of
    // the parent's wider edge alongside it.
    parentAuthority: (grant.mode === 'inherit' ? 'inherit' : 'none') as 'inherit' | 'none',
    idempotencyKey: crypto.randomUUID(),
  }
  let res: SpawnResponse | undefined
  let refreshed = false
  for (let attempt = 0; res === undefined; attempt++) {
    try {
      res = await spawnAgent(input.coordinator, token, spawnReq, input.signal)
    } catch (e) {
      if (input.signal?.aborted) throw e
      // A cached token can be rejected before its exp (server-side session
      // revocation after a credential rotation); force one refresh and retry
      // the spawn once.
      if (e instanceof CoordinatorError && e.status === 401 && !refreshed && input.invalidate && input.tokenSource) {
        refreshed = true
        input.invalidate()
        token = await input.tokenSource()
        continue
      }
      // The idempotency key makes retrying a network failure or 5xx safe: the
      // coordinator replays the already-created session instead of minting a
      // duplicate.
      const transient = !(e instanceof CoordinatorError) || e.status >= 500
      if (!transient || attempt >= SPAWN_RETRIES) throw e
      await backoff(attempt, input.signal)
    }
  }

  let delegationEdgeId = res.delegationEdgeId
  let hop = delegationEdgeId && parent ? parent.hop + 1 : (parent?.hop ?? 0)
  try {
    if (grant.mode === 'narrow') {
      if (!parent || !parent.agentSessionId) {
        throw new Error('grant narrow requires an active parent agent session')
      }
      const delRes = await createDelegation(
        input.coordinator,
        parent.subjectToken,
        {
          zoneId: input.zoneId,
          issuerApplicationId: parent.applicationId,
          sourceSessionId: parent.agentSessionId,
          targetSessionId: res.agentSessionId,
          receiverApplicationId: input.applicationId,
          parentEdgeId: parent.delegationEdgeId,
          resourceId: grant.resourceId,
          scopes: grant.scopes ?? [],
          constraints: grant.constraints,
          ttlSeconds: grant.ttlSeconds,
        },
        input.signal,
      )
      delegationEdgeId = delRes.delegationEdgeId
      hop = parent.hop + 1
    }
  } catch (e) {
    await retire(input.coordinator, bearer, input.zoneId, res.agentSessionId)
    throw e
  }

  const ctx: CaracalContext = {
    subjectToken: token,
    zoneId: input.zoneId,
    applicationId: input.applicationId,
    agentSessionId: res.agentSessionId,
    delegationEdgeId,
    parentEdgeId: parent?.delegationEdgeId,
    sessionId: input.subjectSessionId ?? parent?.sessionId,
    traceId: input.traceId ?? parent?.traceId,
    traceFlags: parent?.traceFlags,
    traceState: parent?.traceState,
    baggage: cloneBaggage(parent?.baggage),
    hop,
    ownToken: true,
  }
  return { agentSessionId: res.agentSessionId, ctx, bearer, heartbeatDeadlineAt: res.heartbeatDeadlineAt }
}

/**
 * Terminate a session on a cleanup path. A session the coordinator already
 * retired counts as success; any other failure is logged rather than thrown so
 * cleanup never masks the caller's primary outcome — the coordinator's TTL
 * sweeper retires whatever this misses.
 */
async function retire(
  coordinator: CoordinatorClient,
  bearer: () => Promise<string>,
  zoneId: string,
  agentSessionId: string,
): Promise<void> {
  try {
    await terminateAgent(coordinator, await bearer(), zoneId, agentSessionId)
  } catch (e) {
    if (isGone(e)) return
    console.warn(`caracal: terminate failed for agent ${agentSessionId}; the coordinator TTL sweeper will retire it`, e)
  }
}

/**
 * Spawn a child agent session and bind it to fn. By default the coordinator
 * carries the parent's effective authority forward by mirroring its active
 * narrowing edge onto the child; pass `grant: Grant.narrow([...])` to bound the
 * child to a subset of scopes instead.
 */
export async function spawn<T>(input: SpawnInput, fn: () => Promise<T>): Promise<T> {
  const session = await establishSession(input)
  const { ctx, agentSessionId, bearer } = session
  let started = false
  try {
    if (input.onAgentStart) await input.onAgentStart(ctx)
    started = true
    return await bind(ctx, fn)
  } finally {
    try {
      if (started && input.onAgentEnd) await input.onAgentEnd(ctx)
    } finally {
      await retire(input.coordinator, bearer, input.zoneId, agentSessionId)
    }
  }
}

export interface DelegateInput {
  coordinator: CoordinatorClient
  toAgentSessionId: string
  toApplicationId: string
  resourceId?: string
  scopes: string[]
  constraints?: DelegationConstraints
  ttlSeconds?: number
  signal?: AbortSignal
}

/**
 * Delegate a slice of the current agent's authority to an existing peer
 * session, typically one running under another application. The edge is
 * created issuer-side and returned as a handle; it does not change the local
 * context, because the authority now belongs to the receiver. The receiving
 * agent presents the edge by binding it into its own context with
 * adoptDelegation.
 */
export async function delegate(input: DelegateInput): Promise<DelegationResponse> {
  const ctx = current()
  if (!ctx) throw new Error('delegate requires a Caracal context bound on this path')
  if (!ctx.agentSessionId) {
    throw new Error('delegate requires an active agent session in context')
  }
  return createDelegation(
    input.coordinator,
    ctx.subjectToken,
    {
      zoneId: ctx.zoneId,
      issuerApplicationId: ctx.applicationId,
      sourceSessionId: ctx.agentSessionId,
      targetSessionId: input.toAgentSessionId,
      receiverApplicationId: input.toApplicationId,
      parentEdgeId: ctx.delegationEdgeId,
      resourceId: input.resourceId,
      scopes: input.scopes,
      constraints: input.constraints,
      ttlSeconds: input.ttlSeconds,
    },
    input.signal,
  )
}

/**
 * Adopt a delegation edge received from a peer: derive a context whose token
 * exchanges present the edge. Call this in the receiving agent, with the
 * receiver's own context, after the edge id arrives over whatever channel the
 * two agents share.
 */
export function adoptDelegation(ctx: CaracalContext, delegationEdgeId: string): CaracalContext {
  return {
    ...ctx,
    parentEdgeId: ctx.delegationEdgeId,
    delegationEdgeId,
    baggage: cloneBaggage(ctx.baggage),
    hop: ctx.hop + 1,
  }
}

export interface SpawnServiceInput {
  coordinator: CoordinatorClient
  zoneId: string
  applicationId: string
  subjectToken: string
  tokenSource?: () => string | Promise<string>
  invalidate?: () => void
  subjectSessionId?: string
  parentId?: string
  grant?: Grant
  ttlSeconds?: number
  metadata?: JsonObject
  labels?: string[]
  traceId?: string
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
  signal?: AbortSignal
  onAgentStart?: (ctx: CaracalContext) => void | Promise<void>
  /** Called by close before the session terminates, mirroring spawn's end hook. */
  onAgentEnd?: (ctx: CaracalContext) => void | Promise<void>
}

/**
 * Handle for a long-lived service agent session. Unlike spawn, a service
 * session is not terminated automatically: a background timer renews the lease
 * by default (see SpawnServiceInput.heartbeatIntervalMs) and the holder retires
 * the session with close.
 */
export interface ServiceAgent {
  context: CaracalContext
  agentSessionId: string
  heartbeat: (status?: AgentStatus) => Promise<void>
  close: () => Promise<void>
}

export async function spawnService(input: SpawnServiceInput): Promise<ServiceAgent> {
  const session = await establishSession(input, Lifecycle.Service)
  const { ctx, agentSessionId, bearer } = session
  if (input.onAgentStart) {
    try {
      await input.onAgentStart(ctx)
    } catch (e) {
      await retire(input.coordinator, bearer, input.zoneId, agentSessionId)
      throw e
    }
  }
  let deadlineAt = session.heartbeatDeadlineAt
  const heartbeat = async (status?: AgentStatus) => {
    let res
    try {
      res = await heartbeatAgent(input.coordinator, await bearer(), input.zoneId, agentSessionId, status)
    } catch (e) {
      // A cached token can be rejected before its exp (server-side session
      // revocation after a credential rotation); force one refresh and retry
      // so the lease survives the rotation.
      if (!(e instanceof CoordinatorError) || e.status !== 401 || !input.invalidate) throw e
      input.invalidate()
      res = await heartbeatAgent(input.coordinator, await bearer(), input.zoneId, agentSessionId, status)
    }
    deadlineAt = res.heartbeatDeadlineAt ?? deadlineAt
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
          console.warn(`caracal: lease lost for agent ${agentSessionId}; auto-heartbeat stopped`, err)
          input.onLeaseLost?.(err)
        }
        return
      }
      console.warn(`caracal: auto-heartbeat failed for agent ${agentSessionId}; retrying`, err)
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
    agentSessionId,
    heartbeat,
    close: () =>
      (closing ??= (async () => {
        stopped = true
        if (timer) clearTimeout(timer)
        try {
          if (input.onAgentEnd) await input.onAgentEnd(ctx)
        } finally {
          try {
            await terminateAgent(input.coordinator, await bearer(), input.zoneId, agentSessionId)
          } catch (e) {
            if (!isGone(e)) throw e
          }
        }
      })()),
  }
}
