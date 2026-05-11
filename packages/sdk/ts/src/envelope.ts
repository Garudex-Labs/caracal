/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Wire envelope using W3C Trace Context (traceparent) and W3C Baggage.
 *
 * Subject token rides in Authorization. Caracal-specific cross-cutting fields
 * (agent_session, delegation_edge, parent_edge, hop) ride in Baggage under the
 * caracal.* namespace. Trace identifiers ride in traceparent so any
 * OpenTelemetry-aware client/server propagates them transparently.
 */

export const HeaderAuthorization = "authorization";
export const HeaderTraceparent = "traceparent";
export const HeaderBaggage = "baggage";

export const BaggageAgentSession = "caracal.agent_session";
export const BaggageDelegationEdge = "caracal.delegation_edge";
export const BaggageParentEdge = "caracal.parent_edge";
export const BaggageHop = "caracal.hop";

export const MaxHop = 32;

export interface Envelope {
  subjectToken?: string;
  agentSessionId?: string;
  delegationEdgeId?: string;
  parentEdgeId?: string;
  traceId?: string;
  hop: number;
}

export type HeaderGetter = (name: string) => string | undefined;
export type HeaderSetter = (name: string, value: string) => void;

const TRACEPARENT_RE =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

function randomHex(byteLen: number): string {
  const bytes = new Uint8Array(byteLen);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < byteLen; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function genTraceId(): string {
  return randomHex(16);
}

function genSpanId(): string {
  return randomHex(8);
}

export function formatTraceparent(traceId: string): string {
  return `00-${traceId}-${genSpanId()}-01`;
}

export function parseTraceparent(value: string): { traceId: string } | undefined {
  const m = TRACEPARENT_RE.exec(value.trim());
  if (!m) return undefined;
  if (m[2] === "00000000000000000000000000000000") return undefined;
  return { traceId: m[2] };
}

export function encodeBaggage(entries: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(entries)) {
    if (v === undefined || v === "") continue;
    parts.push(`${k}=${encodeURIComponent(v)}`);
  }
  return parts.join(",");
}

export function parseBaggage(value: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value) return out;
  for (const piece of value.split(",")) {
    const eq = piece.indexOf("=");
    if (eq <= 0) continue;
    const k = piece.slice(0, eq).trim();
    const semi = piece.indexOf(";", eq + 1);
    const rawV = (semi === -1 ? piece.slice(eq + 1) : piece.slice(eq + 1, semi)).trim();
    try {
      out[k] = decodeURIComponent(rawV);
    } catch {
      out[k] = rawV;
    }
  }
  return out;
}

const headerKey = (h: Record<string, string | string[] | undefined>, name: string) => {
  const lower = name.toLowerCase();
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === lower) {
      const v = h[k];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
};

export function fromHeaders(headers: Record<string, string | string[] | undefined>): Envelope {
  return decodeEnvelope((n) => headerKey(headers, n));
}

export function decodeEnvelope(get: HeaderGetter): Envelope {
  const auth = get(HeaderAuthorization);
  const subjectToken =
    auth && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "").trim() : undefined;
  const tp = get(HeaderTraceparent);
  const traceId = tp ? parseTraceparent(tp)?.traceId : undefined;
  const bag = parseBaggage(get(HeaderBaggage));
  const hopRaw = bag[BaggageHop];
  const hop = hopRaw ? Math.max(0, Math.min(MaxHop, parseInt(hopRaw, 10) || 0)) : 0;
  return {
    subjectToken,
    agentSessionId: bag[BaggageAgentSession] || undefined,
    delegationEdgeId: bag[BaggageDelegationEdge] || undefined,
    parentEdgeId: bag[BaggageParentEdge] || undefined,
    traceId,
    hop,
  };
}

export function encodeEnvelope(env: Envelope, set: HeaderSetter): void {
  if (env.subjectToken) set(HeaderAuthorization, `Bearer ${env.subjectToken}`);
  const traceId = env.traceId && /^[0-9a-f]{32}$/.test(env.traceId) ? env.traceId : genTraceId();
  set(HeaderTraceparent, formatTraceparent(traceId));
  const baggage = encodeBaggage({
    [BaggageAgentSession]: env.agentSessionId,
    [BaggageDelegationEdge]: env.delegationEdgeId,
    [BaggageParentEdge]: env.parentEdgeId,
    [BaggageHop]: String(env.hop),
  });
  if (baggage) set(HeaderBaggage, baggage);
}

export function toHeaders(env: Envelope): Record<string, string> {
  const out: Record<string, string> = {};
  encodeEnvelope(env, (n, v) => {
    out[n] = v;
  });
  return out;
}

export function inject(env: Envelope, carrier: Record<string, string>): void {
  encodeEnvelope(env, (n, v) => {
    carrier[n] = v;
  });
}

export function extract(carrier: Record<string, string | string[] | undefined>): Envelope {
  return fromHeaders(carrier);
}
