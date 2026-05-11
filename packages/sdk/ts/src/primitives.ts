/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * SDK primitives: spawn an agent session and delegate authority.
 */

import { bind, current, CaracalContext } from "./context.js";
import {
  CoordinatorClient,
  spawnAgent,
  terminateAgent,
  createDelegation,
  AgentKind,
  DelegationConstraints,
} from "./coordinator.js";

export interface SpawnInput {
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
  onAgentStart?: (ctx: CaracalContext) => void | Promise<void>;
  onAgentEnd?: (ctx: CaracalContext) => void | Promise<void>;
}

export async function spawn<T>(input: SpawnInput, fn: () => Promise<T>): Promise<T> {
  const parent = current();
  const parentId = input.parentId ?? parent?.agentSessionId;
  const bearer = input.subjectToken;
  const kind = input.kind ?? AgentKind.Instance;
  const res = await spawnAgent(input.coordinator, bearer, {
    zoneId: input.zoneId,
    applicationId: input.applicationId,
    sessionSid: input.sessionSid,
    parentId,
    kind,
    ttlSeconds: input.ttlSeconds,
    metadata: input.metadata,
  });
  const ctx: CaracalContext = {
    subjectToken: bearer,
    zoneId: input.zoneId,
    clientId: input.applicationId,
    agentSessionId: res.agent_session_id,
    parentEdgeId: parent?.delegationEdgeId,
    sessionId: input.sessionSid ?? parent?.sessionId,
    traceId: input.traceId ?? parent?.traceId,
    hop: parent?.hop ?? 0,
  };
  if (input.onAgentStart) await input.onAgentStart(ctx);
  try {
    return await (bind(ctx, fn) as Promise<T>);
  } finally {
    if (input.onAgentEnd) await input.onAgentEnd(ctx);
    if (kind !== AgentKind.Service) {
      await terminateAgent(input.coordinator, bearer, input.zoneId, res.agent_session_id);
    }
  }
}

export interface DelegateInput {
  coordinator: CoordinatorClient;
  toAgentSessionId: string;
  toApplicationId: string;
  scopes: string[];
  constraints?: DelegationConstraints;
  ttlSeconds?: number;
}

export async function delegate<T>(
  input: DelegateInput,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx = current();
  if (!ctx) throw new Error("delegate requires a Caracal context bound on this path");
  if (!ctx.agentSessionId) {
    throw new Error("delegate requires an active agent session in context");
  }
  const res = await createDelegation(input.coordinator, ctx.subjectToken, {
    zoneId: ctx.zoneId,
    issuerApplicationId: ctx.clientId,
    sourceSessionId: ctx.agentSessionId,
    targetSessionId: input.toAgentSessionId,
    receiverApplicationId: input.toApplicationId,
    scopes: input.scopes,
    constraints: input.constraints,
    ttlSeconds: input.ttlSeconds,
  });
  const child: CaracalContext = {
    ...ctx,
    parentEdgeId: ctx.delegationEdgeId,
    delegationEdgeId: res.delegation_edge_id,
    hop: ctx.hop + 1,
  };
  return (bind(child, fn) as Promise<T>);
}
