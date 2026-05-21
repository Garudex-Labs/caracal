/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * CaracalContext: ambient identity and delegation context propagated across async boundaries.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { Envelope } from "./envelope.js";

export interface CaracalContext {
  subjectToken: string;
  zoneId: string;
  clientId: string;
  agentSessionId?: string;
  delegationEdgeId?: string;
  parentEdgeId?: string;
  sessionId?: string;
  traceId?: string;
  hop: number;
}

export interface AuthoritySummary {
  zoneId: string;
  applicationId: string;
  authoritySessionId?: string;
  agentRunId?: string;
  delegatedPermissionId?: string;
  parentDelegatedPermissionId?: string;
  traceId?: string;
  hop: number;
  chain: string[];
}

const storage = new AsyncLocalStorage<CaracalContext>();

export function current(): CaracalContext | undefined {
  return storage.getStore();
}

export function captureContext(): CaracalContext | undefined {
  const ctx = current();
  return ctx ? { ...ctx } : undefined;
}

export function bind<T>(ctx: CaracalContext, fn: () => T | Promise<T>): T | Promise<T> {
  return storage.run(ctx, fn);
}

export function withOverrides<T>(
  patch: Partial<CaracalContext>,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const base = current();
  if (!base) throw new Error("withOverrides requires an existing Caracal context");
  return storage.run({ ...base, ...patch }, fn);
}

export function toEnvelope(ctx: CaracalContext): Envelope {
  return {
    subjectToken: ctx.subjectToken,
    agentSessionId: ctx.agentSessionId,
    delegationEdgeId: ctx.delegationEdgeId,
    parentEdgeId: ctx.parentEdgeId,
    sessionId: ctx.sessionId,
    traceId: ctx.traceId,
    hop: ctx.hop,
  };
}

export function fromEnvelope(env: Envelope, base: { zoneId: string; clientId: string }): CaracalContext {
  if (!env.subjectToken) throw new Error("envelope missing subject token");
  return {
    subjectToken: env.subjectToken,
    zoneId: base.zoneId,
    clientId: base.clientId,
    agentSessionId: env.agentSessionId,
    delegationEdgeId: env.delegationEdgeId,
    parentEdgeId: env.parentEdgeId,
    sessionId: env.sessionId,
    traceId: env.traceId,
    hop: env.hop,
  };
}

export function describeAuthority(ctx: CaracalContext | undefined = current()): AuthoritySummary | undefined {
  if (!ctx) return undefined;
  const chain: string[] = [];
  if (ctx.sessionId) chain.push(`authority:${ctx.sessionId}`);
  if (ctx.agentSessionId) chain.push(`agent-run:${ctx.agentSessionId}`);
  if (ctx.parentEdgeId) chain.push(`parent-delegated-permission:${ctx.parentEdgeId}`);
  if (ctx.delegationEdgeId) chain.push(`delegated-permission:${ctx.delegationEdgeId}`);
  return {
    zoneId: ctx.zoneId,
    applicationId: ctx.clientId,
    authoritySessionId: ctx.sessionId,
    agentRunId: ctx.agentSessionId,
    delegatedPermissionId: ctx.delegationEdgeId,
    parentDelegatedPermissionId: ctx.parentEdgeId,
    traceId: ctx.traceId,
    hop: ctx.hop,
    chain,
  };
}
