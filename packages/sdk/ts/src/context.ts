/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * CaracalContext: bound identity and delegation context propagated across async boundaries.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { Envelope } from './envelope.js'

export interface CaracalContext {
  /**
   * The bearer credential this context presents: the session mandate every
   * gateway-bound call and token exchange authenticates with. Named for the
   * RFC 8693 subject_token it becomes on the wire; it is not an end-user
   * identity - see subjectAuthorityRecordId for that.
   */
  subjectToken: string
  zoneId: string
  applicationId: string
  sessionId?: string
  delegationId?: string
  parentDelegationId?: string
  subjectAuthorityRecordId?: string
  /** W3C trace id (32 lowercase hex characters) correlating this context's requests. */
  traceId?: string
  traceFlags?: string
  traceState?: string
  baggage?: Record<string, string>
  /** Delegation depth: how many delegation hand-offs precede this context; 0 at the root. */
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
  subjectAuthorityRecordId?: string
  sessionId?: string
  delegationId?: string
  parentDelegationId?: string
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
  sessionId?: string
  delegationId?: string
  parentDelegationId?: string
  subjectAuthorityRecordId?: string
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
    sessionId: ctx.sessionId,
    delegationId: ctx.delegationId,
    parentDelegationId: ctx.parentDelegationId,
    subjectAuthorityRecordId: ctx.subjectAuthorityRecordId,
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
    sessionId: env.sessionId,
    delegationId: env.delegationId,
    parentDelegationId: env.parentDelegationId,
    subjectAuthorityRecordId: env.subjectAuthorityRecordId,
    traceId: env.traceId,
    traceFlags: env.traceFlags,
    traceState: env.traceState,
    baggage: cloneBaggage(env.baggage),
    hop: env.hop,
  }
}

export function fromVerifiedEnvelope(env: Envelope, claims: VerifiedClaims): CaracalContext {
  if (!env.subjectToken) throw new Error('envelope missing subject token')
  if (!claims.zoneId || !claims.applicationId || claims.hop === undefined) {
    throw new Error('verified claims require zoneId, applicationId, and hop')
  }
  return {
    subjectToken: env.subjectToken,
    zoneId: claims.zoneId,
    applicationId: claims.applicationId,
    sessionId: claims.sessionId,
    delegationId: claims.delegationId,
    parentDelegationId: claims.parentDelegationId,
    subjectAuthorityRecordId: claims.subjectAuthorityRecordId,
    traceId: env.traceId,
    traceFlags: env.traceFlags,
    traceState: env.traceState,
    baggage: cloneBaggage(env.baggage),
    hop: claims.hop,
  }
}

export function describeAuthority(ctx: CaracalContext | undefined = current()): AuthoritySummary | undefined {
  if (!ctx) return undefined
  const chain: string[] = []
  if (ctx.subjectAuthorityRecordId) chain.push(`subject:${ctx.subjectAuthorityRecordId}`)
  if (ctx.sessionId) chain.push(`session:${ctx.sessionId}`)
  if (ctx.parentDelegationId) chain.push(`parent-delegation:${ctx.parentDelegationId}`)
  if (ctx.delegationId) chain.push(`delegation:${ctx.delegationId}`)
  return {
    zoneId: ctx.zoneId,
    applicationId: ctx.applicationId,
    subjectAuthorityRecordId: ctx.subjectAuthorityRecordId,
    sessionId: ctx.sessionId,
    delegationId: ctx.delegationId,
    parentDelegationId: ctx.parentDelegationId,
    traceId: ctx.traceId,
    hop: ctx.hop,
    chain,
  }
}
