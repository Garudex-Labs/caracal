// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Core agent runtime: loads AgentServiceConfig, manages token exchange via sdk-oauth.

import { OAuthClient } from '@caracalai/oauth'
import type { AgentServiceConfig, ToolTokenOptions } from './types.js'

export class AgentRuntime {
  private readonly oauth: OAuthClient

  constructor(
    private readonly config: AgentServiceConfig,
    stsUrl: string,
  ) {
    this.oauth = new OAuthClient(stsUrl, config.clientId)
  }

  async getToolToken(resource: string, opts: ToolTokenOptions = {}): Promise<string> {
    const token = await this.oauth.exchange(this.config.subjectToken, resource, {
      clientSecret: this.config.clientSecret,
      clientAssertion: this.config.clientAssertion,
      clientAssertionType: this.config.clientAssertionType,
      scopes: opts.scopes,
      sessionId: opts.sessionId ?? this.config.sessionId,
      agentSessionId: opts.agentSessionId ?? this.config.agentSessionId,
      delegationEdgeId: opts.delegationEdgeId ?? this.config.delegationEdgeId,
      ttlSeconds: opts.ttlSeconds,
    })
    return token.accessToken
  }

  get serviceUrl(): string {
    return this.config.url
  }

  get audience(): string {
    return this.config.url
  }
}
