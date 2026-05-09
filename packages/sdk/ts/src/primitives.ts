/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * SDK primitives: withAgent and withDelegation.
 */

import { bind, current, tryCurrent, CaracalContext } from "./context.js";
import {
  CoordinatorClient,
  spawnAgent,
  terminateAgent,
  createDelegation,
  AgentKind,
} from "./coordinator.js";

export interface WithAgentOptions {
  coordinator: CoordinatorClient;
  zoneId: string;
  applicationId: string;
  subjectToken: string;
  sessionSid?: string;
  parentId?: string;
  kind?: AgentKind;
  ttlSeconds?: number;
  metadata?: Record<string, unknown>;
  traceId?: string;
}

export async function withAgent<T>(opts: WithAgentOptions, fn: () => Promise<T>): Promise<T> {
  const parent = tryCurrent();
  const parentId = opts.parentId ?? parent?.agentSessionId;
  const bearer = opts.subjectToken;
  const res = await spawnAgent(opts.coordinator, bearer, {
    zoneId: opts.zoneId,
    applicationId: opts.applicationId,
    sessionSid: opts.sessionSid,
    parentId,
    kind: opts.kind ?? "instance",
    ttlSeconds: opts.ttlSeconds,
    metadata: opts.metadata,
  });
  const ctx: CaracalContext = {
    subjectToken: bearer,
    zoneId: opts.zoneId,
    clientId: opts.applicationId,
    agentSessionId: res.agent_session_id,
    parentEdgeId: parent?.delegationEdgeId,
    sessionId: opts.sessionSid ?? parent?.sessionId,
    traceId: opts.traceId ?? parent?.traceId,
    hop: (parent?.hop ?? 0),
  };
  try {
    return await (bind(ctx, fn) as Promise<T>);
  } finally {
    if (opts.kind !== "service") {
      await terminateAgent(opts.coordinator, bearer, opts.zoneId, res.agent_session_id);
    }
  }
}

export interface WithDelegationOptions {
  coordinator: CoordinatorClient;
  toAgentSessionId: string;
  toApplicationId: string;
  scopes: string[];
  constraints?: Record<string, unknown>;
  ttlSeconds?: number;
}

export async function withDelegation<T>(
  opts: WithDelegationOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx = current();
  if (!ctx.agentSessionId) {
    throw new Error("withDelegation requires an active agent session in context");
  }
  const res = await createDelegation(opts.coordinator, ctx.subjectToken, {
    zoneId: ctx.zoneId,
    issuerApplicationId: ctx.clientId,
    sourceSessionId: ctx.agentSessionId,
    targetSessionId: opts.toAgentSessionId,
    receiverApplicationId: opts.toApplicationId,
    scopes: opts.scopes,
    constraints: opts.constraints,
    ttlSeconds: opts.ttlSeconds,
  });
  const child: CaracalContext = {
    ...ctx,
    parentEdgeId: ctx.delegationEdgeId,
    delegationEdgeId: res.delegation_edge_id,
    hop: ctx.hop + 1,
  };
  return (bind(child, fn) as Promise<T>);
}
