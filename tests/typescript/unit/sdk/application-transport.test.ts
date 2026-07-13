/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * applicationTransport tests: the delegated-mint cycle, mandate caching, gateway routing, cleanup, and configuration guards.
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
  redirect?: RequestRedirect
  signal?: AbortSignal | null
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
  const presented = new Set<string>()
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
    const request = input instanceof Request ? input : undefined
    const method = init?.method ?? request?.method ?? 'GET'
    const headers: Record<string, string> = {}
    new Headers(init?.headers ?? request?.headers ?? {}).forEach((value, key) => {
      headers[key] = value
    })
    const body = init?.body != null ? String(init.body) : request ? await request.clone().text() : undefined
    calls.push({ url, method, headers, body, redirect: init?.redirect ?? request?.redirect, signal: init?.signal ?? request?.signal })

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
    if (method === 'DELETE') {
      return new Response(null, { status: 204 })
    }
    if (url.startsWith(GATEWAY)) {
      if (presented.has(headers['authorization'])) return new Response(JSON.stringify({ error: 'token_replayed' }), { status: 409 })
      presented.add(headers['authorization'])
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

describe('Caracal.applicationTransport', () => {
  it('requires a configured gateway before minting authority', () => {
    const { fetchImpl } = fakeFetch()
    const caracal = Caracal.fromClientSecret({
      coordinatorUrl: COORD,
      stsUrl: STS,
      zoneId: 'zone-1',
      applicationId: 'app-1',
      clientSecret: 'secret',
      fetchImpl,
    })

    expect(() => caracal.applicationTransport(RESOURCE, { scopes: ['data:read'] })).toThrow(/requires gatewayUrl/)
  })

  it('runs the delegated-mint cycle and presents the mandate with the resource header at the gateway', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const appFetch = client(fetchImpl).applicationTransport(RESOURCE, { scopes: ['data:read'] })

    const res = await appFetch(`${GATEWAY}/v1/things`, { method: 'POST', body: '{}' })
    const payload = (await res.json()) as { presented: string; resource: string }

    expect(payload.presented).toBe('Bearer mandate-1')
    expect(payload.resource).toBe(RESOURCE)

    const tokenCalls = calls.filter((c) => c.url === `${STS}/oauth/2/token`)
    expect(new URLSearchParams(tokenCalls[0].body!).get('scope')).toBe('agent:lifecycle')
    expect(calls.filter((c) => c.url.endsWith('/agents') && c.method === 'POST')).toHaveLength(2)
    expect(calls.filter((c) => c.url.endsWith('/delegations'))).toHaveLength(1)
    expect(calls.at(-1)!.url).toBe(`${GATEWAY}/v1/things`)
    expect(calls.at(-1)!.headers.traceparent).toMatch(/^00-/)
    expect(calls.at(-1)!.headers.baggage).toContain('caracal.agent_session=agent-2')
    expect(calls.at(-1)!.headers.baggage).toContain('caracal.delegation_edge=edge-1')
    expect(calls.at(-1)!.redirect).toBe('manual')
  })

  it('applies one timeout signal across provisioning, final mint, and dispatch', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const appFetch = client(fetchImpl).applicationTransport(RESOURCE, { scopes: ['data:read'], timeoutMs: 5000 })

    await appFetch(`${GATEWAY}/v1/things`)

    expect(calls).not.toHaveLength(0)
    for (const call of calls) expect(call.signal).toBeInstanceOf(AbortSignal)
  })

  it('narrows the delegation to the requested scopes on the resource and mints on the target session', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const appFetch = client(fetchImpl).applicationTransport(RESOURCE, { scopes: ['data:read'], labels: ['worker'], mandateTtlSeconds: 300 })

    await appFetch(`${GATEWAY}/v1/things`, { method: 'POST', body: '{}' })

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

  it('defaults explicit empty labels to the application id for both sessions', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const appFetch = client(fetchImpl).applicationTransport(RESOURCE, { scopes: ['data:read'], labels: [] })

    await appFetch(`${GATEWAY}/v1/things`, { method: 'POST', body: '{}' })

    const spawns = calls.filter((call) => call.url.endsWith('/agents') && call.method === 'POST')
    expect(spawns).toHaveLength(2)
    for (const spawn of spawns) expect(JSON.parse(spawn.body!).labels).toEqual(['app-1'])
  })

  it('close terminates the sessions backing cached mandates', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const c = client(fetchImpl)
    const appFetch = c.applicationTransport(RESOURCE, { scopes: ['data:read'] })
    await appFetch(`${GATEWAY}/v1/things`)

    await c.close()

    const deletes = calls.filter((call) => call.method === 'DELETE')
    expect(deletes.map((call) => call.url).sort()).toEqual([`${COORD}/zones/zone-1/agents/agent-1`, `${COORD}/zones/zone-1/agents/agent-2`])

    await c.close()
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(2)
    expect(() => c.gatewayRequest(RESOURCE, '/things')).toThrow('Caracal client is closed')
  })

  it('rejects in-flight and subsequent requests once close begins', async () => {
    const { fetchImpl: platformFetch, calls, counters } = fakeFetch()
    let markFirstDelegation!: () => void
    let releaseFirstDelegation!: () => void
    const firstDelegation = new Promise<void>((resolve) => {
      markFirstDelegation = resolve
    })
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirstDelegation = resolve
    })
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
      if (url.endsWith('/delegations') && method === 'POST') {
        markFirstDelegation()
        await firstRelease
      }
      return platformFetch(input, init)
    }) as typeof fetch
    const caracal = client(fetchImpl)
    const appFetch = caracal.applicationTransport(RESOURCE, { scopes: ['data:read'] })

    const firstRequest = appFetch(`${GATEWAY}/first`)
    await firstDelegation
    const closing = caracal.close()
    const secondRequest = appFetch(`${GATEWAY}/second`)
    releaseFirstDelegation()

    await expect(firstRequest).rejects.toThrow('Caracal client is closed')
    await expect(secondRequest).rejects.toThrow('Caracal client is closed')
    await closing
    expect(counters.spawn).toBe(2)
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.url.split('/').at(-1))).toEqual(['agent-1', 'agent-2'])
  })

  it('rewrites bound upstream URLs onto the gateway and passes gateway URLs through unchanged', async () => {
    const { fetchImpl } = fakeFetch()
    const appFetch = client(fetchImpl).applicationTransport(RESOURCE, { scopes: ['data:read'] })

    const rewritten = await appFetch('https://api.pipernet.example/v1/chat', { method: 'POST', body: '{}' })
    expect(((await rewritten.json()) as { target: string }).target).toBe(`${GATEWAY}/v1/chat`)

    const direct = await appFetch(`${GATEWAY}/v1/chat`, { method: 'POST', body: '{}' })
    expect(((await direct.json()) as { target: string }).target).toBe(`${GATEWAY}/v1/chat`)
  })

  it('mints a distinct mandate per request while reusing the authority pair', async () => {
    const { fetchImpl, counters } = fakeFetch()
    const appFetch = client(fetchImpl).applicationTransport(RESOURCE, { scopes: ['data:read'] })

    await appFetch(`${GATEWAY}/a`, { method: 'POST', body: '{}' })
    await appFetch(`${GATEWAY}/b`, { method: 'POST', body: '{}' })

    expect(counters.mint).toBe(2)
    expect(counters.spawn).toBe(2)
  })

  it('does not share cached mandates across different labels or TTLs', async () => {
    const { fetchImpl, calls, counters } = fakeFetch()
    const caracal = client(fetchImpl)
    const worker = caracal.applicationTransport(RESOURCE, { scopes: ['data:read'], labels: ['a b'], mandateTtlSeconds: 300 })
    const admin = caracal.applicationTransport(RESOURCE, { scopes: ['data:read'], labels: ['a', 'b'], mandateTtlSeconds: 60 })

    await worker(`${GATEWAY}/worker`, { method: 'POST', body: '{}' })
    await admin(`${GATEWAY}/admin`, { method: 'POST', body: '{}' })

    expect(counters.mint).toBe(2)
    expect(counters.spawn).toBe(4)
    const spawnBodies = calls.filter((c) => c.url.endsWith('/agents')).map((c) => JSON.parse(c.body!))
    expect(spawnBodies[2].labels).toEqual(['a', 'b'])
    expect(spawnBodies[2].ttl_seconds).toBe(180)
    const finalMint = calls
      .filter((c) => c.url === `${STS}/oauth/2/token`)
      .map((c) => new URLSearchParams(c.body!))
      .filter((form) => form.get('scope') === 'data:read')
      .at(-1)!
    expect(finalMint.get('ttl_seconds')).toBe('60')
  })

  it('dedups concurrent provisioning without sharing a bearer', async () => {
    const { fetchImpl, counters } = fakeFetch()
    const appFetch = client(fetchImpl).applicationTransport(RESOURCE, { scopes: ['data:read'] })

    await Promise.all([appFetch(`${GATEWAY}/a`, { method: 'POST', body: '{}' }), appFetch(`${GATEWAY}/b`, { method: 'POST', body: '{}' })])

    expect(counters.mint).toBe(2)
    expect(counters.spawn).toBe(2)
  })

  it('evicts and retires authority pairs before exceeding coordinator capacity', async () => {
    const { fetchImpl, calls, counters } = fakeFetch()
    const caracal = client(fetchImpl)
    for (let index = 0; index < 20; index++) {
      const appFetch = caracal.applicationTransport(RESOURCE, { scopes: ['data:read'], labels: [`worker-${index}`] })
      await appFetch(`${GATEWAY}/${index}`)
    }
    expect(counters.spawn).toBe(40)
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(2)
  })

  it('preserves Request method, headers, body, and signal while rewriting', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const appFetch = client(fetchImpl).applicationTransport(RESOURCE, { scopes: ['data:read'] })
    const controller = new AbortController()
    const request = new Request('https://api.pipernet.example/v1/things', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-existing': '1' },
      body: '{"name":"PiperNet"}',
      signal: controller.signal,
    })

    await appFetch(request)

    const gateway = calls.at(-1)!
    expect(gateway.method).toBe('POST')
    expect(gateway.headers['content-type']).toBe('application/json')
    expect(gateway.headers['x-existing']).toBe('1')
    expect(gateway.body).toBe('{"name":"PiperNet"}')
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

    const appFetch = client(fetchImpl).applicationTransport(RESOURCE, { scopes: ['data:read'] })
    await expect(appFetch(`${GATEWAY}/x`, { method: 'POST', body: '{}' })).rejects.toMatchObject({ name: 'CoordinatorError', status: 403 })

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
    expect(() => subjectClient.applicationTransport(RESOURCE, { scopes: ['data:read'] })).toThrow(/client-secret configuration/)
    expect(() => client(fetchImpl).applicationTransport('', { scopes: ['data:read'] })).toThrow(/resourceId is required/)
    expect(() => client(fetchImpl).applicationTransport(RESOURCE, { scopes: [] })).toThrow(/scopes are required/)
  })

  it('labels the started sessions with the application id when none are given', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const appFetch = client(fetchImpl).applicationTransport(RESOURCE, { scopes: ['data:read'] })

    await appFetch(`${GATEWAY}/v1/things`, { method: 'POST', body: '{}' })

    const spawnBody = JSON.parse(calls.find((c) => c.url.endsWith('/agents'))!.body!)
    expect(spawnBody.labels).toEqual(['app-1'])
  })
})

describe('advanced credentials resolver', () => {
  function resolverClient(fetchImpl: typeof fetch, resolve: () => { zoneId: string; applicationId: string; clientSecret: string } | null) {
    return Caracal.fromClientSecret({
      coordinatorUrl: COORD,
      stsUrl: STS,
      gatewayUrl: GATEWAY,
      credentials: resolve,
      fetchImpl,
    })
  }

  it('runs an application transport without any configured resources', async () => {
    const { fetchImpl } = fakeFetch()
    const caracal = resolverClient(fetchImpl, () => ({ zoneId: 'zone-1', applicationId: 'app-1', clientSecret: 'cs_test' }))
    const appFetch = caracal.applicationTransport(RESOURCE, { scopes: ['data:read'] })

    const res = await appFetch(`${GATEWAY}/v1/things`, { method: 'POST', body: '{}' })
    expect(((await res.json()) as { presented: string }).presented).toBe('Bearer mandate-1')
  })

  it('fails closed with CredentialsUnavailableError while the resolver returns nothing', async () => {
    const { fetchImpl, calls } = fakeFetch()
    const caracal = resolverClient(fetchImpl, () => null)
    const appFetch = caracal.applicationTransport(RESOURCE, { scopes: ['data:read'] })

    await expect(appFetch(`${GATEWAY}/v1/things`, { method: 'POST' })).rejects.toMatchObject({ name: 'CredentialsUnavailableError' })
    expect(calls).toHaveLength(0)
  })

  it('recovers on the next call once the resolver supplies credentials', async () => {
    const { fetchImpl } = fakeFetch()
    let creds: { zoneId: string; applicationId: string; clientSecret: string } | null = null
    const caracal = resolverClient(fetchImpl, () => creds)
    const appFetch = caracal.applicationTransport(RESOURCE, { scopes: ['data:read'] })

    await expect(appFetch(`${GATEWAY}/v1/things`, { method: 'POST' })).rejects.toMatchObject({ name: 'CredentialsUnavailableError' })
    creds = { zoneId: 'zone-1', applicationId: 'app-1', clientSecret: 'cs_test' }
    const res = await appFetch(`${GATEWAY}/v1/things`, { method: 'POST', body: '{}' })
    expect(((await res.json()) as { presented: string }).presented).toBe('Bearer mandate-1')
  })

  it('runs a fresh mint cycle when the resolved identity changes, never serving the old identity\u2019s mandate', async () => {
    const { fetchImpl, calls, counters } = fakeFetch()
    let creds = { zoneId: 'zone-1', applicationId: 'app-1', clientSecret: 'cs_test' }
    const caracal = resolverClient(fetchImpl, () => creds)
    const appFetch = caracal.applicationTransport(RESOURCE, { scopes: ['data:read'] })

    await appFetch(`${GATEWAY}/a`, { method: 'POST', body: '{}' })
    creds = { zoneId: 'zone-2', applicationId: 'app-2', clientSecret: 'cs_next' }
    const res = await appFetch(`${GATEWAY}/b`, { method: 'POST', body: '{}' })

    expect(((await res.json()) as { presented: string }).presented).toBe('Bearer mandate-2')
    expect(counters.mint).toBe(2)
    const lastMint = calls
      .filter((c) => c.url === `${STS}/oauth/2/token`)
      .map((c) => new URLSearchParams(c.body!))
      .at(-1)!
    expect(lastMint.get('zone_id')).toBe('zone-2')
    expect(lastMint.get('application_id')).toBe('app-2')
  })

  it('runs a fresh authority cycle when only the client secret rotates', async () => {
    const { fetchImpl, calls, counters } = fakeFetch()
    let creds = { zoneId: 'zone-1', applicationId: 'app-1', clientSecret: 'cs_test' }
    const caracal = resolverClient(fetchImpl, () => creds)
    const appFetch = caracal.applicationTransport(RESOURCE, { scopes: ['data:read'] })
    await appFetch(`${GATEWAY}/a`)
    creds = { ...creds, clientSecret: 'cs_rotated' }
    await appFetch(`${GATEWAY}/b`)
    expect(counters.spawn).toBe(4)
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.url.split('/').at(-1))).toEqual(['agent-1', 'agent-2'])
  })

  it('keeps the resolver path separate from static credentials, and rejects a session path without resources', async () => {
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
    ).toThrow()

    const caracal = resolverClient(fetchImpl, () => ({ zoneId: 'zone-1', applicationId: 'app-1', clientSecret: 'cs_test' }))
    await expect(caracal.session(async () => 'unreached')).rejects.toThrow(/no resources configured/)
  })
})
