// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// A2A call helper: exchanges subject authority for a target agent token.

import { OAuthClient } from '@caracalai/oauth'
import { toHeaders, current, type Envelope } from '@caracalai/sdk/advanced'
import type { A2AOptions, A2ARequest, A2AResponse, FetchLike } from './types.js'

export async function a2aCall(
  req: A2ARequest,
  subjectToken: string,
  zoneId: string,
  applicationId: string,
  opts: A2AOptions,
): Promise<A2AResponse> {
  const token = await (opts.oauthClient ?? new OAuthClient(opts.stsUrl, zoneId, applicationId)).exchange(
    subjectToken,
    req.resource ?? req.agentUrl,
    {
      clientSecret: opts.clientSecret,
      clientAssertion: opts.clientAssertion,
      clientAssertionType: opts.clientAssertionType,
      scopes: req.scopes,
      sessionId: req.sessionId,
      agentSessionId: req.agentSessionId,
      delegationEdgeId: req.delegationEdgeId,
      ttlSeconds: opts.ttlSeconds,
      timeoutMs: opts.timeoutMs,
      retries: opts.retries,
    },
  )

  const ctx = current()
  const envelope: Envelope = {
    subjectToken: token.accessToken,
    agentSessionId: ctx?.agentSessionId ?? req.agentSessionId,
    delegationEdgeId: ctx?.delegationEdgeId ?? req.delegationEdgeId,
    parentEdgeId: ctx?.parentEdgeId,
    sessionId: ctx?.sessionId ?? req.sessionId,
    traceId: ctx?.traceId,
    hop: ctx?.hop ?? 0,
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...toHeaders(envelope),
    'X-Caracal-Zone-Id': zoneId,
    'X-Caracal-Application-Id': applicationId,
  }

  const fetchImpl = opts.fetchImpl ?? (globalThis as unknown as { fetch: FetchLike }).fetch
  const body = JSON.stringify({
    method: req.method,
    params: req.params,
    requestId: req.requestId,
    zoneId,
    applicationId,
    resource: req.resource ?? req.agentUrl,
    scopes: req.scopes,
    sessionId: req.sessionId,
    agentSessionId: req.agentSessionId,
    delegationEdgeId: req.delegationEdgeId,
    transport: 'a2a',
    target: req.agentUrl,
    metadata: req.metadata,
  })
  const res = await fetchWithRetry(fetchImpl, `${req.agentUrl}/a2a`, {
    method: 'POST',
    headers,
    body,
  }, opts)

  if (!res.ok) {
    throw new Error(`A2A call failed: ${res.status}`)
  }

  return parseA2AResponse(await res.json(), req.requestId)
}

async function fetchWithRetry(
  fetchImpl: FetchLike,
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
  opts: A2AOptions,
): ReturnType<FetchLike> {
  const retries = opts.retries ?? 2
  const timeoutMs = opts.timeoutMs ?? 30_000
  const retryBaseMs = opts.retryBaseMs ?? 250
  let last: Awaited<ReturnType<FetchLike>> | undefined
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      last = await fetchImpl(url, {
        ...init,
        headers: { ...init.headers, 'X-Caracal-Retry-Attempt': String(attempt) },
        signal: controller.signal,
      })
      if (!isRetryableResponse(last.status, opts) || attempt === retries) return last
    } catch (err) {
      lastErr = err
      if (attempt === retries) throw err
    } finally {
      clearTimeout(timeout)
    }
    await delay(jitteredBackoff(retryBaseMs, attempt))
  }
  if (lastErr) throw lastErr
  return last as Awaited<ReturnType<FetchLike>>
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600)
}

function isRetryableResponse(status: number, opts: A2AOptions): boolean {
  return opts.retryTransientStatuses === true && isTransientStatus(status)
}

function jitteredBackoff(baseMs: number, attempt: number): number {
  const cap = Math.min(baseMs * 2 ** attempt, 5_000)
  return cap / 2 + Math.random() * (cap / 2)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function parseA2AResponse(value: unknown, requestId: string): A2AResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('A2A response invalid: expected object')
  }
  const body = value as Record<string, unknown>
  if (body.requestId !== requestId) {
    throw new Error('A2A response invalid: requestId mismatch')
  }
  if (!Object.hasOwn(body, 'result')) {
    throw new Error('A2A response invalid: result is required')
  }
  return { requestId, result: body.result }
}
