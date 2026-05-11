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

const storage = new AsyncLocalStorage<CaracalContext>();

export function current(): CaracalContext | undefined {
  return storage.getStore();
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
    traceId: env.traceId,
    hop: env.hop,
  };
}
