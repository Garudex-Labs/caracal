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

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

export interface A2AOptions {
  stsUrl: string
  clientSecret?: string
  clientAssertion?: string
  clientAssertionType?: string
  ttlSeconds?: number
  timeoutMs?: number
  retries?: number
  retryBaseMs?: number
  fetchImpl?: FetchLike
}

export interface A2AResponse {
  result: unknown
  requestId: string
}
