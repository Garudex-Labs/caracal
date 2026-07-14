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
  authorityRecordId?: string
  sessionId?: string
  delegationId?: string
  scopes?: string[]
  ttlSeconds?: number
}

export interface TokenExchangeResponse {
  accessToken: string
  tokenType: 'Bearer'
  expiresIn: number
  issuedAt: number
  targetResources?: string[]
}

export interface ExchangeOptions {
  clientSecret?: string
  authorityRecordId?: string
  sessionId?: string
  delegationId?: string
  scopes?: string[]
  timeoutMs?: number
  ttlSeconds?: number
  approvalId?: string
  /** Skip the cached token and mint a fresh one; the result still refills the cache. */
  forceRefresh?: boolean
  /** Mint without reading, writing, or joining the token cache. */
  cache?: boolean
  /** Aborts the exchange request. */
  signal?: AbortSignal
}

/**
 * Lifecycle state of an approval challenge. 'approved' means a retry of the
 * held mint with the challenge id will succeed; 'rejected' and 'expired' are
 * terminal; 'consumed' means another request already spent the approval;
 * 'pending' means no decision arrived within the wait and polling again is safe.
 */
export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed'

export const APPROVAL_STATES: readonly ApprovalState[] = ['pending', 'approved', 'rejected', 'expired', 'consumed']

export interface ApprovalRequiredDetails {
  resource?: string
  state?: string
  tier?: string
  binding?: string
  expiresAt?: string
  requestId?: string
  httpStatus?: number
}

export class ApprovalRequiredError extends CaracalError {
  readonly approvalId: string
  readonly resource?: string
  readonly state?: string
  readonly tier?: string
  readonly binding?: string
  readonly expiresAt?: string

  constructor(message: string, approvalId: string, details: ApprovalRequiredDetails = {}) {
    const { requestId, httpStatus, ...rest } = details
    super('interaction_required', message, {
      details: { approvalId, ...rest },
      requestId,
      httpStatus,
    })
    this.name = 'ApprovalRequiredError'
    this.approvalId = approvalId
    this.resource = details.resource
    this.state = details.state
    this.tier = details.tier
    this.binding = details.binding
    this.expiresAt = details.expiresAt
  }
}

/**
 * Reports whether the error is an approval hold. Prefer this over instanceof:
 * it also recognizes holds surfaced across duplicated module instances by
 * checking the error's machine-readable shape.
 */
export function isApprovalRequired(err: unknown): err is ApprovalRequiredError {
  if (err instanceof ApprovalRequiredError) return true
  if (!(err instanceof Error)) return false
  const shaped = err as { code?: unknown; approvalId?: unknown }
  return shaped.code === 'interaction_required' && typeof shaped.approvalId === 'string'
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
  approvalId: string
  state: string
  ok: boolean
  durationMs: number
}

export type OAuthEvent = TokenExchangeEvent | ApprovalWaitEvent
