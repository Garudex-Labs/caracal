// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// RFC 8693 token exchange types for the @caracalai/oauth client.

export interface TokenExchangeRequest {
  subjectToken: string
  resource: string
  clientId: string
  clientSecret?: string
  clientAssertion?: string
  clientAssertionType?: string
  actorToken?: string
  sessionId?: string
  agentSessionId?: string
  delegationEdgeId?: string
  scopes?: string[]
  ttlSeconds?: number
}

export interface TokenExchangeResponse {
  accessToken: string
  tokenType: 'Bearer'
  expiresIn: number
  issuedAt: number
}

export interface ExchangeOptions {
  clientSecret?: string
  clientAssertion?: string
  clientAssertionType?: string
  actorToken?: string
  sessionId?: string
  agentSessionId?: string
  delegationEdgeId?: string
  scopes?: string[]
  timeoutMs?: number
  ttlSeconds?: number
}

export class InteractionRequiredError extends Error {
  readonly code = 'interaction_required' as const

  constructor(
    message: string,
    public readonly challengeId: string,
    public readonly resource?: string,
    public readonly acrValues?: string,
  ) {
    super(message)
    this.name = 'InteractionRequiredError'
  }
}
