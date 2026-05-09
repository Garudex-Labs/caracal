// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// A2A protocol message and option types.

export interface A2ARequest {
  agentUrl: string
  resource?: string
  method: string
  params: unknown
  requestId: string
  scopes?: string[]
  sessionId?: string
  agentSessionId?: string
  delegationEdgeId?: string
  metadata?: Record<string, unknown>
}

export interface A2AOptions {
  stsUrl: string
  clientSecret?: string
  clientAssertion?: string
  clientAssertionType?: string
  ttlSeconds?: number
}

export interface A2AResponse {
  result: unknown
  requestId: string
}
