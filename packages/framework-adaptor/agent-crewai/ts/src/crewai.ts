// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// CrewAI adapter: thin Layer 3 shim that binds Caracal identity to each task execution.

import { withAgent, withDelegation, current, toHeaders, type CoordinatorClient } from '@caracalai/sdk/advanced'

export interface CrewAITask {
  execute: (input: unknown) => Promise<unknown> | unknown
}

export interface CrewAIAgentLike {
  execute: (task: CrewAITask, input: unknown) => Promise<unknown>
}

export interface CaracalCrewOptions {
  coordinator: CoordinatorClient
  zoneId: string
  applicationId: string
  subjectToken: string
  ttlSeconds?: number
}

/**
 * runWithAgent wraps a CrewAI task execution with a Caracal ephemeral agent session.
 * Call this instead of task.execute() anywhere you need traceable identity.
 */
export async function runWithAgent(
  opts: CaracalCrewOptions,
  task: CrewAITask,
  input: unknown,
): Promise<unknown> {
  return withAgent(
    {
      coordinator: opts.coordinator,
      zoneId: opts.zoneId,
      applicationId: opts.applicationId,
      subjectToken: opts.subjectToken,
      kind: 'ephemeral',
      ttlSeconds: opts.ttlSeconds,
    },
    () => Promise.resolve(task.execute(input)),
  )
}

/**
 * runCrewWithAgent wraps a full Crew (multi-agent) execution with a parent agent session.
 * Sub-tasks should use runWithAgent() inside the fn to get per-task ephemeral sessions.
 */
export async function runCrewWithAgent<T>(
  opts: CaracalCrewOptions,
  fn: () => Promise<T>,
): Promise<T> {
  return withAgent(
    {
      coordinator: opts.coordinator,
      zoneId: opts.zoneId,
      applicationId: opts.applicationId,
      subjectToken: opts.subjectToken,
      kind: 'instance',
      ttlSeconds: opts.ttlSeconds,
    },
    fn,
  ) as Promise<T>
}

/**
 * delegateAndRun creates a delegation edge to another agent and runs fn inside that scope.
 */
export async function delegateAndRun<T>(
  coordinator: CoordinatorClient,
  toAgentSessionId: string,
  toApplicationId: string,
  scopes: string[],
  fn: () => Promise<T>,
): Promise<T> {
  return withDelegation({ coordinator, toAgentSessionId, toApplicationId, scopes }, fn) as Promise<T>
}

/**
 * outboundHeaders returns the Caracal envelope headers to inject into any outbound HTTP call.
 * Call inside a withAgent / runWithAgent scope.
 */
export function outboundHeaders(): Record<string, string> {
  const ctx = current()
  return toHeaders({
    subjectToken: ctx.subjectToken,
    agentSessionId: ctx.agentSessionId,
    delegationEdgeId: ctx.delegationEdgeId,
    parentEdgeId: ctx.parentEdgeId,
    traceId: ctx.traceId,
    hop: ctx.hop,
  })
}
