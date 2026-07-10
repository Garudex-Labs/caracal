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
import {
  Caracal,
  ApprovalRequiredError,
  CaracalError,
  isApprovalRequired,
  type CaracalEvent,
} from '../../../../packages/sdk/ts/src/index.js'
import {
  HeaderAuthorization,
  HeaderTraceparent,
  HeaderBaggage,
  BaggageAgentSession,
  BaggageSession,
  BaggageHop,
  createAdvancedClientFromConfig,
  createAdvancedClientFromEnv,
  describeAuthority,
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

describe('advanced environment loading', () => {
  it('throws on missing vars', () => {
    expect(() => createAdvancedClientFromEnv({})).toThrow(/CARACAL_/)
  })

  it('constructs from env', () => {
    const c = createAdvancedClientFromEnv({
      CARACAL_ZONE_ID: 'z1',
      CARACAL_APPLICATION_ID: 'a1',
      CARACAL_BOOTSTRAP_TOKEN: 't1',
    })
    expect(c.config.zoneId).toBe('z1')
    expect(c.config.subjectToken).toBe('t1')
    expect(c.config.coordinator.baseUrl).toBe('http://localhost:4000')
    expect(c.config.gatewayUrl).toBe('http://localhost:8081')
  })

  it('restricts production http URLs to loopback hosts or the explicit override', () => {
    const base = {
      CARACAL_ENV: 'production',
      CARACAL_ZONE_ID: 'z1',
      CARACAL_APPLICATION_ID: 'a1',
      CARACAL_BOOTSTRAP_TOKEN: 't1',
      CARACAL_STS_URL: 'https://sts.internal',
      CARACAL_GATEWAY_URL: 'https://gateway.internal',
    }
    expect(() =>
      createAdvancedClientFromEnv({ ...base, CARACAL_COORDINATOR_URL: 'http://coordinator.internal:4000' } as NodeJS.ProcessEnv),
    ).toThrow(/CARACAL_COORDINATOR_URL must use https/)
    expect(() =>
      createAdvancedClientFromEnv({ ...base, CARACAL_COORDINATOR_URL: 'http://127.0.0.1:4000' } as NodeJS.ProcessEnv),
    ).not.toThrow()
    expect(() =>
      createAdvancedClientFromEnv({
        ...base,
        CARACAL_COORDINATOR_URL: 'http://coordinator.internal:4000',
        CARACAL_ALLOW_INSECURE_CONFIG_URLS: 'true',
      } as NodeJS.ProcessEnv),
    ).not.toThrow()
  })

  it('enforces https for the sts url in production client-secret mode', () => {
    expect(() =>
      createAdvancedClientFromEnv({
        CARACAL_ENV: 'production',
        CARACAL_COORDINATOR_URL: 'https://coordinator.internal',
        CARACAL_GATEWAY_URL: 'https://gateway.internal',
        CARACAL_ZONE_ID: 'z',
        CARACAL_APPLICATION_ID: 'app',
        CARACAL_APP_CLIENT_SECRET: 'secret',
        CARACAL_STS_URL: 'http://sts.internal:8080',
        CARACAL_RESOURCES: 'calendar=https://api.example.com/v1',
      } as NodeJS.ProcessEnv),
    ).toThrow(/stsUrl must use https/)
  })

  it('constructs a client-secret token source from env', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'fresh-root', expires_in: 900 }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const c = createAdvancedClientFromEnv({
      CARACAL_COORDINATOR_URL: 'http://coord',
      CARACAL_ZONE_ID: 'z',
      CARACAL_APPLICATION_ID: 'app',
      CARACAL_APP_CLIENT_SECRET: 'secret',
      CARACAL_STS_URL: 'http://sts',
      CARACAL_RESOURCES: 'calendar=https://api.example.com/v1,billing=https://billing.example.com',
    } as NodeJS.ProcessEnv)

    const headers = await c.headersAsync({ asApplication: true })
    expect(headers[HeaderAuthorization]).toBe('Bearer fresh-root')
    const body = fetchMock.mock.calls[0][1].body as URLSearchParams
    expect(body.get('client_secret')).toBe('secret')
    expect(body.getAll('resource').sort()).toEqual(['billing', 'calendar'])
  })

  it('combines application audiences with resource bindings', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'fresh-root', expires_in: 900 }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const c = createAdvancedClientFromEnv({
      CARACAL_COORDINATOR_URL: 'http://coord',
      CARACAL_ZONE_ID: 'z',
      CARACAL_APPLICATION_ID: 'app',
      CARACAL_APP_CLIENT_SECRET: 'secret',
      CARACAL_STS_URL: 'http://sts',
      CARACAL_APP_RESOURCES: 'billing',
      CARACAL_RESOURCES: 'calendar=https://calendar.example.com',
    } as NodeJS.ProcessEnv)

    await c.headersAsync({ asApplication: true })

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

    const c = createAdvancedClientFromEnv({
      CARACAL_COORDINATOR_URL: 'http://coord',
      CARACAL_ZONE_ID: 'z',
      CARACAL_APPLICATION_ID: 'app',
      CARACAL_BOOTSTRAP_TOKEN: 'tok',
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
      createAdvancedClientFromEnv({
        CARACAL_COORDINATOR_URL: 'http://coord',
        CARACAL_ZONE_ID: 'z',
        CARACAL_APPLICATION_ID: 'app',
        CARACAL_BOOTSTRAP_TOKEN: 'tok',
        CARACAL_RESOURCES_FILE: bindingsPath,
      } as NodeJS.ProcessEnv),
    ).toThrow(/invalid CARACAL_RESOURCES_FILE/)
  })

  it('does not inspect implicit local credential files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'caracal-sdk-'))
    const credentialDir = join(dir, 'caracal', 'runtime', 'z', 'app')
    mkdirSync(credentialDir, { recursive: true })
    writeFileSync(join(credentialDir, 'client-secret'), 'secret\n', { mode: 0o600 })
    writeFileSync(join(credentialDir, 'credentials.json'), JSON.stringify([{ resource: 'calendar' }]), { mode: 0o600 })
    expect(() =>
      createAdvancedClientFromEnv({
        XDG_CONFIG_HOME: dir,
        CARACAL_ZONE_ID: 'z',
        CARACAL_APPLICATION_ID: 'app',
        CARACAL_STS_URL: 'http://sts',
      } as NodeJS.ProcessEnv),
    ).toThrow(/provide CARACAL_APP_CLIENT_SECRET or CARACAL_BOOTSTRAP_TOKEN/)
  })

  it('rejects conflicting credential modes', () => {
    expect(() =>
      createAdvancedClientFromEnv({
        CARACAL_ZONE_ID: 'z',
        CARACAL_APPLICATION_ID: 'app',
        CARACAL_APP_CLIENT_SECRET: 'secret',
        CARACAL_BOOTSTRAP_TOKEN: 'token',
        CARACAL_RESOURCES: 'calendar=https://calendar.example.com',
      } as NodeJS.ProcessEnv),
    ).toThrow(/exactly one/)
  })
})

describe('Caracal.headers', () => {
  it('refuses application-identity headers without explicit opt-in', () => {
    const c = new Caracal(baseConfig)
    expect(() => c.headers()).toThrow(/asApplication/)
  })

  it('emits W3C envelope when application identity is explicit', () => {
    const c = new Caracal(baseConfig)
    const h = c.headers({ asApplication: true })
    expect(h[HeaderAuthorization]).toBe('Bearer tok')
    expect(parseTraceparent(h[HeaderTraceparent]!)).toBeTruthy()
    expect(h[HeaderBaggage]).toBeUndefined()
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
        { statusCode: 200, setHeader: () => undefined, end: () => undefined },
        (err) => {
          if (err) return reject(err)
          try {
            const ctx = c.current()
            if (!ctx) throw new Error('no context bound')
            seen = `${ctx.subjectToken}|${ctx.sessionId}|${ctx.subjectAuthorityRecordId}|${ctx.hop}`
            resolve()
          } catch (e) {
            reject(e)
          }
        },
      )
    })
    expect(seen).toBe('inbound|sess1|sid1|2')
  })

  it('answers boundary failures with 401 instead of invoking next', async () => {
    const c = new Caracal(baseConfig)
    const next = vi.fn()
    let status = 0
    let body = ''
    const headers: Array<[string, string]> = []
    const mw = c.contextMiddleware()
    mw(
      { headers: {} },
      {
        get statusCode() {
          return status
        },
        set statusCode(value: number) {
          status = value
        },
        setHeader: (name: string, value: string) => void headers.push([name, value]),
        end: (payload?: string) => void (body = payload ?? ''),
      },
      next,
    )
    await vi.waitFor(() => expect(body).not.toBe(''))
    expect(next).not.toHaveBeenCalled()
    expect(status).toBe(401)
    expect(headers).toEqual([['content-type', 'application/json']])
    expect(body).toContain('"error":"unauthorized"')
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
        summary = `${authority?.applicationId}|${authority?.subjectAuthorityRecordId}|${authority?.sessionId}|${authority?.chain.join('>')}`
        expect(JSON.stringify(authority)).not.toContain('inbound')
      },
    )
    expect(summary).toBe('app|sid1|agent1|subject:sid1>session:agent1')
  })

  it('rejects inbound requests without a bearer token by default', async () => {
    const c = new Caracal(baseConfig)
    await expect(c.bindFromHeaders({}, async () => undefined)).rejects.toThrow(/missing a bearer token/)
  })

  it('binds directly from a fetch Headers instance', async () => {
    const c = new Caracal(baseConfig)
    const headers = new Headers({
      [HeaderAuthorization]: 'Bearer inbound',
      [HeaderBaggage]: `${BaggageAgentSession}=agent1,${BaggageHop}=1`,
    })
    let seen = ''
    await c.bindFromHeaders(headers, async () => {
      const ctx = c.current()!
      seen = `${ctx.subjectToken}|${ctx.sessionId}|${ctx.hop}`
    })
    expect(seen).toBe('inbound|agent1|1')
  })

  it('runs the verify hook against the inbound token before binding', async () => {
    const c = new Caracal(baseConfig)
    const seen: string[] = []
    await c.bindFromHeaders({ [HeaderAuthorization]: 'Bearer inbound' }, async () => undefined, {
      verify: (token) => void seen.push(token),
    })
    expect(seen).toEqual(['inbound'])

    await expect(
      c.bindFromHeaders({ [HeaderAuthorization]: 'Bearer inbound' }, async () => undefined, {
        verify: () => {
          throw new Error('revoked')
        },
      }),
    ).rejects.toThrow(/revoked/)
  })

  it('stamps verified claims over the caller-supplied envelope', async () => {
    const c = new Caracal(baseConfig)
    let seen = ''
    await c.bindFromHeaders(
      {
        [HeaderAuthorization]: 'Bearer inbound',
        [HeaderBaggage]: `${BaggageAgentSession}=forged,${BaggageSession}=forged-sid,${BaggageHop}=9`,
      },
      async () => {
        const ctx = c.current()!
        seen = `${ctx.zoneId}|${ctx.applicationId}|${ctx.sessionId}|${ctx.subjectAuthorityRecordId}|${ctx.hop}`
      },
      {
        verify: () => ({
          zoneId: 'zone-proved',
          applicationId: 'app-proved',
          sessionId: 'agent-proved',
          subjectAuthorityRecordId: 'sid-proved',
          hop: 3,
        }),
      },
    )
    expect(seen).toBe('zone-proved|app-proved|agent-proved|sid-proved|3')
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
sts_url = "http://sts"
coordinator_url = "http://coord"
gateway_url = "https://gateway.example.com/proxy"
zone_id = "z"
application_id = "app"
app_client_secret_file = ${JSON.stringify(secretPath)}

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

    const c = createAdvancedClientFromConfig(profilePath)
    await c.headersAsync({ asApplication: true })

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
sts_url = "http://sts"
coordinator_url = "http://coord"
zone_id = "z"
application_id = "app"
app_client_secret_file = ${JSON.stringify(secretPath)}
`,
      { mode: 0o600 },
    )
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'fresh-root', expires_in: 900 }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const c = createAdvancedClientFromConfig(profilePath, {
      CARACAL_RESOURCES_FILE: bindingsPath,
      CARACAL_RESOURCES: 'calendar=https://env.example.com/v2',
    } as NodeJS.ProcessEnv)
    await c.headersAsync({ asApplication: true })

    const body = fetchMock.mock.calls[0][1].body as URLSearchParams
    expect(body.getAll('resource').sort()).toEqual(['billing', 'calendar'])
    expect(resourceMap(c.config.resources)).toEqual({
      calendar: 'https://env.example.com/v2',
      billing: 'https://billing.example.com',
    })
  })

  it('does not load a default generated profile', () => {
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
app_client_secret_file = ${JSON.stringify(secretPath)}

[[credentials]]
resource = "calendar"
`,
      { mode: 0o600 },
    )

    const c = createAdvancedClientFromEnv({
      XDG_CONFIG_HOME: dir,
      CARACAL_COORDINATOR_URL: 'http://env',
      CARACAL_ZONE_ID: 'env-zone',
      CARACAL_APPLICATION_ID: 'env-app',
      CARACAL_BOOTSTRAP_TOKEN: 'env-token',
    } as NodeJS.ProcessEnv)

    expect(c.config.zoneId).toBe('env-zone')
    expect(c.config.applicationId).toBe('env-app')
  })
})

describe('caracal.transport', () => {
  it('refuses application-identity transport without explicit opt-in', async () => {
    const c = new Caracal(baseConfig)
    await expect(c.transport()('http://api/x')).rejects.toThrow(/asApplication/)
  })

  it('auto-injects envelope headers on outbound calls', async () => {
    const calls: { url: string; headers: Headers }[] = []
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), headers: new Headers(init.headers) })
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const c = new Caracal({ ...baseConfig, coordinator: { baseUrl: 'http://c', fetchImpl: fakeFetch } })
    await c.transport({ asApplication: true })('http://api/x')
    expect(calls).toHaveLength(1)
    expect(calls[0].headers.get(HeaderAuthorization)).toBeNull()
    expect(parseTraceparent(calls[0].headers.get(HeaderTraceparent)!)).toBeTruthy()
  })

  it('bounds calls with the transport-level timeout', async () => {
    const signals: (AbortSignal | null | undefined)[] = []
    const fakeFetch = vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      signals.push(init.signal)
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const c = new Caracal({ ...baseConfig, coordinator: { baseUrl: 'http://c', fetchImpl: fakeFetch } })
    await c.transport({ asApplication: true })('http://api/x')
    await c.transport({ asApplication: true, timeoutMs: 5000 })('http://api/x')
    expect(signals[0]).toBeUndefined()
    expect(signals[1]).toBeInstanceOf(AbortSignal)
  })

  it('preserves Request method, headers, body, and signal while rewriting', async () => {
    const calls: Request[] = []
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(input instanceof Request ? input : new Request(input, init))
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const c = new Caracal({
      ...baseConfig,
      coordinator: { baseUrl: 'http://c', fetchImpl: fakeFetch },
      gatewayUrl: 'https://gateway.example.com/proxy',
      resources: [{ resourceId: 'calendar', upstreamPrefix: 'https://api.example.com/v1' }],
    })
    const controller = new AbortController()
    const request = new Request('https://api.example.com/v1/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-existing': '1' },
      body: '{"event":"PiperNet launch"}',
      signal: controller.signal,
    })

    await c.transport({ asApplication: true, timeoutMs: 5000 })(request)

    expect(calls[0].url).toBe('https://gateway.example.com/proxy/events')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].headers.get('x-existing')).toBe('1')
    expect(await calls[0].text()).toBe('{"event":"PiperNet launch"}')
    expect(calls[0].signal).toBeInstanceOf(AbortSignal)
  })

  it('keeps envelope headers off non-gateway hosts under gateway-only propagation', async () => {
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
    const send = c.transport({ asApplication: true, propagation: 'gateway-only' })
    await send('https://third-party.example.com/data')
    await send('https://api.example.com/v1/events')
    expect(calls[0].headers.get(HeaderTraceparent)).toBeNull()
    expect(calls[0].headers.get(HeaderBaggage)).toBeNull()
    expect(calls[1].url).toBe('https://gateway.example.com/proxy/events')
    expect(parseTraceparent(calls[1].headers.get(HeaderTraceparent)!)).toBeTruthy()
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

    await c.transport({ asApplication: true })('https://api.example.com/v1/events?limit=10', {
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

    await c.transport({ asApplication: true })('https://unbound.example.com/data', {
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

    await c.transport({ asApplication: true })(request.url, { headers: request.headers })

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

    await c.fetch('resource://calendar', 'events?limit=10', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      asApplication: true,
    })

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
    expect(() => c.gatewayRequest('resource://calendar', '/events/../admin')).toThrow(/dot segments/)
    expect(() => c.gatewayRequest('resource://calendar', './events')).toThrow(/dot segments/)
  })
})

describe('session lifecycle and delegation', () => {
  it('fires lifecycle hooks, binds context, delegates, and terminates task sessions', async () => {
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
    c.onSessionStart((ctx) => {
      events.push(`start:${ctx.sessionId}`)
    })
    c.onSessionEnd((ctx) => {
      events.push(`end:${ctx.sessionId}`)
    })

    await c.session(
      async () => {
        expect(c.current()?.sessionId).toBe('agent-1')
        const delegation = await c.delegate({
          toSessionId: 'agent-2',
          toApplicationId: 'app-2',
          scopes: ['tool:call'],
          ttlSeconds: 30,
        })
        expect(delegation.delegationId).toBe('edge-1')
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

  it('starts a long-lived session that heartbeats and is not auto-terminated', async () => {
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

    const svc = await c.startSession({ labels: ['billing-worker'] })
    expect(svc.sessionId).toBe('svc-1')
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

  it('sends a distinct Idempotency-Key per session so retries cannot mint duplicates', async () => {
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
    await c.session(
      async () => {
        return
      },
      { subjectAuthorityRecordId: 'sid-1', parentSessionId: 'parent-1' },
    )
    await c.session(
      async () => {
        return
      },
      { subjectAuthorityRecordId: 'sid-1', parentSessionId: 'parent-1' },
    )
    const agentPosts = calls.filter((call) => call.init.method === 'POST' && call.url.endsWith('/agents'))
    expect(agentPosts.length).toBeGreaterThanOrEqual(2)
    const keys = agentPosts.map((post) => new Headers(post.init.headers as HeadersInit).get('idempotency-key'))
    for (const key of keys) {
      expect(key).toMatch(/[0-9a-f-]{32,}/)
    }
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('records the task option as metadata.task, winning over a metadata task', async () => {
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
    await c.session(
      async () => {
        return
      },
      { task: 'Refund order #8412', metadata: { task: 'stale', ticket: 'T-1' } },
    )
    const svc = await c.startSession({ task: 'Nightly PiperNet reconciliation' })
    await svc.close()
    const agentPosts = calls.filter((call) => call.init.method === 'POST' && call.url.endsWith('/agents'))
    expect(JSON.parse(String(agentPosts[0].init.body)).metadata).toEqual({ task: 'Refund order #8412', ticket: 'T-1' })
    expect(JSON.parse(String(agentPosts[1].init.body)).metadata).toEqual({ task: 'Nightly PiperNet reconciliation' })
  })

  it('reuses a caller-supplied operation id across separate creation calls', async () => {
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
    const work = async () => {
      return
    }
    await c.session(work, { idempotencyKey: 'queue-msg-77' })
    await c.session(work, { idempotencyKey: 'queue-msg-77' })
    const keys = calls
      .filter((call) => call.init.method === 'POST' && call.url.endsWith('/agents'))
      .map((post) => new Headers(post.init.headers as HeadersInit).get('idempotency-key'))
    expect(keys).toEqual(['queue-msg-77', 'queue-msg-77'])
  })

  it.each(['', ' key', 'key ', 'key\nvalue', 'x'.repeat(256)])(
    'rejects an unsafe explicit idempotency key before network I/O',
    async (key) => {
      const fakeFetch = vi.fn() as unknown as typeof fetch
      const c = new Caracal({
        ...baseConfig,
        coordinator: { baseUrl: 'https://coordinator.example.com', fetchImpl: fakeFetch },
      })
      await expect(c.session(async () => undefined, { idempotencyKey: key })).rejects.toThrow(/idempotencyKey must be/)
      expect(fakeFetch).not.toHaveBeenCalled()
    },
  )

  it('forwards coordinator and token exchange events to onEvent hooks', async () => {
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (init.method === 'POST' && String(input).endsWith('/agents')) {
        return new Response(JSON.stringify({ agent_session_id: 'agent-1' }), { status: 200 })
      }
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const stsFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'fresh-root', expires_in: 900 }),
    })
    vi.stubGlobal('fetch', stsFetch)
    const secretSource = createAdvancedClientFromEnv({
      CARACAL_COORDINATOR_URL: 'http://coord',
      CARACAL_STS_URL: 'http://sts',
      CARACAL_ZONE_ID: 'z1',
      CARACAL_APPLICATION_ID: 'a1',
      CARACAL_APP_CLIENT_SECRET: 'shh',
      CARACAL_RESOURCES: 'calendar=https://calendar.example.com',
    })
    const c = new Caracal({
      ...baseConfig,
      coordinator: { baseUrl: 'https://coordinator.example.com', fetchImpl: fakeFetch },
    })
    const events: CaracalEvent[] = []
    const secretEvents: CaracalEvent[] = []
    c.onEvent((event) => events.push(event))
    c.onEvent(() => {
      throw new Error('sink failure')
    })
    secretSource.onEvent((event) => secretEvents.push(event))

    await c.session(async () => undefined)
    await secretSource.headersAsync({ asApplication: true })

    expect(events.map((event) => event.type)).toEqual(['coordinator.call', 'coordinator.call'])
    expect(events[0]).toMatchObject({ type: 'coordinator.call', method: 'POST', ok: true })
    expect(events[1]).toMatchObject({ type: 'coordinator.call', method: 'DELETE', ok: true })
    expect(secretEvents.map((event) => event.type)).toEqual(['token.exchange'])
    expect(secretEvents[0]).toMatchObject({ type: 'token.exchange', ok: true, cached: false })
  })

  it('stops delivering events after the onEvent disposer runs', async () => {
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (init.method === 'POST' && String(input).endsWith('/agents')) {
        return new Response(JSON.stringify({ agent_session_id: 'agent-1' }), { status: 200 })
      }
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const c = new Caracal({ ...baseConfig, coordinator: { baseUrl: 'https://coordinator.example.com', fetchImpl: fakeFetch } })
    const events: CaracalEvent[] = []
    const dispose = c.onEvent((event) => events.push(event))
    await c.session(async () => undefined)
    const delivered = events.length
    expect(delivered).toBeGreaterThan(0)
    dispose()
    await c.session(async () => undefined)
    expect(events).toHaveLength(delivered)
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
      createAdvancedClientFromEnv({
        CARACAL_COORDINATOR_URL: 'http://coord',
        CARACAL_ZONE_ID: 'z',
        CARACAL_APPLICATION_ID: 'app',
        CARACAL_BOOTSTRAP_TOKEN: token,
      } as NodeJS.ProcessEnv),
    ).toThrow(/expired/)
  })

  it('rejects alg none bootstrap JWT in fromEnv', () => {
    const header = Buffer.from('{"alg":"none"}').toString('base64url')
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')
    const token = `${header}.${payload}.`
    expect(() =>
      createAdvancedClientFromEnv({
        CARACAL_COORDINATOR_URL: 'http://coord',
        CARACAL_ZONE_ID: 'z',
        CARACAL_APPLICATION_ID: 'app',
        CARACAL_BOOTSTRAP_TOKEN: token,
      } as NodeJS.ProcessEnv),
    ).toThrow(/alg "none"/)
  })

  it('rejects malformed CARACAL_RESOURCES at startup', () => {
    expect(() =>
      createAdvancedClientFromEnv({
        CARACAL_COORDINATOR_URL: 'http://coord',
        CARACAL_ZONE_ID: 'z',
        CARACAL_APPLICATION_ID: 'app',
        CARACAL_BOOTSTRAP_TOKEN: 'tok',
        CARACAL_RESOURCES: 'broken,calendar=not-a-url',
      } as NodeJS.ProcessEnv),
    ).toThrow(/invalid CARACAL_RESOURCES/)
  })
})

describe('Caracal.fromClientSecret', () => {
  it('allows application transports without configured lifecycle resources', () => {
    const c = Caracal.fromClientSecret({
      coordinatorUrl: 'http://coord',
      stsUrl: 'http://sts',
      zoneId: 'z',
      applicationId: 'app',
      clientSecret: 'secret',
    })

    expect(c.config.resources).toBeUndefined()
  })

  it('rejects malformed endpoints at initialization', () => {
    expect(() =>
      Caracal.fromClientSecret({
        coordinatorUrl: 'coordinator.internal:4000',
        stsUrl: 'http://sts',
        zoneId: 'z',
        applicationId: 'app',
        clientSecret: 'secret',
      }),
    ).toThrow(/absolute http or https URL/)
  })

  it('rejects malformed direct resource bindings', () => {
    expect(() =>
      Caracal.fromClientSecret({
        coordinatorUrl: 'http://coord',
        stsUrl: 'http://sts',
        zoneId: 'z',
        applicationId: 'app',
        clientSecret: 'secret',
        resources: [{ resourceId: 'calendar', upstreamPrefix: 'ftp://calendar.example.com' }],
      }),
    ).toThrow(/absolute http or https URL/)
  })

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

    const headers = await c.headersAsync({ asApplication: true })
    expect(headers[HeaderAuthorization]).toBe('Bearer custom-fetch-token')
    expect(fetchMock).toHaveBeenCalled()
    const body = fetchMock.mock.calls[0][1]!.body as URLSearchParams
    expect(body.get('client_secret')).toBe('secret')
  })
})

function stubExchanger(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    invalidate: vi.fn(),
    identity: async () => ({ zoneId: 'z', applicationId: 'app' }),
    mintMandate: vi.fn(),
    federateSubject: vi.fn(),
    waitForApproval: vi.fn(),
    onEvent: () => {},
    ...overrides,
  }
}

function exchangerClient(exchanger: ReturnType<typeof stubExchanger>): Caracal {
  return new Caracal({
    coordinator: { baseUrl: 'http://coord' },
    zoneId: 'z',
    applicationId: 'app',
    tokenSource: async () => 'tok',
    exchanger: exchanger as never,
  })
}

describe('Caracal.withApproval', () => {
  it('retries with the approval id once the challenge is approved', async () => {
    const exchanger = stubExchanger({ waitForApproval: vi.fn().mockResolvedValue('approved') })
    const c = exchangerClient(exchanger)
    const hold = new ApprovalRequiredError('Approval required', 'chal-9')
    const fn = vi.fn().mockRejectedValueOnce(hold).mockResolvedValueOnce('minted')
    await expect(c.withApproval(fn, { timeoutMs: 50 })).resolves.toBe('minted')
    expect(exchanger.waitForApproval).toHaveBeenCalledWith('chal-9', { timeoutMs: 50 })
    expect(fn).toHaveBeenNthCalledWith(2, 'chal-9')
  })

  it('rethrows the original hold on a non-approved outcome', async () => {
    const exchanger = stubExchanger({ waitForApproval: vi.fn().mockResolvedValue('rejected') })
    const c = exchangerClient(exchanger)
    const hold = new ApprovalRequiredError('Approval required', 'chal-9')
    const fn = vi.fn().mockRejectedValue(hold)
    await expect(c.withApproval(fn)).rejects.toBe(hold)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('passes non-approval errors through without waiting', async () => {
    const exchanger = stubExchanger()
    const c = exchangerClient(exchanger)
    const fn = vi.fn().mockRejectedValue(new Error('boom'))
    await expect(c.withApproval(fn)).rejects.toThrow('boom')
    expect(exchanger.waitForApproval).not.toHaveBeenCalled()
  })
})

describe('isApprovalRequired', () => {
  it('recognizes instances and shape-compatible errors', () => {
    expect(isApprovalRequired(new ApprovalRequiredError('held', 'chal-1'))).toBe(true)
    const foreign = Object.assign(new Error('held'), { code: 'interaction_required', approvalId: 'chal-2' })
    expect(isApprovalRequired(foreign)).toBe(true)
    expect(isApprovalRequired(new Error('nope'))).toBe(false)
    expect(isApprovalRequired(undefined)).toBe(false)
  })
})

describe('lifecycle-only authority hint', () => {
  const denied = () => new CaracalError('access_denied', 'denied by policy', { httpStatus: 403, requestId: 'r1' })

  it('marks transport-level failures retryable and policy denials terminal', () => {
    expect(denied().isRetryable).toBe(false)
    expect(new CaracalError('sts_unavailable', 'down').isRetryable).toBe(true)
    expect(new CaracalError('provider_rate_limited', 'slow down').isRetryable).toBe(true)
    expect(new CaracalError('invalid_request', 'busy', { httpStatus: 429 }).isRetryable).toBe(true)
    expect(new CaracalError('invalid_request', 'boom', { httpStatus: 502 }).isRetryable).toBe(true)
    expect(new CaracalError('invalid_request', 'bad', { httpStatus: 400 }).isRetryable).toBe(false)
  })

  it('appends the hint when a delegation-less session is denied', async () => {
    const exchanger = stubExchanger({ mintMandate: vi.fn().mockRejectedValue(denied()) })
    const c = exchangerClient(exchanger)
    const ctx = { subjectToken: 'tok', zoneId: 'z', applicationId: 'app', sessionId: 's1', hop: 0 }
    await c.bind(ctx, async () => {
      await expect(c.mintMandate('resource://pipernet', ['tickets:read'])).rejects.toMatchObject({
        code: 'access_denied',
        httpStatus: 403,
        requestId: 'r1',
        message: expect.stringContaining('lifecycle-only authority'),
      })
    })
  })

  it('leaves the deny untouched when a delegation is bound', async () => {
    const exchanger = stubExchanger({ mintMandate: vi.fn().mockRejectedValue(denied()) })
    const c = exchangerClient(exchanger)
    const ctx = { subjectToken: 'tok', zoneId: 'z', applicationId: 'app', sessionId: 's1', delegationId: 'd1', hop: 0 }
    await c.bind(ctx, async () => {
      await expect(c.mintMandate('resource://pipernet', ['tickets:read'])).rejects.toMatchObject({
        message: 'denied by policy',
      })
    })
  })
})

describe('Caracal.close', () => {
  it('invalidates the exchanger so nothing stale is served after shutdown', async () => {
    const exchanger = stubExchanger()
    const c = exchangerClient(exchanger)
    await c.close()
    expect(exchanger.invalidate).toHaveBeenCalledOnce()
    expect(exchanger.mintMandate).not.toHaveBeenCalled()
  })
})

describe('Caracal.identity', () => {
  it('exposes the resolved acting identity for logging labels', async () => {
    const c = exchangerClient(stubExchanger())
    await expect(c.identity()).resolves.toEqual({ zoneId: 'z', applicationId: 'app' })
  })
})

describe('Caracal.mintMandate', () => {
  it('returns the minted mandate with its expiry', async () => {
    const exchanger = stubExchanger({
      mintMandate: vi.fn().mockResolvedValue({ token: 'mandate-tok', expiresInSeconds: 900 }),
    })
    const c = exchangerClient(exchanger)
    await expect(c.mintMandate('resource://pipernet', ['tickets:read'])).resolves.toEqual({
      token: 'mandate-tok',
      expiresInSeconds: 900,
    })
  })
})

describe('Caracal.federateSubject', () => {
  function subjectMandate(payload: Record<string, unknown>): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return `eyJhbGciOiJFUzI1NiJ9.${body}.sig`
  }

  it('requires a client-secret configuration', async () => {
    const c = new Caracal({ coordinator: { baseUrl: 'http://coord' }, zoneId: 'z', applicationId: 'app', tokenSource: async () => 't' })
    await expect(c.federateSubject('id-token')).rejects.toThrow('requires a client-secret configuration')
  })

  it('returns the Subject authority record ID decoded from the minted mandate', async () => {
    const token = subjectMandate({ sid: 'sess-42', sub: 'richard.hendricks@piedpiper.example' })
    const exchanger = stubExchanger({
      federateSubject: vi.fn().mockResolvedValue({ token, expiresInSeconds: 600 }),
    })
    const c = exchangerClient(exchanger)
    await expect(c.federateSubject('id-token', { ttlSeconds: 600 })).resolves.toEqual({
      subjectAuthorityRecordId: 'sess-42',
      token,
      expiresInSeconds: 600,
    })
    expect(exchanger.federateSubject).toHaveBeenCalledWith('id-token', { ttlSeconds: 600 })
  })

  it('rejects a minted mandate that carries no session id', async () => {
    const exchanger = stubExchanger({
      federateSubject: vi.fn().mockResolvedValue({ token: subjectMandate({ sub: 'user' }), expiresInSeconds: 600 }),
    })
    const c = exchangerClient(exchanger)
    await expect(c.federateSubject('id-token')).rejects.toThrow('carries no authority record ID')
  })
})

describe('Caracal.acceptDelegation validation', () => {
  function inboundClient(items: Array<{ id: string; status: string }>): Caracal {
    const fetchImpl = (async (url: string) => {
      if (new URL(url).pathname.startsWith('/zones/z/delegations/inbound/')) {
        return new Response(JSON.stringify({ items }), { status: 200 })
      }
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    return new Caracal({
      coordinator: { baseUrl: 'http://coord', fetchImpl },
      zoneId: 'z',
      applicationId: 'app',
      tokenSource: async () => 'tok',
    })
  }
  const ctx = { subjectToken: 'tok', zoneId: 'z', applicationId: 'app', sessionId: 's1', hop: 0 }

  it('runs fn when the delegation is live for the bound session', async () => {
    const c = inboundClient([{ id: 'edge-42', status: 'active' }])
    await c.bind(ctx, async () => {
      await expect(c.acceptDelegation('edge-42', async () => c.current()?.delegationId, { validate: true })).resolves.toBe('edge-42')
    })
  })

  it('rejects a delegation the coordinator does not hold live for the session', async () => {
    const c = inboundClient([{ id: 'edge-42', status: 'revoked' }])
    await c.bind(ctx, async () => {
      await expect(c.acceptDelegation('edge-42', async () => undefined, { validate: true })).rejects.toThrow(/not live for session s1/)
    })
  })

  it('skips the pre-flight when validation is not requested', async () => {
    const c = inboundClient([])
    await c.bind(ctx, async () => {
      await expect(c.acceptDelegation('edge-42', async () => c.current()?.delegationId)).resolves.toBe('edge-42')
    })
  })

  it('reports every presentation and rejected validation on the event bus', async () => {
    const c = inboundClient([{ id: 'edge-42', status: 'revoked' }])
    const events: CaracalEvent[] = []
    c.onEvent((event) => events.push(event))
    await c.bind(ctx, async () => {
      await c.acceptDelegation('edge-7', async () => undefined)
      await expect(c.acceptDelegation('edge-42', async () => undefined, { validate: true })).rejects.toThrow(/not live/)
    })
    const accepts = events.filter((event) => event.type === 'delegation.accept')
    expect(accepts).toEqual([
      expect.objectContaining({ delegationId: 'edge-7', sessionId: 's1', validated: false, ok: true }),
      expect.objectContaining({ delegationId: 'edge-42', sessionId: 's1', validated: true, ok: false }),
    ])
  })
})

describe('Caracal.attachSession', () => {
  it('re-attaches to a persisted service session and renews its lease', async () => {
    const calls: { method: string; path: string }[] = []
    const fetchImpl = (async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      const path = new URL(url).pathname
      calls.push({ method, path })
      if (method === 'DELETE') return new Response(null, { status: 204 })
      return new Response(JSON.stringify({ agent: { status: 'active', heartbeat_deadline_at: '2026-07-09T12:00:00Z' } }), {
        status: 200,
      })
    }) as unknown as typeof fetch
    const c = new Caracal({ ...baseConfig, coordinator: { baseUrl: 'http://coord', fetchImpl } })
    const ends: string[] = []
    c.onSessionEnd((ctx) => void ends.push(ctx.sessionId ?? ''))
    const handle = await c.attachSession('agent-persisted', { heartbeatIntervalMs: 0 })
    expect(handle.sessionId).toBe('agent-persisted')
    expect(handle.deadlineAt).toBe('2026-07-09T12:00:00Z')
    expect(calls[0].path).toBe('/zones/z/agents/agent-persisted/heartbeat')
    await handle.close()
    expect(ends).toEqual(['agent-persisted'])
    expect(calls.some((call) => call.method === 'DELETE' && call.path.endsWith('/agent-persisted'))).toBe(true)
  })
})

describe('logger routing', () => {
  it('routes session cleanup failures to the injected logger', async () => {
    const logger = vi.fn()
    const fetchImpl = (async (url: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') return new Response('cleanup down', { status: 500 })
      return new Response(JSON.stringify({ agent_session_id: 'agent-1' }), { status: 200 })
    }) as unknown as typeof fetch
    const c = new Caracal({ ...baseConfig, coordinator: { baseUrl: 'http://coord', fetchImpl }, logger })
    await expect(c.session(async () => 'ok')).resolves.toBe('ok')
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('terminate failed'), expect.anything())
  })

  it('warns once through the logger when binding unverified context in production', async () => {
    const logger = vi.fn()
    const c = new Caracal({ ...baseConfig, logger })
    const headers = { authorization: 'Bearer inbound' }
    const previous = process.env.CARACAL_ENV
    process.env.CARACAL_ENV = 'production'
    try {
      await c.bindFromHeaders(headers, async () => {})
      await c.bindFromHeaders(headers, async () => {})
    } finally {
      if (previous === undefined) delete process.env.CARACAL_ENV
      else process.env.CARACAL_ENV = previous
    }
    const boundaryWarnings = logger.mock.calls.filter(([message]) => String(message).includes('without a verify hook'))
    expect(boundaryWarnings).toHaveLength(1)
  })
})
