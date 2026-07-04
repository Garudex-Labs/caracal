/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Wire envelope using W3C Trace Context (traceparent/tracestate) and W3C Baggage.
 *
 * Caracal correlation fields (session, agent_session, delegation_edge,
 * parent_edge, hop) ride in Baggage under the caracal.* namespace alongside
 * pass-through third-party entries; trace identity rides in traceparent and
 * tracestate. Decoding reads the subject token from Authorization, but
 * encoding never writes it: credential emission is an explicit client-layer
 * decision. Baggage is unsigned routing metadata; verifiers must treat signed
 * token claims as the only authoritative source of delegation state.
 */

export const HeaderAuthorization = 'authorization'
export const HeaderTraceparent = 'traceparent'
export const HeaderTracestate = 'tracestate'
export const HeaderBaggage = 'baggage'

export const BaggageAgentSession = 'caracal.agent_session'
export const BaggageDelegationEdge = 'caracal.delegation_edge'
export const BaggageParentEdge = 'caracal.parent_edge'
export const BaggageSession = 'caracal.session'
export const BaggageHop = 'caracal.hop'

export const MaxHop = 10

const MaxBaggageBytes = 8192
const MaxBaggageMembers = 64

const caracalBaggageKeys = [BaggageAgentSession, BaggageDelegationEdge, BaggageParentEdge, BaggageSession, BaggageHop]

export interface Envelope {
  subjectToken?: string
  agentSessionId?: string
  delegationEdgeId?: string
  parentEdgeId?: string
  sessionId?: string
  traceId?: string
  traceFlags?: string
  traceState?: string
  baggage?: Record<string, string>
  hop: number
}

export type HeaderGetter = (name: string) => string | undefined
export type HeaderSetter = (name: string, value: string) => void

const BEARER_RE = /^bearer +(.+)$/i
const HEX2_RE = /^[0-9a-f]{2}$/
const HEX16_RE = /^[0-9a-f]{16}$/
const HEX32_RE = /^[0-9a-f]{32}$/
const HOP_RE = /^[0-9]+$/

function randomHex(byteLen: number): string {
  const bytes = new Uint8Array(byteLen)
  crypto.getRandomValues(bytes)
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

function genTraceId(): string {
  return randomHex(16)
}

function genSpanId(): string {
  return randomHex(8)
}

export function formatTraceparent(traceId: string, flags?: string): string {
  const f = flags && HEX2_RE.test(flags) ? flags : '01'
  return `00-${traceId}-${genSpanId()}-${f}`
}

export function parseTraceparent(value: string): { traceId: string; flags: string } | undefined {
  const parts = value.trim().split('-')
  if (parts.length < 4) return undefined
  const [version, traceId, spanId, flags] = parts
  if (!HEX2_RE.test(version) || version === 'ff') return undefined
  if (version === '00' && parts.length !== 4) return undefined
  if (!HEX32_RE.test(traceId) || traceId === '00000000000000000000000000000000') return undefined
  if (!HEX16_RE.test(spanId) || spanId === '0000000000000000') return undefined
  if (!HEX2_RE.test(flags)) return undefined
  return { traceId, flags }
}

export function encodeBaggage(entries: Record<string, string | undefined>): string {
  const parts: string[] = []
  for (const k of Object.keys(entries).sort()) {
    const v = entries[k]
    if (v === undefined || v === '') continue
    parts.push(`${k}=${encodeURIComponent(v)}`)
  }
  return parts.join(',')
}

export function parseBaggage(value: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!value || value.length > MaxBaggageBytes) return out
  const pieces = value.split(',')
  if (pieces.length > MaxBaggageMembers) return out
  for (const piece of pieces) {
    const eq = piece.indexOf('=')
    if (eq <= 0) continue
    const k = piece.slice(0, eq).trim()
    if (!k) continue
    const semi = piece.indexOf(';', eq + 1)
    const rawV = (semi === -1 ? piece.slice(eq + 1) : piece.slice(eq + 1, semi)).trim()
    try {
      out[k] = decodeURIComponent(rawV)
    } catch {
      out[k] = rawV
    }
  }
  return out
}

const headerKey = (h: Record<string, string | string[] | undefined>, name: string) => {
  const lower = name.toLowerCase()
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === lower) {
      const v = h[k]
      if (Array.isArray(v)) return lower === HeaderBaggage ? v.join(',') : v[0]
      return v
    }
  }
  return undefined
}

export function fromHeaders(headers: Record<string, string | string[] | undefined>): Envelope {
  return decodeEnvelope((n) => headerKey(headers, n))
}

export function decodeEnvelope(get: HeaderGetter): Envelope {
  const auth = get(HeaderAuthorization)
  const bearer = auth ? BEARER_RE.exec(auth.trim()) : null
  const tp = get(HeaderTraceparent)
  const trace = tp ? parseTraceparent(tp) : undefined
  const traceState = get(HeaderTracestate)?.trim()
  const bag = parseBaggage(get(HeaderBaggage))
  const extras: Record<string, string> = {}
  for (const [k, v] of Object.entries(bag)) {
    if (!caracalBaggageKeys.includes(k)) extras[k] = v
  }
  const hopRaw = bag[BaggageHop]
  const hop = hopRaw && HOP_RE.test(hopRaw) ? Math.min(MaxHop, parseInt(hopRaw, 10)) : 0
  return {
    subjectToken: bearer?.[1],
    agentSessionId: bag[BaggageAgentSession] || undefined,
    delegationEdgeId: bag[BaggageDelegationEdge] || undefined,
    parentEdgeId: bag[BaggageParentEdge] || undefined,
    sessionId: bag[BaggageSession] || undefined,
    traceId: trace?.traceId,
    traceFlags: trace?.flags,
    traceState: traceState || undefined,
    baggage: Object.keys(extras).length > 0 ? extras : undefined,
    hop,
  }
}

export function encodeEnvelope(env: Envelope, set: HeaderSetter, get?: HeaderGetter): void {
  const existingTp = get?.(HeaderTraceparent)
  if (!existingTp || !parseTraceparent(existingTp)) {
    const traceId = env.traceId && HEX32_RE.test(env.traceId) ? env.traceId : genTraceId()
    set(HeaderTraceparent, formatTraceparent(traceId, env.traceFlags))
  }
  if (env.traceState && !get?.(HeaderTracestate)) {
    set(HeaderTracestate, env.traceState)
  }
  const merged: Record<string, string> = { ...env.baggage }
  if (get) {
    for (const [k, v] of Object.entries(parseBaggage(get(HeaderBaggage)))) merged[k] = v
  }
  for (const key of caracalBaggageKeys) delete merged[key]
  if (env.agentSessionId) merged[BaggageAgentSession] = env.agentSessionId
  if (env.delegationEdgeId) merged[BaggageDelegationEdge] = env.delegationEdgeId
  if (env.parentEdgeId) merged[BaggageParentEdge] = env.parentEdgeId
  if (env.sessionId) merged[BaggageSession] = env.sessionId
  if (env.hop > 0 || env.agentSessionId || env.delegationEdgeId || env.parentEdgeId || env.sessionId) {
    merged[BaggageHop] = String(env.hop)
  }
  const baggage = encodeBaggage(merged)
  if (baggage) set(HeaderBaggage, baggage)
}

export function toHeaders(env: Envelope): Record<string, string> {
  const out: Record<string, string> = {}
  encodeEnvelope(env, (n, v) => {
    out[n] = v
  })
  return out
}
