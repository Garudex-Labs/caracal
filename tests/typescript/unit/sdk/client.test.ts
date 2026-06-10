/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Caracal drop-in client tests: env loading, header injection, ingress middleware.
 */

import { describe, it, expect, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Caracal } from '../../../../packages/sdk/ts/src/index.js'
import {
  HeaderAuthorization,
  HeaderTraceparent,
  HeaderBaggage,
  BaggageAgentSession,
  BaggageSession,
  BaggageHop,
  describeAuthority,
  parseBaggage,
  parseTraceparent,
} from '../../../../packages/sdk/ts/src/advanced.js'

const baseConfig = {
  coordinator: { baseUrl: 'http://coord' },
  zoneId: 'z',
  applicationId: 'app',
  subjectToken: 'tok',
}

function resourceMap(resources: { resourceId: string; upstreamPrefix: string }[] | undefined): Record<string, string> {
  return Object.fromEntries((resources ?? []).map((binding) => [binding.resourceId, binding.upstreamPrefix]))
}

describe('Caracal.fromEnv', () => {
  it('throws on missing vars', () => {
    expect(() => Caracal.fromEnv({})).toThrow(/CARACAL_/)
  })

  it('constructs from env', () => {
    const c = Caracal.fromEnv({
      CARACAL_ZONE_ID: 'z1',
      CARACAL_APPLICATION_ID: 'a1',
      CARACAL_SUBJECT_TOKEN: 't1',
    })
    expect(c.config.zoneId).toBe('z1')
    expect(c.config.subjectToken).toBe('t1')
    expect(c.config.coordinator.baseUrl).toBe('http://localhost:4000')
    expect(c.config.gatewayUrl).toBe('http://localhost:8081')
  })

  it('constructs a client-secret token source from env', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'fresh-root', expires_in: 900 }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const c = Caracal.fromEnv({
      CARACAL_COORDINATOR_URL: 'http://coord',
      CARACAL_ZONE_ID: 'z',
      CARACAL_APPLICATION_ID: 'app',
      CARACAL_APP_CLIENT_SECRET: 'secret',
      CARACAL_STS_URL: 'http://sts',
      CARACAL_RESOURCES: 'calendar=https://api.example.com/v1,billing=https://billing.example.com',
    } as NodeJS.ProcessEnv)

    const headers = await c.headersAsync({ allowRoot: true })
    expect(headers[HeaderAuthorization]).toBe('Bearer fresh-root')
    const body = fetchMock.mock.calls[0][1].body as URLSearchParams
    expect(body.get('client_secret')).toBe('secret')
    expect(body.getAll('resource').sort()).toEqual(['billing', 'calendar'])
  })

  it('keeps credential resources when CARACAL_APP_RESOURCES is explicit', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'fresh-root', expires_in: 900 }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const c = Caracal.fromEnv({
      CARACAL_COORDINATOR_URL: 'http://coord',
      CARACAL_ZONE_ID: 'z',
      CARACAL_APPLICATION_ID: 'app',
      CARACAL_APP_CLIENT_SECRET: 'secret',
      CARACAL_STS_URL: 'http://sts',
      CARACAL_RUN_CREDENTIALS: JSON.stringify([{ resource: 'calendar', upstream_prefix: 'https://calendar.example.com' }]),
      CARACAL_APP_RESOURCES: 'billing',
    } as NodeJS.ProcessEnv)

    await c.headersAsync({ allowRoot: true })

    const body = fetchMock.mock.calls[0][1].body as URLSearchParams
    expect(body.getAll('resource').sort()).toEqual(['billing', 'calendar'])
    expect(resourceMap(c.config.resources)).toEqual({
      calendar: 'https://calendar.example.com',
    })
  })

  it('loads resource bindings from file and lets CARACAL_RESOURCES override conflicts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'caracal-sdk-'))
    const bindingsPath = join(dir, 'resources.json')
    writeFileSync(
      bindingsPath,
      JSON.stringify({
        calendar: 'https://file.example.com/v1',
        billing: 'https://billing.example.com',
      }),
      { mode: 0o600 },
    )

    const c = Caracal.fromEnv({
      CARACAL_COORDINATOR_URL: 'http://coord',
      CARACAL_ZONE_ID: 'z',
      CARACAL_APPLICATION_ID: 'app',
      CARACAL_SUBJECT_TOKEN: 'tok',
      CARACAL_RESOURCES_FILE: bindingsPath,
      CARACAL_RESOURCES: 'calendar=https://env.example.com/v2',
    } as NodeJS.ProcessEnv)

    expect(resourceMap(c.config.resources)).toEqual({
      calendar: 'https://env.example.com/v2',
      billing: 'https://billing.example.com',
    })
  })

  it('rejects malformed resource binding files at startup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'caracal-sdk-'))
    const bindingsPath = join(dir, 'resources.json')
    writeFileSync(
      bindingsPath,
      JSON.stringify([
        { resource_id: 'calendar', upstream_prefix: 'not-a-url' },
        { resource_id: 'billing', upstream_prefix: 'https://billing.example.com', extra: true },
      ]),
      { mode: 0o600 },
    )

    expect(() =>
      Caracal.fromEnv({
        CARACAL_COORDINATOR_URL: 'http://coord',
        CARACAL_ZONE_ID: 'z',
        CARACAL_APPLICATION_ID: 'app',
        CARACAL_SUBJECT_TOKEN: 'tok',
        CARACAL_RESOURCES_FILE: bindingsPath,
      } as NodeJS.ProcessEnv),
    ).toThrow(/invalid CARACAL_RESOURCES_FILE/)
  })

  it('auto-detects local client secret and credential files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'caracal-sdk-'))
    const credentialDir = join(dir, 'caracal', 'runtime', 'z', 'app')
    mkdirSync(credentialDir, { recursive: true })
    writeFileSync(join(credentialDir, 'client-secret'), 'secret\n', { mode: 0o600 })
    writeFileSync(join(credentialDir, 'credentials.json'), JSON.stringify([{ resource: 'calendar' }]), { mode: 0o600 })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'fresh-root', expires_in: 900 }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const c = Caracal.fromEnv({
      XDG_CONFIG_HOME: dir,
      CARACAL_ZONE_ID: 'z',
      CARACAL_APPLICATION_ID: 'app',
      CARACAL_STS_URL: 'http://sts',
    } as NodeJS.ProcessEnv)
    await c.headersAsync({ allowRoot: true })

    const body = fetchMock.mock.calls[0][1].body as URLSearchParams
    expect(body.get('client_secret')).toBe('secret')
    expect(body.getAll('resource')).toEqual(['calendar'])
  })

  it('auto-detects local credential files with sanitized generated directory names', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'caracal-sdk-'))
    const credentialDir = join(dir, 'caracal', 'runtime', 'zone_id', 'app_value')
    mkdirSync(credentialDir, { recursive: true })
    writeFileSync(join(credentialDir, 'client-secret'), 'secret\n', { mode: 0o600 })
    writeFileSync(join(credentialDir, 'credentials.json'), JSON.stringify([{ resource: 'calendar' }]), { mode: 0o600 })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'fresh-root', expires_in: 900 }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const c = Caracal.fromEnv({
      XDG_CONFIG_HOME: dir,
      CARACAL_ZONE_ID: '__zone id__',
      CARACAL_APPLICATION_ID: '  app/value  ',
      CARACAL_STS_URL: 'http://sts',
    } as NodeJS.ProcessEnv)
    await c.headersAsync({ allowRoot: true })

    const body = fetchMock.mock.calls[0][1].body as URLSearchParams
    expect(body.get('client_secret')).toBe('secret')
    expect(body.getAll('resource')).toEqual(['calendar'])
  })
})

describe('Caracal.headers', () => {
  it('refuses root headers without explicit opt-in', () => {
    const c = new Caracal(baseConfig)
    expect(() => c.headers()).toThrow(/allowRoot/)
  })

  it('emits W3C envelope when root use is explicit', () => {
    const c = new Caracal(baseConfig)
    const h = c.headers({ allowRoot: true })
    expect(h[HeaderAuthorization]).toBe('Bearer tok')
    expect(parseTraceparent(h[HeaderTraceparent]!)).toBeTruthy()
    expect(parseBaggage(h[HeaderBaggage])[BaggageHop]).toBe('0')
  })
})

describe('contextMiddleware + bindFromHeaders', () => {
  it('binds inbound W3C envelope and exposes claims through Caracal.current()', async () => {
    const c = new Caracal(baseConfig)
    let seen = ''
    const mw = c.contextMiddleware()
    await new Promise<void>((resolve, reject) => {
      mw(
        {
          headers: {
            [HeaderAuthorization]: 'Bearer    inbound   ',
            [HeaderTraceparent]: '00-0123456789abcdef0123456789abcdef-aabbccddeeff0011-01',
            [HeaderBaggage]: `${BaggageAgentSession}=sess1,${BaggageSession}=sid1,${BaggageHop}=2`,
          },
        },
        {},
        (err) => {
          if (err) return reject(err)
          try {
            const ctx = c.current()
            if (!ctx) throw new Error('no context bound')
            seen = `${ctx.subjectToken}|${ctx.agentSessionId}|${ctx.sessionId}|${ctx.hop}`
            resolve()
          } catch (e) {
            reject(e)
          }
        },
      )
    })
    expect(seen).toBe('inbound|sess1|sid1|2')
  })

  it('describes authority without exposing the subject token', async () => {
    const c = new Caracal(baseConfig)
    let summary = ''
    await c.bindFromHeaders(
      {
        [HeaderAuthorization]: 'Bearer inbound',
        [HeaderBaggage]: `${BaggageSession}=sid1,${BaggageAgentSession}=agent1,${BaggageHop}=1`,
      },
      async () => {
        const authority = describeAuthority()
        summary = `${authority?.applicationId}|${authority?.sessionId}|${authority?.agentSessionId}|${authority?.chain.join('>')}`
        expect(JSON.stringify(authority)).not.toContain('inbound')
      },
    )
    expect(summary).toBe('app|sid1|agent1|session:sid1>agent-session:agent1')
  })

  it('rejects inbound requests without a bearer token by default', async () => {
    const c = new Caracal(baseConfig)
    await expect(c.bindFromHeaders({}, async () => undefined)).rejects.toThrow(/missing a bearer token/)
  })
})

describe('Caracal.fromConfig', () => {
  it('loads the generated runtime profile contract', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'caracal-sdk-'))
    const secretPath = join(dir, 'secret')
    const profilePath = join(dir, 'caracal.toml')
    writeFileSync(secretPath, 'secret\n', { mode: 0o600 })
    writeFileSync(
      profilePath,
      `
zone_url = "http://sts"
coordinator_url = "http://coord"
gateway_url = "https://gateway.example.com/proxy"
zone_id = "z"
application_id = "app"
app_client_secret_file = "${secretPath}"

[[credentials]]
env = "CALENDAR_TOKEN"
resource = "calendar"

[[credentials]]
env = "BILLING_TOKEN"
resource = "billing"
upstream_prefix = "https://billing.example.com"
`,
      { mode: 0o600 },
    )
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'fresh-root', expires_in: 900 }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const c = Caracal.fromConfig(profilePath)
    await c.headersAsync({ allowRoot: true })

    const body = fetchMock.mock.calls[0][1].body as URLSearchParams
    expect(body.get('client_secret')).toBe('secret')
    expect(body.getAll('resource').sort()).toEqual(['billing', 'calendar'])
  })

  it('loads resource bindings file and env overrides with generated profiles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'caracal-sdk-'))
    const secretPath = join(dir, 'secret')
    const profilePath = join(dir, 'caracal.toml')
    const bindingsPath = join(dir, 'resources.json')
    writeFileSync(secretPath, 'secret\n', { mode: 0o600 })
    writeFileSync(
      bindingsPath,
      JSON.stringify([
        { resource_id: 'calendar', upstream_prefix: 'https://file.example.com/v1' },
        { resource_id: 'billing', upstream_prefix: 'https://billing.example.com' },
      ]),
      { mode: 0o600 },
    )
    writeFileSync(
      profilePath,
      `
zone_url = "http://sts"
coordinator_url = "http://coord"
zone_id = "z"
application_id = "app"
app_client_secret_file = "${secretPath}"
`,
      { mode: 0o600 },
    )
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'fresh-root', expires_in: 900 }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const c = Caracal.fromConfig(profilePath, {
      CARACAL_RESOURCES_FILE: bindingsPath,
      CARACAL_RESOURCES: 'calendar=https://env.example.com/v2',
    } as NodeJS.ProcessEnv)
    await c.headersAsync({ allowRoot: true })

    const body = fetchMock.mock.calls[0][1].body as URLSearchParams
    expect(body.getAll('resource').sort()).toEqual(['billing', 'calendar'])
    expect(resourceMap(c.config.resources)).toEqual({
      calendar: 'https://env.example.com/v2',
      billing: 'https://billing.example.com',
    })
  })

  it('loads the default generated profile before env fallback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'caracal-sdk-'))
    const configDir = join(dir, 'caracal')
    mkdirSync(configDir)
    const secretPath = join(dir, 'secret')
    writeFileSync(secretPath, 'secret\n', { mode: 0o600 })
    writeFileSync(
      join(configDir, 'caracal.toml'),
      `
zone_id = "z"
application_id = "app"
app_client_secret_file = "${secretPath}"

[[credentials]]
resource = "calendar"
`,
      { mode: 0o600 },
    )

    const c = new Caracal({
      env: {
        XDG_CONFIG_HOME: dir,
        CARACAL_COORDINATOR_URL: 'http://ignored',
        CARACAL_ZONE_ID: 'ignored',
        CARACAL_APPLICATION_ID: 'ignored',
        CARACAL_SUBJECT_TOKEN: 'ignored',
      } as NodeJS.ProcessEnv,
    })

    expect(c.config.zoneId).toBe('z')
    expect(c.config.applicationId).toBe('app')
  })
})

describe('caracal.transport', () => {
  it('refuses root transport without explicit opt-in', async () => {
    const c = new Caracal(baseConfig)
    await expect(c.transport()('http://api/x')).rejects.toThrow(/allowRoot/)
  })

  it('auto-injects envelope headers on outbound calls', async () => {
    const calls: { url: string; headers: Headers }[] = []
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), headers: new Headers(init.headers) })
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const c = new Caracal({ ...baseConfig, coordinator: { baseUrl: 'http://c', fetchImpl: fakeFetch } })
    await c.transport({ allowRoot: true })('http://api/x')
    expect(calls).toHaveLength(1)
    expect(calls[0].headers.get(HeaderAuthorization)).toBe('Bearer tok')
    expect(parseTraceparent(calls[0].headers.get(HeaderTraceparent)!)).toBeTruthy()
  })

  it('routes bound provider calls through the configured gateway', async () => {
    const calls: { url: string; headers: Headers }[] = []
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), headers: new Headers(init.headers) })
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const c = new Caracal({
      ...baseConfig,
      coordinator: { baseUrl: 'http://c', fetchImpl: fakeFetch },
      gatewayUrl: 'https://gateway.example.com/proxy',
      resources: [{ resourceId: 'calendar', upstreamPrefix: 'https://api.example.com/v1' }],
    })

    await c.transport({ allowRoot: true })('https://api.example.com/v1/events?limit=10', {
      headers: { 'x-existing': '1' },
    })

    expect(calls[0].url).toBe('https://gateway.example.com/proxy/events?limit=10')
    expect(calls[0].headers.get('X-Caracal-Resource')).toBe('calendar')
    expect(calls[0].headers.get('Authorization')).toBe('Bearer tok')
    expect(calls[0].headers.get('x-existing')).toBe('1')
  })

  it('uses explicit resources for gateway calls without a matching binding', async () => {
    const calls: { url: string; headers: Headers }[] = []
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), headers: new Headers(init.headers) })
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const c = new Caracal({
      ...baseConfig,
      coordinator: { baseUrl: 'http://c', fetchImpl: fakeFetch },
      gatewayUrl: 'https://gateway.example.com/proxy',
    })

    await c.transport({ allowRoot: true })('https://unbound.example.com/data', {
      headers: { 'X-Caracal-Resource': 'manual-resource' },
    })

    expect(calls[0].url).toBe('https://gateway.example.com/proxy/data')
    expect(calls[0].headers.get('X-Caracal-Resource')).toBe('manual-resource')
  })

  it('builds explicit Gateway request targets without requiring upstream bindings', async () => {
    const calls: { url: string; headers: Headers }[] = []
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), headers: new Headers(init.headers) })
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const c = new Caracal({
      ...baseConfig,
      coordinator: { baseUrl: 'http://c', fetchImpl: fakeFetch },
      gatewayUrl: 'https://gateway.example.com/proxy',
    })
    const request = c.gatewayRequest('resource://calendar', 'events?limit=10')

    await c.transport({ allowRoot: true })(request.url, { headers: request.headers })

    expect(calls[0].url).toBe('https://gateway.example.com/proxy/events?limit=10')
    expect(calls[0].headers.get('X-Caracal-Resource')).toBe('resource://calendar')
    expect(calls[0].headers.get('Authorization')).toBe('Bearer tok')
  })

  it('fetch composes gatewayRequest and transport in one call', async () => {
    const calls: { url: string; method?: string; headers: Headers }[] = []
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), method: init.method, headers: new Headers(init.headers) })
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const c = new Caracal({
      ...baseConfig,
      coordinator: { baseUrl: 'http://c', fetchImpl: fakeFetch },
      gatewayUrl: 'https://gateway.example.com/proxy',
    })

    await c.fetch(
      'resource://calendar',
      'events?limit=10',
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      { allowRoot: true },
    )

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://gateway.example.com/proxy/events?limit=10')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].headers.get('X-Caracal-Resource')).toBe('resource://calendar')
    expect(calls[0].headers.get('Authorization')).toBe('Bearer tok')
    expect(calls[0].headers.get('content-type')).toBe('application/json')
  })

  it('rejects invalid Gateway helper inputs', () => {
    const c = new Caracal({ ...baseConfig, gatewayUrl: 'https://gateway.example.com/proxy' })
    expect(() => new Caracal(baseConfig).gatewayRequest('resource://calendar', '/events')).toThrow(/gatewayUrl/)
    expect(() => c.gatewayRequest('', '/events')).toThrow(/resourceId/)
    expect(() => c.gatewayRequest('resource://calendar', 'https://api.example.com/events')).toThrow(/relative/)
  })
})

describe('agent lifecycle and delegation', () => {
  it('fires lifecycle hooks, binds context, delegates, and terminates non-service agents', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), init })
      if (init.method === 'POST' && String(input).endsWith('/agents')) {
        return new Response(JSON.stringify({ agent_session_id: 'agent-1' }), { status: 200 })
      }
      if (init.method === 'POST' && String(input).endsWith('/delegations')) {
        return new Response(JSON.stringify({ delegation_edge_id: 'edge-1' }), { status: 200 })
      }
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const c = new Caracal({
      ...baseConfig,
      coordinator: { baseUrl: 'https://coordinator.example.com', fetchImpl: fakeFetch },
      defaultTtlSeconds: 60,
    })
    const events: string[] = []
    c.onAgentStart((ctx) => {
      events.push(`start:${ctx.agentSessionId}`)
    })
    c.onAgentEnd((ctx) => {
      events.push(`end:${ctx.agentSessionId}`)
    })

    await c.spawn(
      async () => {
        expect(c.current()?.agentSessionId).toBe('agent-1')
        await c.delegate(
          {
            to: 'agent-2',
            toApplicationId: 'app-2',
            scopes: ['tool:call'],
            ttlSeconds: 30,
          },
          async () => {
            expect(c.current()?.delegationEdgeId).toBe('edge-1')
            expect(c.current()?.hop).toBe(1)
          },
        )
      },
      { metadata: { purpose: 'test' }, labels: ['refunds.execute', 'ledger.read'] },
    )

    expect(events).toEqual(['start:agent-1', 'end:agent-1'])
    expect(calls.map((call) => [call.init.method, call.url])).toEqual([
      ['POST', 'https://coordinator.example.com/zones/z/agents'],
      ['POST', 'https://coordinator.example.com/zones/z/delegations'],
      ['DELETE', 'https://coordinator.example.com/zones/z/agents/agent-1'],
    ])
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      application_id: 'app',
      ttl_seconds: 60,
      metadata: { purpose: 'test' },
      labels: ['refunds.execute', 'ledger.read'],
    })
    expect(JSON.parse(String(calls[1].init.body))).toMatchObject({
      source_session_id: 'agent-1',
      target_session_id: 'agent-2',
      receiver_application_id: 'app-2',
      scopes: ['tool:call'],
      ttl_seconds: 30,
    })
  })

  it('starts a service agent that heartbeats and is not auto-terminated', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), init })
      if (init.method === 'POST' && String(input).endsWith('/agents')) {
        return new Response(JSON.stringify({ agent_session_id: 'svc-1' }), { status: 200 })
      }
      if (init.method === 'POST' && String(input).endsWith('/heartbeat')) {
        return new Response(JSON.stringify({ agent: { id: 'svc-1' } }), { status: 200 })
      }
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const c = new Caracal({
      ...baseConfig,
      coordinator: { baseUrl: 'https://coordinator.example.com', fetchImpl: fakeFetch },
    })

    const svc = await c.spawnService({ labels: ['billing-worker'] })
    expect(svc.agentSessionId).toBe('svc-1')
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      application_id: 'app',
      lifecycle: 'service',
      labels: ['billing-worker'],
    })

    await svc.heartbeat()
    await svc.close()
    expect(calls.map((call) => [call.init.method, call.url])).toEqual([
      ['POST', 'https://coordinator.example.com/zones/z/agents'],
      ['POST', 'https://coordinator.example.com/zones/z/agents/svc-1/heartbeat'],
      ['DELETE', 'https://coordinator.example.com/zones/z/agents/svc-1'],
    ])
  })

  it('derives a stable Idempotency-Key on spawn when subjectSessionId or parentId is present', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), init })
      if (init.method === 'POST' && String(input).endsWith('/agents')) {
        return new Response(JSON.stringify({ agent_session_id: 'agent-1' }), { status: 200 })
      }
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const c = new Caracal({
      ...baseConfig,
      coordinator: { baseUrl: 'https://coordinator.example.com', fetchImpl: fakeFetch },
    })
    await c.spawn(
      async () => {
        return
      },
      { subjectSessionId: 'sid-1', parentId: 'parent-1' },
    )
    await c.spawn(
      async () => {
        return
      },
      { subjectSessionId: 'sid-1', parentId: 'parent-1' },
    )
    const agentPosts = calls.filter((call) => call.init.method === 'POST' && call.url.endsWith('/agents'))
    expect(agentPosts.length).toBeGreaterThanOrEqual(2)
    const key1 = new Headers(agentPosts[0].init.headers as HeadersInit).get('idempotency-key')
    const key2 = new Headers(agentPosts[1].init.headers as HeadersInit).get('idempotency-key')
    expect(key1).toBeTruthy()
    expect(key2).toBeTruthy()
    expect(key1!.length).toBe(64)
    expect(key2!.length).toBe(64)
    expect(key1).toBe(key2)
  })
})

describe('config resource sorting and token validation', () => {
  it('sorts bindings longest-prefix-first', () => {
    const c = new Caracal({
      ...baseConfig,
      resources: [
        { resourceId: 'short', upstreamPrefix: 'https://api.example.com/v1' },
        { resourceId: 'long', upstreamPrefix: 'https://api.example.com/v1/accounts/treasury' },
        { resourceId: 'mid', upstreamPrefix: 'https://api.example.com/v1/accounts' },
      ],
    })
    expect(c.config.resources?.map((b) => b.resourceId)).toEqual(['long', 'mid', 'short'])
  })

  it('rejects expired bootstrap JWT in fromEnv', () => {
    const header = Buffer.from('{"alg":"ES256"}').toString('base64url')
    const payload = Buffer.from(JSON.stringify({ exp: 1_000_000 })).toString('base64url')
    const token = `${header}.${payload}.sig`
    expect(() =>
      Caracal.fromEnv({
        CARACAL_COORDINATOR_URL: 'http://coord',
        CARACAL_ZONE_ID: 'z',
        CARACAL_APPLICATION_ID: 'app',
        CARACAL_SUBJECT_TOKEN: token,
      } as NodeJS.ProcessEnv),
    ).toThrow(/expired/)
  })

  it('rejects malformed CARACAL_RESOURCES at startup', () => {
    expect(() =>
      Caracal.fromEnv({
        CARACAL_COORDINATOR_URL: 'http://coord',
        CARACAL_ZONE_ID: 'z',
        CARACAL_APPLICATION_ID: 'app',
        CARACAL_SUBJECT_TOKEN: 'tok',
        CARACAL_RESOURCES: 'broken,calendar=not-a-url',
      } as NodeJS.ProcessEnv),
    ).toThrow(/invalid CARACAL_RESOURCES/)
  })
})

describe('Caracal.fromClientSecret', () => {
  it('uses custom fetchImpl for token exchanges', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ access_token: 'custom-fetch-token', expires_in: 900 }),
    })

    const c = Caracal.fromClientSecret({
      coordinatorUrl: 'http://coord',
      stsUrl: 'http://sts',
      zoneId: 'z',
      applicationId: 'app',
      clientSecret: 'secret',
      resources: ['calendar'],
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    const headers = await c.headersAsync({ allowRoot: true })
    expect(headers[HeaderAuthorization]).toBe('Bearer custom-fetch-token')
    expect(fetchMock).toHaveBeenCalled()
    const body = fetchMock.mock.calls[0][1]!.body as URLSearchParams
    expect(body.get('client_secret')).toBe('secret')
  })
})
