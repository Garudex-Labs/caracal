/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * CaracalContext: bound identity and delegation context propagated across async boundaries.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { Envelope } from './envelope.js'

export interface CaracalContext {
  subjectToken: string
  zoneId: string
  applicationId: string
  agentSessionId?: string
  delegationEdgeId?: string
  parentEdgeId?: string
  sessionId?: string
  traceId?: string
  traceFlags?: string
  traceState?: string
  baggage?: Record<string, string>
  hop: number
  /**
   * Marks a context whose subject token came from this process's own
   * credential configuration, so the client may refresh it through its token
   * source. Inbound contexts carry a caller's token and stay pinned.
   * Process-local; never serialized to the envelope.
   */
  ownToken?: boolean
}

export interface AuthoritySummary {
  zoneId: string
  applicationId: string
  sessionId?: string
  agentSessionId?: string
  delegationEdgeId?: string
  parentEdgeId?: string
  traceId?: string
  hop: number
  chain: string[]
}

/**
 * Attribution a verify hook proved from the token itself. Fields returned here
 * override the caller-supplied envelope when binding inbound context, so
 * attribution comes from verified claims rather than forgeable headers.
 */
export interface VerifiedClaims {
  zoneId?: string
  applicationId?: string
  agentSessionId?: string
  delegationEdgeId?: string
  parentEdgeId?: string
  sessionId?: string
  hop?: number
}

export function cloneBaggage(baggage: Record<string, string> | undefined): Record<string, string> | undefined {
  return baggage ? { ...baggage } : undefined
}

const storage = new AsyncLocalStorage<CaracalContext>()

export function current(): CaracalContext | undefined {
  return storage.getStore()
}

export function captureContext(): CaracalContext | undefined {
  const ctx = current()
  return ctx ? { ...ctx, baggage: cloneBaggage(ctx.baggage) } : undefined
}

export function bind<T>(ctx: CaracalContext, fn: () => T): T {
  return storage.run(ctx, fn)
}

export function withOverrides(patch: Partial<CaracalContext>): CaracalContext {
  const base = current()
  if (!base) throw new Error('withOverrides requires an existing Caracal context')
  const merged = { ...base, ...patch }
  if (!('baggage' in patch)) merged.baggage = cloneBaggage(base.baggage)
  return merged
}

export function toEnvelope(ctx: CaracalContext): Envelope {
  return {
    subjectToken: ctx.subjectToken,
    agentSessionId: ctx.agentSessionId,
    delegationEdgeId: ctx.delegationEdgeId,
    parentEdgeId: ctx.parentEdgeId,
    sessionId: ctx.sessionId,
    traceId: ctx.traceId,
    traceFlags: ctx.traceFlags,
    traceState: ctx.traceState,
    baggage: ctx.baggage,
    hop: ctx.hop,
  }
}

export function fromEnvelope(env: Envelope, base: { zoneId: string; applicationId: string }): CaracalContext {
  if (!env.subjectToken) throw new Error('envelope missing subject token')
  return {
    subjectToken: env.subjectToken,
    zoneId: base.zoneId,
    applicationId: base.applicationId,
    agentSessionId: env.agentSessionId,
    delegationEdgeId: env.delegationEdgeId,
    parentEdgeId: env.parentEdgeId,
    sessionId: env.sessionId,
    traceId: env.traceId,
    traceFlags: env.traceFlags,
    traceState: env.traceState,
    baggage: cloneBaggage(env.baggage),
    hop: env.hop,
  }
}

export function describeAuthority(ctx: CaracalContext | undefined = current()): AuthoritySummary | undefined {
  if (!ctx) return undefined
  const chain: string[] = []
  if (ctx.sessionId) chain.push(`session:${ctx.sessionId}`)
  if (ctx.agentSessionId) chain.push(`agent-session:${ctx.agentSessionId}`)
  if (ctx.parentEdgeId) chain.push(`parent-edge:${ctx.parentEdgeId}`)
  if (ctx.delegationEdgeId) chain.push(`delegation-edge:${ctx.delegationEdgeId}`)
  return {
    zoneId: ctx.zoneId,
    applicationId: ctx.applicationId,
    sessionId: ctx.sessionId,
    agentSessionId: ctx.agentSessionId,
    delegationEdgeId: ctx.delegationEdgeId,
    parentEdgeId: ctx.parentEdgeId,
    traceId: ctx.traceId,
    hop: ctx.hop,
    chain,
  }
}
