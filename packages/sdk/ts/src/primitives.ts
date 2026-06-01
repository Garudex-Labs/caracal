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
import type { JsonObject } from "./json.js";

export interface SpawnInput {
  coordinator: CoordinatorClient;
  zoneId: string;
  applicationId: string;
  subjectToken: string;
  subjectSessionId?: string;
  parentId?: string;
  kind?: AgentKind;
  ttlSeconds?: number;
  metadata?: JsonObject;
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
    subjectSessionId: input.subjectSessionId,
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
    sessionId: input.subjectSessionId ?? parent?.sessionId,
    traceId: input.traceId ?? parent?.traceId,
    hop: parent?.hop ?? 0,
  };
  let started = false;
  try {
    if (input.onAgentStart) await input.onAgentStart(ctx);
    started = true;
    return await (bind(ctx, fn) as Promise<T>);
  } finally {
    if (started && input.onAgentEnd) await input.onAgentEnd(ctx);
    if (kind !== AgentKind.Service) {
      await terminateAgent(input.coordinator, bearer, input.zoneId, res.agent_session_id);
    }
  }
}

export interface DelegateInput {
  coordinator: CoordinatorClient;
  toAgentSessionId: string;
  toApplicationId: string;
  resourceId?: string;
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
    parentEdgeId: ctx.delegationEdgeId,
    resourceId: input.resourceId,
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

export interface DelegateToSpawnInput {
  coordinator: CoordinatorClient;
  zoneId: string;
  applicationId: string;
  subjectToken: string;
  resourceId?: string;
  scopes: string[];
  constraints?: DelegationConstraints;
  delegationTtlSeconds?: number;
  subjectSessionId?: string;
  kind?: AgentKind;
  ttlSeconds?: number;
  metadata?: JsonObject;
  traceId?: string;
  onAgentStart?: (ctx: CaracalContext) => void | Promise<void>;
  onAgentEnd?: (ctx: CaracalContext) => void | Promise<void>;
}

/**
 * Atomically spawn a child agent session and record a parent→child delegation
 * edge before yielding the child context to fn. Use at fan-out boundaries
 * where the child runs in a detached task and the parent may stop interacting
 * before the child can issue any call.
 */
export async function delegateToSpawn<T>(
  input: DelegateToSpawnInput,
  fn: () => Promise<T>,
): Promise<T> {
  const parent = current();
  if (!parent || !parent.agentSessionId) {
    throw new Error("delegateToSpawn requires an active agent session in context");
  }
  const kind = input.kind ?? AgentKind.Instance;
  const spawnRes = await spawnAgent(input.coordinator, input.subjectToken, {
    zoneId: input.zoneId,
    applicationId: input.applicationId,
    subjectSessionId: input.subjectSessionId,
    parentId: parent.agentSessionId,
    kind,
    ttlSeconds: input.ttlSeconds,
    metadata: input.metadata,
  });
  let delRes;
  try {
    delRes = await createDelegation(input.coordinator, parent.subjectToken, {
      zoneId: parent.zoneId,
      issuerApplicationId: parent.clientId,
      sourceSessionId: parent.agentSessionId,
      targetSessionId: spawnRes.agent_session_id,
      receiverApplicationId: input.applicationId,
      parentEdgeId: parent.delegationEdgeId,
      resourceId: input.resourceId,
      scopes: input.scopes,
      constraints: input.constraints,
      ttlSeconds: input.delegationTtlSeconds,
    });
  } catch (e) {
    if (kind !== AgentKind.Service) {
      await terminateAgent(input.coordinator, input.subjectToken, input.zoneId, spawnRes.agent_session_id);
    }
    throw e;
  }
  const ctx: CaracalContext = {
    subjectToken: input.subjectToken,
    zoneId: input.zoneId,
    clientId: input.applicationId,
    agentSessionId: spawnRes.agent_session_id,
    delegationEdgeId: delRes.delegation_edge_id,
    parentEdgeId: parent.delegationEdgeId,
    sessionId: input.subjectSessionId ?? parent.sessionId,
    traceId: input.traceId ?? parent.traceId,
    hop: parent.hop + 1,
  };
  let started = false;
  try {
    if (input.onAgentStart) await input.onAgentStart(ctx);
    started = true;
    return await (bind(ctx, fn) as Promise<T>);
  } finally {
    if (started && input.onAgentEnd) await input.onAgentEnd(ctx);
    if (kind !== AgentKind.Service) {
      await terminateAgent(input.coordinator, input.subjectToken, input.zoneId, spawnRes.agent_session_id);
    }
  }
}
