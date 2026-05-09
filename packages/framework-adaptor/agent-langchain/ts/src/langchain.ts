// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// LangChain adapter: thin Layer 3 shim over the Caracal SDK.

import { current, withAgent, withDelegation, toHeaders, type CaracalContext, type CoordinatorClient } from '@caracalai/sdk/advanced'

export interface LangChainRunnable {
  invoke: (input: unknown) => Promise<unknown> | unknown
}

export interface LangChainTool {
  call: (input: unknown, ctx: { headers: Record<string, string> }) => Promise<unknown> | unknown
}

export interface CaracalCallbackOptions {
  coordinator: CoordinatorClient
  applicationId: string
  zoneId: string
  subjectToken: string
  ttlSeconds?: number
}

/**
 * CaracalCallbackHandler is the entry-point shim for LangChain/LangGraph.
 *
 * Usage:
 *   const handler = new CaracalCallbackHandler(opts)
 *   await handler.run(async () => {
 *     await myChain.invoke(input)
 *   })
 *
 * Every `tool()` call inside the fn reads the ambient CaracalContext and
 * injects envelope headers — no per-call opts required.
 */
export class CaracalCallbackHandler {
  constructor(private readonly opts: CaracalCallbackOptions) {}

  /** Wrap a LangChain chain/graph execution with an agent session. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    return withAgent(
      {
        coordinator: this.opts.coordinator,
        zoneId: this.opts.zoneId,
        applicationId: this.opts.applicationId,
        subjectToken: this.opts.subjectToken,
        kind: 'instance',
        ttlSeconds: this.opts.ttlSeconds,
      },
      fn,
    ) as Promise<T>
  }

  /** Wrap a sub-agent node with its own agent session (e.g. a LangGraph node). */
  async node<T>(fn: () => Promise<T>): Promise<T> {
    return withAgent(
      {
        coordinator: this.opts.coordinator,
        zoneId: this.opts.zoneId,
        applicationId: this.opts.applicationId,
        subjectToken: this.opts.subjectToken,
        kind: 'ephemeral',
        ttlSeconds: this.opts.ttlSeconds,
      },
      fn,
    ) as Promise<T>
  }

  /** Wrap a tool call: injects the current context as outbound headers. */
  tool(resource: string, toolFn: LangChainTool): (input: unknown) => Promise<unknown> {
    return async (input: unknown): Promise<unknown> => {
      const ctx: CaracalContext = current()
      const headers = toHeaders({
        subjectToken: ctx.subjectToken,
        agentSessionId: ctx.agentSessionId,
        delegationEdgeId: ctx.delegationEdgeId,
        parentEdgeId: ctx.parentEdgeId,
        traceId: ctx.traceId,
        hop: ctx.hop,
      })
      return toolFn.call(input, { headers })
    }
  }

  /** Delegate authority to another agent before calling it. */
  async delegate<T>(
    toAgentSessionId: string,
    toApplicationId: string,
    scopes: string[],
    fn: () => Promise<T>,
  ): Promise<T> {
    return withDelegation(
      { coordinator: this.opts.coordinator, toAgentSessionId, toApplicationId, scopes },
      fn,
    ) as Promise<T>
  }
}
