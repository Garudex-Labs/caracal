// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// RFC 8693 token exchange types for the @caracalai/oauth client.

import { CaracalError } from '@caracalai/core'

export interface TokenExchangeRequest {
  subjectToken: string
  resource: string | string[]
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
  runtimeCredentialInjection?: boolean
}

export interface UpstreamDirective {
  url?: string
  authMode?: string
  authLocation?: string
  authHeader?: string
  queryParamName?: string
  authScheme?: string
  allowedTokenHosts?: string[]
  providerToken?: string
  providerId?: string
  grantId?: string
  forwardCaracalIdentity?: boolean
  expiresAt?: number
}

export interface TokenExchangeResponse {
  accessToken: string
  tokenType: 'Bearer'
  expiresIn: number
  issuedAt: number
  targetResources?: string[]
  upstreams?: Record<string, UpstreamDirective>
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
  retries?: number
  ttlSeconds?: number
  runtimeCredentialInjection?: boolean
}

export class InteractionRequiredError extends CaracalError {
  readonly challengeId: string
  readonly resource?: string
  readonly acrValues?: string

  constructor(
    message: string,
    challengeId: string,
    resource?: string,
    acrValues?: string,
  ) {
    super('interaction_required', message, {
      details: { challengeId, ...(resource ? { resource } : {}), ...(acrValues ? { acrValues } : {}) },
    })
    this.name = 'InteractionRequiredError'
    this.challengeId = challengeId
    this.resource = resource
    this.acrValues = acrValues
  }
}
