/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * governedTransport tests: the delegated-mint cycle, mandate caching, gateway routing, cleanup, and configuration guards.
 */

import { describe, it, expect } from 'vitest'
import { Caracal } from '../../../../packages/sdk/ts/src/index.js'

const STS = 'http://sts.test'
const COORD = 'http://coord.test'
const GATEWAY = 'http://gateway.test'
const RESOURCE = 'resource://pipernet'

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
      counters.mint += 1
      return json({ access_token: `mandate-${counters.mint}`, token_type: 'Bearer', expires_in: 900 })
    }
    if (url.endsWith('/agents') && method === 'POST') {
      counters.spawn += 1
      return json({ agent_session_id: `agent-${counters.spawn}` })
    }
    if (url.endsWith('/delegations') && method === 'POST') {
      return json({ delegation_edge_id: 'edge-1' })
    }
    if (url.startsWith(GATEWAY)) {
      return json({ ok: true, presented: headers['authorization'], resource: headers['x-caracal-resource'], target: url })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return { fetchImpl, calls, counters }
}

function client(fetchImpl: typeof fetch): Caracal {
  return Caracal.fromClientSecret({
    coordinatorUrl: COORD,
    stsUrl: STS,
    zoneId: 'zone-1',
    applicationId: 'app-1',
    clientSecret: 'cs_test',
    gatewayUrl: GATEWAY,
    resources: [{ resourceId: RESOURCE, upstreamPrefix: 'https://api.pipernet.example' }],
    fetchImpl,
  })
}

describe('Caracal.governedTransport', () => {
  it('runs the delegated-mint cycle and presents the mandate with the resource header at the gateway', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const governed = client(fetchImpl).governedTransport(RESOURCE, { scopes: ['data:read'] })

    const res = await governed(`${GATEWAY}/v1/things`, { method: 'POST', body: '{}' })
    const payload = (await res.json()) as { presented: string; resource: string }

    expect(payload.presented).toBe('Bearer mandate-1')
    expect(payload.resource).toBe(RESOURCE)

    const tokenCalls = calls.filter((c) => c.url === `${STS}/oauth/2/token`)
    expect(new URLSearchParams(tokenCalls[0].body!).get('scope')).toBe('agent:lifecycle')
    expect(calls.filter((c) => c.url.endsWith('/agents') && c.method === 'POST')).toHaveLength(2)
    expect(calls.filter((c) => c.url.endsWith('/delegations'))).toHaveLength(1)
    expect(calls.at(-1)!.url).toBe(`${GATEWAY}/v1/things`)
  })

  it('narrows the delegation to the requested scopes on the resource and mints on the target session', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const governed = client(fetchImpl).governedTransport(RESOURCE, { scopes: ['data:read'], labels: ['worker'], mandateTtlSeconds: 300 })

    await governed(`${GATEWAY}/v1/things`, { method: 'POST', body: '{}' })

    const spawnBody = JSON.parse(calls.find((c) => c.url.endsWith('/agents'))!.body!)
    expect(spawnBody.labels).toEqual(['worker'])
    // Sessions outlive the mandate by the fixed buffer so the mandate never outruns them.
    expect(spawnBody.ttl_seconds).toBe(420)

    const delegation = JSON.parse(calls.find((c) => c.url.endsWith('/delegations'))!.body!)
    expect(delegation.source_session_id).toBe('agent-1')
    expect(delegation.target_session_id).toBe('agent-2')
    expect(delegation.scopes).toEqual(['data:read'])
    expect(delegation.constraints.resources).toEqual([RESOURCE])

    const mint = new URLSearchParams(
      calls.filter((c) => c.url === `${STS}/oauth/2/token`).find((c) => new URLSearchParams(c.body!).get('scope') === 'data:read')!.body!,
    )
    expect(mint.get('agent_session_id')).toBe('agent-2')
    expect(mint.get('delegation_edge_id')).toBe('edge-1')
    expect(mint.get('ttl_seconds')).toBe('300')
    // The mint is an application-principal exchange: no subject token rides along.
    expect(mint.get('subject_token')).toBeNull()
  })

  it('rewrites bound upstream URLs onto the gateway and passes gateway URLs through unchanged', async () => {
    const { fetchImpl } = fakeFetch()
    const governed = client(fetchImpl).governedTransport(RESOURCE, { scopes: ['data:read'] })

    const rewritten = await governed('https://api.pipernet.example/v1/chat', { method: 'POST', body: '{}' })
    expect(((await rewritten.json()) as { target: string }).target).toBe(`${GATEWAY}/v1/chat`)

    const direct = await governed(`${GATEWAY}/v1/chat`, { method: 'POST', body: '{}' })
    expect(((await direct.json()) as { target: string }).target).toBe(`${GATEWAY}/v1/chat`)
  })

  it('caches the mandate per resource and scope set so repeat calls mint nothing new', async () => {
    const { fetchImpl, counters } = fakeFetch()
    const governed = client(fetchImpl).governedTransport(RESOURCE, { scopes: ['data:read'] })

    await governed(`${GATEWAY}/a`, { method: 'POST', body: '{}' })
    await governed(`${GATEWAY}/b`, { method: 'POST', body: '{}' })

    expect(counters.mint).toBe(1)
    expect(counters.spawn).toBe(2)
  })

  it('does not share cached mandates across different labels or TTLs', async () => {
    const { fetchImpl, calls, counters } = fakeFetch()
    const caracal = client(fetchImpl)
    const worker = caracal.governedTransport(RESOURCE, { scopes: ['data:read'], labels: ['worker'], mandateTtlSeconds: 300 })
    const admin = caracal.governedTransport(RESOURCE, { scopes: ['data:read'], labels: ['admin'], mandateTtlSeconds: 60 })

    await worker(`${GATEWAY}/worker`, { method: 'POST', body: '{}' })
    await admin(`${GATEWAY}/admin`, { method: 'POST', body: '{}' })

    expect(counters.mint).toBe(2)
    expect(counters.spawn).toBe(4)
    const spawnBodies = calls.filter((c) => c.url.endsWith('/agents')).map((c) => JSON.parse(c.body!))
    expect(spawnBodies[2].labels).toEqual(['admin'])
    expect(spawnBodies[2].ttl_seconds).toBe(180)
    const finalMint = calls
      .filter((c) => c.url === `${STS}/oauth/2/token`)
      .map((c) => new URLSearchParams(c.body!))
      .filter((form) => form.get('scope') === 'data:read')
      .at(-1)!
    expect(finalMint.get('ttl_seconds')).toBe('60')
  })

  it('dedups concurrent first calls into a single mint cycle', async () => {
    const { fetchImpl, counters } = fakeFetch()
    const governed = client(fetchImpl).governedTransport(RESOURCE, { scopes: ['data:read'] })

    await Promise.all([governed(`${GATEWAY}/a`, { method: 'POST', body: '{}' }), governed(`${GATEWAY}/b`, { method: 'POST', body: '{}' })])

    expect(counters.mint).toBe(1)
    expect(counters.spawn).toBe(2)
  })

  it('terminates spawned sessions when the delegation step fails', async () => {
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

    const governed = client(fetchImpl).governedTransport(RESOURCE, { scopes: ['data:read'] })
    await expect(governed(`${GATEWAY}/x`, { method: 'POST', body: '{}' })).rejects.toMatchObject({ name: 'CoordinatorError', status: 403 })

    const deletes = calls.filter((c) => c.method === 'DELETE')
    expect(deletes).toHaveLength(2)
    expect(deletes.map((c) => c.url.split('/').at(-1))).toEqual(['agent-1', 'agent-2'])
  })

  it('rejects configurations that cannot mint', () => {
    const { fetchImpl } = fakeFetch()
    const subjectClient = new Caracal({
      coordinator: { baseUrl: COORD, fetchImpl },
      zoneId: 'zone-1',
      applicationId: 'app-1',
      subjectToken: 'subject-token',
    })
    expect(() => subjectClient.governedTransport(RESOURCE, { scopes: ['data:read'] })).toThrow(/client-secret configuration/)
    expect(() => client(fetchImpl).governedTransport('', { scopes: ['data:read'] })).toThrow(/resourceId is required/)
    expect(() => client(fetchImpl).governedTransport(RESOURCE, { scopes: [] })).toThrow(/scopes are required/)
  })

  it('labels the spawned sessions with the application id when none are given', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const governed = client(fetchImpl).governedTransport(RESOURCE, { scopes: ['data:read'] })

    await governed(`${GATEWAY}/v1/things`, { method: 'POST', body: '{}' })

    const spawnBody = JSON.parse(calls.find((c) => c.url.endsWith('/agents'))!.body!)
    expect(spawnBody.labels).toEqual(['app-1'])
  })
})

describe('Caracal.fromClientSecret with a credentials resolver', () => {
  function resolverClient(fetchImpl: typeof fetch, resolve: () => { zoneId: string; applicationId: string; clientSecret: string } | null) {
    return Caracal.fromClientSecret({
      coordinatorUrl: COORD,
      stsUrl: STS,
      gatewayUrl: GATEWAY,
      credentials: resolve,
      fetchImpl,
    })
  }

  it('runs a governed transport without any configured resources', async () => {
    const { fetchImpl } = fakeFetch()
    const caracal = resolverClient(fetchImpl, () => ({ zoneId: 'zone-1', applicationId: 'app-1', clientSecret: 'cs_test' }))
    const governed = caracal.governedTransport(RESOURCE, { scopes: ['data:read'] })

    const res = await governed(`${GATEWAY}/v1/things`, { method: 'POST', body: '{}' })
    expect(((await res.json()) as { presented: string }).presented).toBe('Bearer mandate-1')
  })

  it('fails closed with CredentialsUnavailableError while the resolver returns nothing', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const caracal = resolverClient(fetchImpl, () => null)
    const governed = caracal.governedTransport(RESOURCE, { scopes: ['data:read'] })

    await expect(governed(`${GATEWAY}/v1/things`, { method: 'POST' })).rejects.toMatchObject({ name: 'CredentialsUnavailableError' })
    expect(calls).toHaveLength(0)
  })

  it('recovers on the next call once the resolver supplies credentials', async () => {
    const { fetchImpl } = fakeFetch()
    let creds: { zoneId: string; applicationId: string; clientSecret: string } | null = null
    const caracal = resolverClient(fetchImpl, () => creds)
    const governed = caracal.governedTransport(RESOURCE, { scopes: ['data:read'] })

    await expect(governed(`${GATEWAY}/v1/things`, { method: 'POST' })).rejects.toMatchObject({ name: 'CredentialsUnavailableError' })
    creds = { zoneId: 'zone-1', applicationId: 'app-1', clientSecret: 'cs_test' }
    const res = await governed(`${GATEWAY}/v1/things`, { method: 'POST', body: '{}' })
    expect(((await res.json()) as { presented: string }).presented).toBe('Bearer mandate-1')
  })

  it('runs a fresh mint cycle when the resolved identity changes, never serving the old identity\u2019s mandate', async () => {
    const { fetchImpl, calls, counters } = fakeFetch()
    let creds = { zoneId: 'zone-1', applicationId: 'app-1', clientSecret: 'cs_test' }
    const caracal = resolverClient(fetchImpl, () => creds)
    const governed = caracal.governedTransport(RESOURCE, { scopes: ['data:read'] })

    await governed(`${GATEWAY}/a`, { method: 'POST', body: '{}' })
    creds = { zoneId: 'zone-2', applicationId: 'app-2', clientSecret: 'cs_next' }
    const res = await governed(`${GATEWAY}/b`, { method: 'POST', body: '{}' })

    expect(((await res.json()) as { presented: string }).presented).toBe('Bearer mandate-2')
    expect(counters.mint).toBe(2)
    const lastMint = calls
      .filter((c) => c.url === `${STS}/oauth/2/token`)
      .map((c) => new URLSearchParams(c.body!))
      .at(-1)!
    expect(lastMint.get('zone_id')).toBe('zone-2')
    expect(lastMint.get('application_id')).toBe('app-2')
  })

  it('rejects a resolver combined with static credentials, and a spawn path without resources', async () => {
    const { fetchImpl } = fakeFetch()
    expect(() =>
      Caracal.fromClientSecret({
        coordinatorUrl: COORD,
        stsUrl: STS,
        zoneId: 'zone-1',
        applicationId: 'app-1',
        clientSecret: 'cs_test',
        credentials: () => null,
        fetchImpl,
      }),
    ).toThrow(/not both/)

    const caracal = resolverClient(fetchImpl, () => ({ zoneId: 'zone-1', applicationId: 'app-1', clientSecret: 'cs_test' }))
    await expect(caracal.spawn(async () => 'unreached')).rejects.toThrow(/no resources configured/)
  })
})
