// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// CrewAI adapter: wraps the base adapter for CrewAI agent execution context.

import { BaseAdapter } from './custom.js'
import type { AgentServiceConfig } from '../types.js'

export interface CrewAITask {
  execute: (input: unknown) => Promise<unknown> | unknown
}

export class CrewAIAdapter extends BaseAdapter {
  constructor(
    config: AgentServiceConfig,
    stsUrl: string,
    private readonly task?: CrewAITask,
  ) {
    super(config, stsUrl)
  }

  async run(input: unknown): Promise<unknown> {
    if (!this.task) {
      throw new Error('CrewAI task is required')
    }
    return this.task.execute(input)
  }
}
