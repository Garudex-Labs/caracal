// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// A2A call helper: exchanges subject authority for a target agent token.

import { OAuthClient } from '@caracalai/oauth'
import type { A2AOptions, A2ARequest, A2AResponse } from './types.js'

type RuntimeFetch = (url: string, init: {
  method: string
  headers: Record<string, string>
  body: string
}) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
}>

export async function a2aCall(
  req: A2ARequest,
  subjectToken: string,
  clientId: string,
  opts: A2AOptions,
): Promise<A2AResponse> {
  const token = await new OAuthClient(opts.stsUrl, clientId).exchange(subjectToken, req.resource ?? req.agentUrl, {
    clientSecret: opts.clientSecret,
    clientAssertion: opts.clientAssertion,
    clientAssertionType: opts.clientAssertionType,
    scopes: req.scopes,
    sessionId: req.sessionId,
    agentSessionId: req.agentSessionId,
    delegationEdgeId: req.delegationEdgeId,
    ttlSeconds: opts.ttlSeconds,
  })
  const runtimeFetch = (globalThis as unknown as { fetch: RuntimeFetch }).fetch
  const res = await runtimeFetch(`${req.agentUrl}/a2a`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token.accessToken}`,
      'X-Caracal-Client-ID': clientId,
    },
    body: JSON.stringify({
      method: req.method,
      params: req.params,
      requestId: req.requestId,
      clientId,
      zoneId: opts.zoneId,
      resource: req.resource ?? req.agentUrl,
      scopes: req.scopes,
      sessionId: req.sessionId,
      agentSessionId: req.agentSessionId,
      delegationEdgeId: req.delegationEdgeId,
      transport: 'a2a',
      target: req.agentUrl,
      metadata: req.metadata,
    }),
  })

  if (!res.ok) {
    throw new Error(`A2A call failed: ${res.status}`)
  }

  return res.json() as Promise<A2AResponse>
}
