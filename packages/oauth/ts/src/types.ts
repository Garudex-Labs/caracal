// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// RFC 8693 token exchange types for the @caracalai/oauth client.

import { CaracalError } from '@caracalai/core'

export { CaracalError }

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
  challengeId?: string
  /** Skip the cached token and mint a fresh one; the result still refills the cache. */
  forceRefresh?: boolean
}

export interface InteractionRequiredDetails {
  resource?: string
  state?: string
  tier?: string
  binding?: string
  expiresAt?: string
  requestId?: string
  httpStatus?: number
}

export class InteractionRequiredError extends CaracalError {
  readonly challengeId: string
  readonly resource?: string
  readonly state?: string
  readonly tier?: string
  readonly binding?: string
  readonly expiresAt?: string

  constructor(message: string, challengeId: string, details: InteractionRequiredDetails = {}) {
    const { requestId, httpStatus, ...rest } = details
    super('interaction_required', message, {
      details: { challengeId, ...rest },
      requestId,
      httpStatus,
    })
    this.name = 'InteractionRequiredError'
    this.challengeId = challengeId
    this.resource = details.resource
    this.state = details.state
    this.tier = details.tier
    this.binding = details.binding
    this.expiresAt = details.expiresAt
  }
}

/** One completed token exchange: cache hits and network mints both count, single-flight joiners do not. */
export interface TokenExchangeEvent {
  type: 'token.exchange'
  resources: string[]
  scopes: string[]
  cached: boolean
  ok: boolean
  durationMs: number
  status?: number
  code?: string
}

/** One completed approval wait and the final challenge state it observed. */
export interface ApprovalWaitEvent {
  type: 'approval.wait'
  challengeId: string
  state: string
  ok: boolean
  durationMs: number
}

export type OAuthEvent = TokenExchangeEvent | ApprovalWaitEvent
