// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Custom adapter base class; extend to implement framework-specific agent logic.

import { a2aCall } from '../a2a.js'
import { AgentRuntime } from '../runtime.js'
import type {
  A2ARequest,
  A2AResponse,
  AdapterContext,
  AgentServiceConfig,
  InvocationEnvelope,
  InvocationResult,
} from '../types.js'

export type PipelineStep = (input: unknown, ctx: AdapterContext) => Promise<unknown> | unknown

export abstract class BaseAdapter {
  protected readonly runtime: AgentRuntime
  protected readonly ctx: AdapterContext

  constructor(config: AgentServiceConfig, stsUrl: string) {
    this.runtime = new AgentRuntime(config, stsUrl)
    this.ctx = {
      config,
      call: (req: A2ARequest): Promise<A2AResponse> =>
        a2aCall(req, config.subjectToken, config.clientId, {
          stsUrl,
          zoneId: config.zoneId,
          clientSecret: config.clientSecret,
          clientAssertion: config.clientAssertion,
          clientAssertionType: config.clientAssertionType,
        }),
      tool: (resource: string, opts): Promise<string> =>
        this.runtime.getToolToken(resource, opts),
    }
  }

  protected result(envelope: InvocationEnvelope, result: unknown): InvocationResult {
    return {
      requestId: envelope.requestId,
      result,
    }
  }

  abstract run(...args: unknown[]): Promise<unknown>
}

export class CustomPipelineAdapter extends BaseAdapter {
  constructor(
    config: AgentServiceConfig,
    stsUrl: string,
    private readonly steps: PipelineStep[],
  ) {
    super(config, stsUrl)
  }

  async run(envelope: InvocationEnvelope): Promise<InvocationResult> {
    let value = envelope.params
    for (const step of this.steps) {
      value = await step(value, this.ctx)
    }
    return this.result(envelope, value)
  }
}
