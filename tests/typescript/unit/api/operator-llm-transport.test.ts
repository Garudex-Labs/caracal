// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the Operator LLM data-plane transport: the delegated-mint flow, mandate caching, gateway presentation, and fail-closed behavior.

import { describe, it, expect } from 'vitest'
import {
  createOperatorLlmTransport,
  OperatorLlmTransportError,
  type OperatorTransportIdentity,
} from '../../../../apps/api/src/operator-llm-transport.js'

const STS = 'http://sts.test'
const COORD = 'http://coord.test'
const GATEWAY = 'http://gateway.test'
const RESOURCE = 'caracal-sys://operator-llm-openai'

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

// A fake transport standing in for STS, the coordinator, and the gateway. It records every
// call so a test can assert the mint sequence and the headers presented at the gateway, and
// it issues deterministic ids so the delegated-mint references can be checked.
function fakeFetch(): { fetchImpl: typeof fetch; calls: RecordedCall[]; counters: { spawn: number; mint: number } } {
  const calls: RecordedCall[] = []
  const counters = { spawn: 0, mint: 0 }
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
    const method = init?.method ?? 'GET'
    const headers: Record<string, string> = {}
    new Headers(init?.headers ?? {}).forEach((value, key) => {
      headers[key] = value
    })
    const body = init?.body != null ? String(init.body) : undefined
    calls.push({ url, method, headers, body })

    if (url === `${STS}/oauth/2/token`) {
      const form = new URLSearchParams(body ?? '')
      if (form.get('scope') === 'agent:lifecycle') return json({ access_token: 'boot-token', token_type: 'Bearer', expires_in: 900 })
      if (form.get('scope') === 'llm:invoke') {
        counters.mint += 1
        return json({ access_token: `mandate-${counters.mint}`, token_type: 'Bearer', expires_in: 900 })
      }
      return new Response(JSON.stringify({ error: 'invalid_request' }), { status: 400, headers: { 'content-type': 'application/json' } })
    }
    if (url.endsWith('/agents') && method === 'POST') {
      counters.spawn += 1
      return json({ agent_session_id: `agent-${counters.spawn}` })
    }
    if (url.endsWith('/delegations') && method === 'POST') {
      return json({ delegation_edge_id: 'edge-1' })
    }
    if (url.startsWith(GATEWAY)) {
      return json({ ok: true, presented: headers['authorization'], resource: headers['x-caracal-resource'] })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return { fetchImpl, calls, counters }
}

const identity: OperatorTransportIdentity = { zoneId: 'zone-sys', applicationId: 'app-operator', clientSecret: 'cs_sealed' }

describe('createOperatorLlmTransport', () => {
  it('runs the full delegated-mint flow and presents the minted mandate at the gateway', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const transport = createOperatorLlmTransport({
      stsUrl: STS,
      coordinatorUrl: COORD,
      gatewayUrl: GATEWAY,
      resolveIdentity: () => identity,
      fetchImpl,
    })
    const res = await transport.governedFetch(RESOURCE)(`${GATEWAY}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt', messages: [] }),
    })
    const payload = (await res.json()) as { presented: string; resource: string }

    // The mandate minted by the cycle is what reaches the gateway, with the resource header.
    expect(payload.presented).toBe('Bearer mandate-1')
    expect(payload.resource).toBe(RESOURCE)

    // The flow happened in order: bootstrap, two spawns, one delegation, the mint, then the
    // gateway call.
    const sts = (form: string) => new URLSearchParams(form)
    const tokenCalls = calls.filter((c) => c.url === `${STS}/oauth/2/token`)
    expect(sts(tokenCalls[0].body!).get('scope')).toBe('agent:lifecycle')
    expect(calls.filter((c) => c.url.endsWith('/agents')).length).toBe(2)
    expect(calls.filter((c) => c.url.endsWith('/delegations')).length).toBe(1)
    const mintCall = tokenCalls.find((c) => sts(c.body!).get('scope') === 'llm:invoke')!
    expect(mintCall).toBeDefined()
    expect(calls.at(-1)!.url).toBe(`${GATEWAY}/chat/completions`)
  })

  it('mints against two distinct agent sessions and narrows the delegation to llm:invoke on the resource', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const transport = createOperatorLlmTransport({
      stsUrl: STS,
      coordinatorUrl: COORD,
      gatewayUrl: GATEWAY,
      resolveIdentity: () => identity,
      fetchImpl,
    })
    await transport.governedFetch(RESOURCE)(`${GATEWAY}/chat/completions`, { method: 'POST', body: '{}' })

    const delegation = JSON.parse(calls.find((c) => c.url.endsWith('/delegations'))!.body!)
    expect(delegation.source_session_id).toBe('agent-1')
    expect(delegation.target_session_id).toBe('agent-2')
    expect(delegation.source_session_id).not.toBe(delegation.target_session_id)
    expect(delegation.scopes).toEqual(['llm:invoke'])
    expect(delegation.constraints.resources).toEqual([RESOURCE])

    // The sessions carry the operator label so coordinator listings attribute them.
    const spawnBody = JSON.parse(calls.find((c) => c.url.endsWith('/agents'))!.body!)
    expect(spawnBody.labels).toEqual(['operator'])

    const mint = new URLSearchParams(
      calls.filter((c) => c.url === `${STS}/oauth/2/token`).find((c) => new URLSearchParams(c.body!).get('scope') === 'llm:invoke')!.body!,
    )
    expect(mint.get('agent_session_id')).toBe('agent-2')
    expect(mint.get('delegation_edge_id')).toBe('edge-1')
    // The mint is an application-principal exchange: no subject token rides along, which is
    // what the delegated-mint decision requires.
    expect(mint.get('subject_token')).toBeNull()
  })

  it('caches the mandate so a second call mints nothing new', async () => {
    const { fetchImpl, counters } = fakeFetch()
    const transport = createOperatorLlmTransport({
      stsUrl: STS,
      coordinatorUrl: COORD,
      gatewayUrl: GATEWAY,
      resolveIdentity: () => identity,
      fetchImpl,
    })
    const fetchFor = transport.governedFetch(RESOURCE)
    await fetchFor(`${GATEWAY}/a`, { method: 'POST', body: '{}' })
    await fetchFor(`${GATEWAY}/b`, { method: 'POST', body: '{}' })

    expect(counters.mint).toBe(1)
    expect(counters.spawn).toBe(2)
  })

  it('dedups concurrent first calls into a single mint cycle', async () => {
    const { fetchImpl, counters } = fakeFetch()
    const transport = createOperatorLlmTransport({
      stsUrl: STS,
      coordinatorUrl: COORD,
      gatewayUrl: GATEWAY,
      resolveIdentity: () => identity,
      fetchImpl,
    })
    const fetchFor = transport.governedFetch(RESOURCE)
    await Promise.all([fetchFor(`${GATEWAY}/a`, { method: 'POST', body: '{}' }), fetchFor(`${GATEWAY}/b`, { method: 'POST', body: '{}' })])

    expect(counters.mint).toBe(1)
    expect(counters.spawn).toBe(2)
  })

  it('rebuilds the facade and mints fresh when the resolved identity rotates', async () => {
    const { fetchImpl, counters } = fakeFetch()
    let current = identity
    const transport = createOperatorLlmTransport({
      stsUrl: STS,
      coordinatorUrl: COORD,
      gatewayUrl: GATEWAY,
      resolveIdentity: () => current,
      fetchImpl,
    })
    const fetchFor = transport.governedFetch(RESOURCE)
    await fetchFor(`${GATEWAY}/a`, { method: 'POST', body: '{}' })
    current = { ...identity, clientSecret: 'cs_rotated' }
    await fetchFor(`${GATEWAY}/b`, { method: 'POST', body: '{}' })

    // The rotated credential invalidates the cached facade, so the second call runs a
    // fresh mint cycle on the new secret instead of presenting a mandate minted by the
    // retired one.
    expect(counters.mint).toBe(2)
    expect(counters.spawn).toBe(4)
  })

  it('fails closed when the operator identity is not provisioned', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const transport = createOperatorLlmTransport({
      stsUrl: STS,
      coordinatorUrl: COORD,
      gatewayUrl: GATEWAY,
      resolveIdentity: () => null,
      fetchImpl,
    })
    await expect(transport.governedFetch(RESOURCE)(`${GATEWAY}/x`, { method: 'POST', body: '{}' })).rejects.toBeInstanceOf(
      OperatorLlmTransportError,
    )
    // No upstream is contacted when there is no authority to present.
    expect(calls).toHaveLength(0)
  })

  it('terminates orphaned sessions when the delegation step fails', async () => {
    const calls: RecordedCall[] = []
    let spawn = 0
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
      const method = init?.method ?? 'GET'
      const body = init?.body != null ? String(init.body) : undefined
      calls.push({ url, method, headers: {}, body })
      if (url === `${STS}/oauth/2/token`) return json({ access_token: 'boot-token', token_type: 'Bearer', expires_in: 900 })
      if (url.endsWith('/agents') && method === 'POST') {
        spawn += 1
        return json({ agent_session_id: `agent-${spawn}` })
      }
      if (url.endsWith('/delegations')) return new Response(JSON.stringify({ error: 'denied' }), { status: 403 })
      if (method === 'DELETE') return new Response(null, { status: 204 })
      return new Response('not found', { status: 404 })
    }) as typeof fetch

    const transport = createOperatorLlmTransport({
      stsUrl: STS,
      coordinatorUrl: COORD,
      gatewayUrl: GATEWAY,
      resolveIdentity: () => identity,
      fetchImpl,
    })
    await expect(transport.governedFetch(RESOURCE)(`${GATEWAY}/x`, { method: 'POST', body: '{}' })).rejects.toMatchObject({
      name: 'CoordinatorError',
      status: 403,
    })
    // Both spawned sessions are terminated so a failed cycle leaks nothing.
    const deletes = calls.filter((c) => c.method === 'DELETE')
    expect(deletes).toHaveLength(2)
  })
})
