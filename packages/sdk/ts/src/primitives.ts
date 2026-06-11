/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * SDK primitives: spawn an agent session and delegate authority.
 */

import { bind, current, CaracalContext } from './context.js'
import {
  CoordinatorClient,
  spawnAgent,
  terminateAgent,
  heartbeatAgent,
  createDelegation,
  Lifecycle,
  DelegationConstraints,
} from './coordinator.js'
import type { JsonObject } from './json.js'

export type GrantMode = 'inherit' | 'narrow' | 'none'

/**
 * Authority handed to a spawned child. `inherit` (the default) runs the child
 * under its parent's effective session: a child of a narrowed parent inherits
 * that same narrowing (the server mirrors the parent's edge onto the child), so
 * least-privilege is transitive by default; a child of a root parent runs under
 * full application authority. `narrow` issues a bounded delegation edge so the
 * child holds only the listed scopes; the server re-validates the subset, so a
 * narrow can never broaden. `none` spawns without issuing any edge.
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
  narrow(scopes: string[], opts?: { resourceId?: string; constraints?: DelegationConstraints; ttlSeconds?: number }): Grant {
    return { mode: 'narrow', scopes, ...opts }
  },
}

export interface SpawnInput {
  coordinator: CoordinatorClient
  zoneId: string
  applicationId: string
  subjectToken: string
  subjectSessionId?: string
  parentId?: string
  grant?: Grant
  ttlSeconds?: number
  metadata?: JsonObject
  labels?: string[]
  traceId?: string
  onAgentStart?: (ctx: CaracalContext) => void | Promise<void>
  onAgentEnd?: (ctx: CaracalContext) => void | Promise<void>
}

/**
 * Spawn a child agent session and bind it to fn. The child inherits its
 * application's authority by default; pass `grant: Grant.narrow([...])` to issue
 * a bounded delegation edge so the child holds only a subset of scopes.
 */
export async function spawn<T>(input: SpawnInput, fn: () => Promise<T>): Promise<T> {
  const grant = input.grant ?? Grant.inherit()
  const parent = current()
  const parentId = input.parentId ?? parent?.agentSessionId
  const bearer = input.subjectToken
  const inheritParentEdgeId =
    grant.mode === 'inherit' && parent?.agentSessionId && parent.delegationEdgeId && input.applicationId === parent.applicationId
      ? parent.delegationEdgeId
      : undefined
  const res = await spawnAgent(input.coordinator, bearer, {
    zoneId: input.zoneId,
    applicationId: input.applicationId,
    subjectSessionId: input.subjectSessionId,
    parentId,
    ttlSeconds: input.ttlSeconds,
    metadata: input.metadata,
    labels: input.labels,
    inheritParentEdgeId,
  })

  let delegationEdgeId: string | undefined = res.delegation_edge_id ?? undefined
  let hop = delegationEdgeId && parent ? parent.hop + 1 : (parent?.hop ?? 0)
  try {
    if (grant.mode === 'narrow') {
      if (!parent || !parent.agentSessionId) {
        throw new Error('grant narrow requires an active parent agent session')
      }
      const delRes = await createDelegation(input.coordinator, parent.subjectToken, {
        zoneId: input.zoneId,
        issuerApplicationId: parent.applicationId,
        sourceSessionId: parent.agentSessionId,
        targetSessionId: res.agent_session_id,
        receiverApplicationId: input.applicationId,
        parentEdgeId: parent.delegationEdgeId,
        resourceId: grant.resourceId,
        scopes: grant.scopes ?? [],
        constraints: grant.constraints,
        ttlSeconds: grant.ttlSeconds,
      })
      delegationEdgeId = delRes.delegation_edge_id
      hop = parent.hop + 1
    }
  } catch (e) {
    await terminateAgent(input.coordinator, bearer, input.zoneId, res.agent_session_id)
    throw e
  }

  const ctx: CaracalContext = {
    subjectToken: bearer,
    zoneId: input.zoneId,
    applicationId: input.applicationId,
    agentSessionId: res.agent_session_id,
    delegationEdgeId,
    parentEdgeId: parent?.delegationEdgeId,
    sessionId: input.subjectSessionId ?? parent?.sessionId,
    traceId: input.traceId ?? parent?.traceId,
    hop,
  }
  let started = false
  try {
    if (input.onAgentStart) await input.onAgentStart(ctx)
    started = true
    return await (bind(ctx, fn) as Promise<T>)
  } finally {
    if (started && input.onAgentEnd) await input.onAgentEnd(ctx)
    await terminateAgent(input.coordinator, bearer, input.zoneId, res.agent_session_id)
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
}

export async function delegate<T>(input: DelegateInput, fn: () => Promise<T>): Promise<T> {
  const ctx = current()
  if (!ctx) throw new Error('delegate requires a Caracal context bound on this path')
  if (!ctx.agentSessionId) {
    throw new Error('delegate requires an active agent session in context')
  }
  const res = await createDelegation(input.coordinator, ctx.subjectToken, {
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
  })
  const child: CaracalContext = {
    ...ctx,
    parentEdgeId: ctx.delegationEdgeId,
    delegationEdgeId: res.delegation_edge_id,
    hop: ctx.hop + 1,
  }
  return bind(child, fn) as Promise<T>
}

export interface SpawnServiceInput {
  coordinator: CoordinatorClient
  zoneId: string
  applicationId: string
  subjectToken: string
  subjectSessionId?: string
  parentId?: string
  ttlSeconds?: number
  metadata?: JsonObject
  labels?: string[]
  traceId?: string
  heartbeatIntervalMs?: number
  onAgentStart?: (ctx: CaracalContext) => void | Promise<void>
}

/**
 * Handle for a long-lived service agent session. Unlike spawn, a service
 * session is not terminated automatically: the holder must heartbeat to keep
 * its lease and close to retire it. Pass heartbeatIntervalMs to spawnService to
 * renew the lease from a background timer so it survives long provider streams.
 */
export interface ServiceAgent {
  context: CaracalContext
  agentSessionId: string
  heartbeat: () => Promise<void>
  close: () => Promise<void>
}

export async function spawnService(input: SpawnServiceInput): Promise<ServiceAgent> {
  const parent = current()
  const parentId = input.parentId ?? parent?.agentSessionId
  const bearer = input.subjectToken
  const res = await spawnAgent(input.coordinator, bearer, {
    zoneId: input.zoneId,
    applicationId: input.applicationId,
    subjectSessionId: input.subjectSessionId,
    parentId,
    lifecycle: Lifecycle.Service,
    ttlSeconds: input.ttlSeconds,
    metadata: input.metadata,
    labels: input.labels,
  })
  const ctx: CaracalContext = {
    subjectToken: bearer,
    zoneId: input.zoneId,
    applicationId: input.applicationId,
    agentSessionId: res.agent_session_id,
    parentEdgeId: parent?.delegationEdgeId,
    sessionId: input.subjectSessionId ?? parent?.sessionId,
    traceId: input.traceId ?? parent?.traceId,
    hop: parent?.hop ?? 0,
  }
  if (input.onAgentStart) await input.onAgentStart(ctx)
  const heartbeat = () => heartbeatAgent(input.coordinator, bearer, input.zoneId, res.agent_session_id)
  let timer: ReturnType<typeof setInterval> | undefined
  if (input.heartbeatIntervalMs && input.heartbeatIntervalMs > 0) {
    timer = setInterval(() => {
      heartbeat().catch((err) => {
        console.warn(`caracal: auto-heartbeat failed for agent ${res.agent_session_id}; retrying next tick`, err)
      })
    }, input.heartbeatIntervalMs)
    timer.unref?.()
  }
  return {
    context: ctx,
    agentSessionId: res.agent_session_id,
    heartbeat,
    close: () => {
      if (timer) clearInterval(timer)
      return terminateAgent(input.coordinator, bearer, input.zoneId, res.agent_session_id)
    },
  }
}
