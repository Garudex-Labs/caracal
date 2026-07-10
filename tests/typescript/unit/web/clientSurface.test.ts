// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Wire-contract tests for the web console client endpoint surface: paths, methods,
// bodies, envelope unwrapping, pagination, and the control key trait mapping.

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CONTROL_AUDIENCE,
  CONTROL_SCOPES,
  ConsoleApiError,
  consoleApi,
  isControlKeyApplication,
} from '../../../../apps/web/src/platform/api/client.ts'

const realFetch = globalThis.fetch

type Call = { method: string; url: string; body: unknown }

const universal = {
  items: [],
  next_cursor: null,
  enabled: true,
  autopilot: { available: true },
  system_zone_id: 'z-sys',
}

function record(bodyFor?: (url: string, method: string) => unknown): Call[] {
  const calls: Call[] = []
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : undefined
    calls.push({ method, url: String(url), body })
    const payload = bodyFor ? bodyFor(String(url), method) : universal
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return calls
}

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

function last(calls: Call[]): Call {
  const call = calls[calls.length - 1]
  if (!call) throw new Error('no fetch call recorded')
  return call
}

describe('zone endpoints', () => {
  it('issues the expected verb and path for each zone operation', async () => {
    const calls = record()
    await consoleApi.zones.overview('z/1')
    expect(last(calls)).toMatchObject({ method: 'GET', url: '/api/console/v1/zones/z%2F1/overview' })
    await consoleApi.zones.dcrStatus('z1')
    expect(last(calls).url).toBe('/api/console/v1/zones/z1/dcr-status')
    await consoleApi.zones.create({ name: 'Pied Piper Production' })
    expect(last(calls)).toMatchObject({ method: 'POST', body: { name: 'Pied Piper Production' } })
    await consoleApi.zones.patch('z1', { name: 'Hooli Staging' })
    expect(last(calls)).toMatchObject({ method: 'PATCH', url: '/api/console/v1/zones/z1' })
    await consoleApi.zones.delete('z1')
    expect(last(calls)).toMatchObject({ method: 'DELETE', url: '/api/console/v1/zones/z1' })
  })
})

describe('application and workload endpoints', () => {
  it('covers application CRUD and secret rotation', async () => {
    const calls = record()
    await consoleApi.applications.list('z1')
    expect(last(calls).url).toContain('/v1/zones/z1/applications?limit=500')
    await consoleApi.applications.create('z1', { name: 'Son of Anton', registration_method: 'managed' })
    expect(last(calls)).toMatchObject({ method: 'POST', body: { name: 'Son of Anton' } })
    await consoleApi.applications.patch('z1', 'a1', { name: 'Fiona' })
    expect(last(calls)).toMatchObject({ method: 'PATCH', url: '/api/console/v1/zones/z1/applications/a1' })
    await consoleApi.applications.rotateSecret('z1', 'a1')
    expect(last(calls)).toMatchObject({ method: 'POST', url: '/api/console/v1/zones/z1/applications/a1/rotate-secret' })
    await consoleApi.applications.revealSecret('z1', 'a1')
    expect(last(calls)).toMatchObject({ method: 'GET', url: '/api/console/v1/zones/z1/applications/a1/client-secret' })
    await consoleApi.applications.delete('z1', 'a1')
    expect(last(calls).method).toBe('DELETE')
  })

  it('covers workload CRUD and secret rotation', async () => {
    const calls = record()
    await consoleApi.workloads.list('z1')
    expect(last(calls).url).toContain('/v1/zones/z1/workloads?limit=500')
    await consoleApi.workloads.create('z1', { name: 'PiperNet AI' })
    expect(last(calls)).toMatchObject({ method: 'POST', body: { name: 'PiperNet AI' } })
    await consoleApi.workloads.update('z1', 'w1', { bindings: [] })
    expect(last(calls)).toMatchObject({ method: 'PUT', url: '/api/console/v1/zones/z1/workloads/w1' })
    await consoleApi.workloads.rotateSecret('z1', 'w1')
    expect(last(calls).url).toBe('/api/console/v1/zones/z1/workloads/w1/rotate-secret')
    await consoleApi.workloads.revealSecret('z1', 'w1')
    expect(last(calls)).toMatchObject({ method: 'GET', url: '/api/console/v1/zones/z1/workloads/w1/secret' })
    await consoleApi.workloads.delete('z1', 'w1')
    expect(last(calls).method).toBe('DELETE')
  })
})

describe('resource and provider endpoints', () => {
  it('covers resource CRUD', async () => {
    const calls = record()
    await consoleApi.resources.list('z1')
    expect(last(calls).url).toContain('/v1/zones/z1/resources?limit=500')
    await consoleApi.resources.get('z1', 'r1')
    expect(last(calls).url).toBe('/api/console/v1/zones/z1/resources/r1')
    await consoleApi.resources.create('z1', { name: 'PiperNet', identifier: 'resource://pipernet', scopes: [] })
    expect(last(calls).method).toBe('POST')
    await consoleApi.resources.patch('z1', 'r1', { name: 'Nucleus' })
    expect(last(calls).method).toBe('PATCH')
    await consoleApi.resources.delete('z1', 'r1')
    expect(last(calls).method).toBe('DELETE')
  })

  it('covers provider CRUD and connectivity test', async () => {
    const calls = record()
    await consoleApi.providers.list('z1')
    expect(last(calls).url).toContain('/v1/zones/z1/providers?limit=500')
    await consoleApi.providers.get('z1', 'p1')
    expect(last(calls).url).toBe('/api/console/v1/zones/z1/providers/p1')
    await consoleApi.providers.create('z1', { name: 'Hooli OIDC', provider_kind: 'api_key', config: {} })
    expect(last(calls).method).toBe('POST')
    await consoleApi.providers.patch('z1', 'p1', { name: 'Raviga Capital OAuth' })
    expect(last(calls).method).toBe('PATCH')
    await consoleApi.providers.test('z1', 'p1')
    expect(last(calls)).toMatchObject({ method: 'POST', url: '/api/console/v1/zones/z1/providers/p1/test' })
    await consoleApi.providers.delete('z1', 'p1')
    expect(last(calls).method).toBe('DELETE')
  })
})

describe('policy and policy set endpoints', () => {
  it('covers policy reads, validation, and writes', async () => {
    const calls = record()
    await consoleApi.policies.list('z1')
    expect(last(calls).url).toContain('/v1/zones/z1/policies?limit=500')
    await consoleApi.policies.get('z1', 'pol1')
    expect(last(calls).url).toBe('/api/console/v1/zones/z1/policies/pol1')
    await consoleApi.policies.validate('package caracal\n')
    expect(last(calls)).toMatchObject({ method: 'POST', url: '/api/console/v1/policies/validate' })
    await consoleApi.policies.create('z1', { name: 'PiperNet baseline v3', content: 'package x' })
    expect(last(calls).method).toBe('POST')
    await consoleApi.policies.addVersion('z1', 'pol1', 'package y')
    expect(last(calls)).toMatchObject({ method: 'POST', body: { content: 'package y' } })
    await consoleApi.policies.delete('z1', 'pol1')
    expect(last(calls).method).toBe('DELETE')
  })

  it('covers the policy set lifecycle including activation and simulation', async () => {
    const calls = record()
    await consoleApi.policySets.list('z1')
    expect(last(calls).url).toContain('/v1/zones/z1/policy-sets?limit=500')
    await consoleApi.policySets.get('z1', 'ps1')
    expect(last(calls).url).toBe('/api/console/v1/zones/z1/policy-sets/ps1')
    await consoleApi.policySets.create('z1', 'PiperNet baseline', 'allow read')
    expect(last(calls)).toMatchObject({ method: 'POST', body: { name: 'PiperNet baseline' } })
    await consoleApi.policySets.addVersion('z1', 'ps1', [{ policy_id: 'pol1', version_id: 'v1' }])
    expect(last(calls).url).toBe('/api/console/v1/zones/z1/policy-sets/ps1/versions')
    await consoleApi.policySets.listVersions('z1', 'ps1')
    expect(last(calls).url).toContain('/v1/zones/z1/policy-sets/ps1/versions?limit=500')
    await consoleApi.policySets.getVersion('z1', 'ps1', 'v1')
    expect(last(calls).url).toBe('/api/console/v1/zones/z1/policy-sets/ps1/versions/v1')
    await consoleApi.policySets.activate('z1', 'ps1', 'v1')
    expect(last(calls).body).toEqual({ version_id: 'v1' })
    await consoleApi.policySets.activationStatus('z1', 'ps1', 'v1')
    expect(last(calls).url).toContain('/activation-status?version_id=v1')
    await consoleApi.policySets.activationStatus('z1', 'ps1')
    expect(last(calls).url).toContain('/activation-status')
    await consoleApi.policySets.simulate('z1', 'ps1', 'v1', { subject: 'richard' })
    expect(last(calls).body).toEqual({ version_id: 'v1', input: { subject: 'richard' } })
    await consoleApi.policySets.delete('z1', 'ps1')
    expect(last(calls).method).toBe('DELETE')
  })
})

describe('Authority record, approval, and audit endpoints', () => {
  it('maps the Authority record list envelope with query filters', async () => {
    const calls = record(() => ({
      items: [
        {
          id: 's1',
          zone_id: 'z1',
          session_type: 'user',
          subject_id: 'richard',
          parent_id: null,
          status: 'active',
          expires_at: '2026-07-10T12:00:00Z',
          authenticated_at: '2026-07-10T11:00:00Z',
          created_at: '2026-07-10T11:00:00Z',
          revoked_at: null,
          revoked_reason: null,
        },
      ],
      next_cursor: 'c2',
    }))
    const page = await consoleApi.authorityRecords.list('z1', { status: 'active', subject_id: 'richard' })
    expect(page.rows[0]).toMatchObject({ id: 's1', zoneId: 'z1', type: 'user', subjectId: 'richard' })
    expect(page.nextCursor).toBe('c2')
    expect(last(calls).url).toContain('status=active')
    expect(last(calls).url).toContain('subject_id=richard')
  })

  it('lists, approves, and rejects approval holds', async () => {
    const calls = record()
    await consoleApi.approvals.list('z1', { state: 'pending', cursor: 'cur1' })
    expect(last(calls).url).toContain('/v1/zones/z1/step-up-challenges?limit=100&cursor=cur1&state=pending')
    await consoleApi.approvals.counts('z1')
    expect(last(calls).url).toContain('/v1/zones/z1/step-up-challenges/counts')
    await consoleApi.approvals.approve('z1', 'ch1', 'reviewed against baseline v3')
    expect(last(calls)).toMatchObject({ method: 'POST', body: { reason: 'reviewed against baseline v3' } })
    await consoleApi.approvals.reject('z1', 'ch1')
    expect(last(calls)).toMatchObject({ method: 'POST', url: '/api/console/v1/zones/z1/step-up-challenges/ch1/reject', body: {} })
  })

  it('queries audit streams, request detail, explain, retention, and admin audit', async () => {
    const calls = record(() => ({ items: [], next_cursor: null }))
    await consoleApi.audit.list('z1', { decision: 'deny', label: 'ops', since: '2026-01-01' })
    expect(last(calls).url).toContain('decision=deny')
    expect(last(calls).url).toContain('label=ops')
    await consoleApi.audit.byRequest('z1', 'req1')
    expect(last(calls).url).toBe('/api/console/v1/zones/z1/audit/by-request/req1')
    await consoleApi.audit.explain('z1', 'req1')
    expect(last(calls).url).toContain('/audit/by-request/req1/explain')
    await consoleApi.auditRetention.get()
    expect(last(calls).url).toBe('/api/console/v1/audit-retention')
    await consoleApi.auditRetention.update(30)
    expect(last(calls)).toMatchObject({ method: 'PUT', body: { retention_days: 30 } })
    await consoleApi.adminAudit.list('z1', { actor_id: 'monica', method: 'POST' })
    expect(last(calls).url).toContain('actor_id=monica')
  })
})

describe('operator endpoints', () => {
  it('reads status probes and their derived flags', async () => {
    record()
    expect(await consoleApi.operator.status()).toBe(true)
    expect(await consoleApi.operator.systemZoneId()).toBe('z-sys')
    expect(await consoleApi.operator.autopilotAvailable()).toBe(true)
  })

  it('falls back through governed execution and defaults when probes are sparse', async () => {
    record(() => ({ governed_execution: { configured: true, zone_id: 'z-gov' } }))
    expect(await consoleApi.operator.systemZoneId()).toBe('z-gov')
    record(() => ({}))
    expect(await consoleApi.operator.systemZoneId()).toBeNull()
    expect(await consoleApi.operator.autopilotAvailable()).toBe(false)
  })

  it('manages AI providers with snake_case auth serialization', async () => {
    const calls = record()
    await consoleApi.operator.aiStatus()
    expect(last(calls).url).toBe('/api/console/v1/operator/ai/status')
    await consoleApi.operator.aiCheck()
    expect(last(calls)).toMatchObject({ method: 'POST', url: '/api/console/v1/operator/ai/check' })
    await consoleApi.operator.aiProviders.list()
    expect(last(calls).url).toBe('/api/console/v1/operator/ai/providers')

    await consoleApi.operator.aiProviders.create({
      slug: 'hooli',
      label: 'Hooli PiperNet OIDC',
      baseUrl: 'https://api.pipernet.example',
      models: ['nucleus-1'],
      contextWindow: 128000,
      apiKey: 'k',
      enabled: true,
      auth: { location: 'header', headerName: 'X-Api-Key', authScheme: 'Bearer' },
    })
    expect(last(calls).body).toMatchObject({
      slug: 'hooli',
      base_url: 'https://api.pipernet.example',
      auth: { location: 'header', header_name: 'X-Api-Key', auth_scheme: 'Bearer' },
    })

    await consoleApi.operator.aiProviders.create({
      slug: 'raviga',
      label: 'Raviga Capital OAuth',
      baseUrl: 'https://login.hooli.example',
      models: [],
      contextWindow: 0,
      apiKey: 'k',
      enabled: false,
      auth: { location: 'query' },
    })
    expect(last(calls).body).toMatchObject({ auth: { location: 'query', query_param_name: 'api_key' } })
  })
})

describe('coordinator endpoints', () => {
  it('exposes the canonical Session namespace over Coordinator transport paths', async () => {
    const calls = record(() => ({
      items: [
        {
          agent_session_id: 'ag2',
          zone_id: 'z1',
          application_id: 'app1',
          parent_id: 'ag1',
          subject_session_id: 'record1',
          lifecycle: 'task',
          labels: [],
          status: 'active',
          depth: 1,
          ttl_seconds: 60,
          metadata: null,
          spawned_at: '2026-07-10T11:00:00Z',
          terminated_at: null,
          termination_reason: null,
          last_heartbeat_at: null,
          heartbeat_deadline_at: null,
        },
      ],
    }))
    expect(await consoleApi.sessions.children('z1', 'ag1')).toEqual([
      expect.objectContaining({
        id: 'ag2',
        applicationId: 'app1',
        subjectAuthorityRecordId: 'record1',
        startedAt: '2026-07-10T11:00:00Z',
      }),
    ])
    expect(last(calls).url).toBe('/api/console/coord/zones/z1/agents/ag1/children')
    await consoleApi.sessions.effectiveAuthority('z1', 'ag1')
    expect(last(calls).url).toContain('/agents/ag1/effective-authority')
    await consoleApi.sessions.suspend('z1', 'ag1')
    expect(last(calls)).toMatchObject({ method: 'PATCH', url: '/api/console/coord/zones/z1/agents/ag1/suspend' })
    await consoleApi.sessions.resume('z1', 'ag1')
    expect(last(calls).url).toContain('/agents/ag1/resume')
    await consoleApi.sessions.terminate('z1', 'ag1')
    expect(last(calls)).toMatchObject({ method: 'DELETE', url: '/api/console/coord/zones/z1/agents/ag1' })
  })

  it('covers execution services, invocations, and the delegation graph', async () => {
    const calls = record(() => ({ items: [], next_cursor: null }))
    await consoleApi.execution.services('z1')
    expect(last(calls).url).toBe('/api/console/coord/zones/z1/agent-services')
    await consoleApi.execution.invocations('z1', { status: 'running', limit: 5 })
    expect(last(calls).url).toContain('status=running')
    await consoleApi.delegations.active('z1', { limit: 10 })
    expect(last(calls).url).toContain('/delegations/active?limit=10')
    // Coordinator per-Session edge lists arrive as {items, next_cursor} envelopes; the
    // client hands components the bare rows so `edges.map` can never see the envelope.
    const inboundRows = await consoleApi.delegations.inbound('z1', 's1')
    expect(last(calls).url).toContain('/delegations/inbound/s1')
    expect(Array.isArray(inboundRows)).toBe(true)
    const outboundRows = await consoleApi.delegations.outbound('z1', 's1')
    expect(last(calls).url).toContain('/delegations/outbound/s1')
    expect(Array.isArray(outboundRows)).toBe(true)
    await consoleApi.delegations.traverse('z1', 'd1')
    expect(last(calls).url).toContain('/delegations/d1/traverse')
    await consoleApi.delegations.impact('z1', 'd1')
    expect(last(calls).url).toContain('/delegations/d1/impact')
    await consoleApi.delegations.revoke('z1', 'd1')
    expect(last(calls)).toMatchObject({ method: 'PATCH', url: '/api/console/coord/zones/z1/delegations/d1/revoke' })
  })
})

describe('provider connections', () => {
  it('lists with filters and posts authorize and revoke bodies', async () => {
    const calls = record(() => ({ items: [], next_cursor: null }))
    await consoleApi.providerConnections.list('z1', { provider_id: 'p1', status: 'active' })
    expect(last(calls).url).toContain('provider_id=p1')
    expect(last(calls).url).toContain('&limit=500')
    await consoleApi.providerConnections.authorize('z1', { provider_id: 'p1', subject_id: 'richard' })
    expect(last(calls)).toMatchObject({ method: 'POST', body: { provider_id: 'p1' } })
    await consoleApi.providerConnections.revoke('z1', { subject_id: 'richard', provider_id: 'p1' })
    expect(last(calls).url).toBe('/api/console/v1/zones/z1/provider-connections/revoke')
  })
})

describe('pagination walker', () => {
  it('follows keyset cursors until the server stops returning one', async () => {
    let page = 0
    const calls = record(() => {
      page += 1
      return page < 3 ? { items: [{ id: `r${page}` }], next_cursor: `c${page}` } : { items: [{ id: 'r3' }], next_cursor: null }
    })
    const rows = await consoleApi.resources.list('z1')
    expect(rows.map((row) => (row as { id: string }).id)).toEqual(['r1', 'r2', 'r3'])
    expect(calls).toHaveLength(3)
    expect(calls[1]!.url).toContain('cursor=c1')
  })

  it('stops at the auto-page safety cap when the cursor never ends', async () => {
    const calls = record(() => ({ items: [{ id: 'x' }], next_cursor: 'again' }))
    const rows = await consoleApi.resources.list('z1')
    expect(rows).toHaveLength(50)
    expect(calls).toHaveLength(50)
  })

  it('maps list endpoint errors to ConsoleApiError', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: 'zone_not_found' }), { status: 404 }),
    ) as unknown as typeof fetch
    await expect(consoleApi.approvals.list('missing')).rejects.toMatchObject({
      status: 404,
      code: 'zone_not_found',
    })
  })
})

describe('control key management', () => {
  const keyApp = {
    id: 'a1',
    name: 'Endframe integration',
    traits: [
      'control:invoke',
      'control:scope:zones:read',
      'control:scope:policies:read',
      'control:max-ttl:900',
      'control:expires:2026-12-31T00:00:00Z',
    ],
    created_at: '2026-01-01T00:00:00Z',
  }

  it('maps control applications to control keys with parsed traits', async () => {
    record((url) =>
      url.includes('/applications') ? { items: [keyApp, { id: 'a2', name: 'plain', traits: [] }], next_cursor: null } : universal,
    )
    const keys = await consoleApi.control.list('z1')
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatchObject({
      id: 'a1',
      scopes: ['policies:read', 'zones:read'],
      maxTtlSeconds: 900,
      expiresAt: '2026-12-31T00:00:00Z',
    })
    expect(isControlKeyApplication(keyApp as never)).toBe(true)
  })

  it('treats an unparsable max-ttl trait as absent', async () => {
    record((url) =>
      url.includes('/applications')
        ? { items: [{ ...keyApp, traits: ['control:invoke', 'control:max-ttl:soon'] }], next_cursor: null }
        : universal,
    )
    const keys = await consoleApi.control.list('z1')
    expect(keys[0]!.maxTtlSeconds).toBeUndefined()
  })

  it('creates the control resource before minting the first key', async () => {
    const calls = record((url, method) => {
      if (url.includes('/resources') && method === 'GET') return { items: [], next_cursor: null }
      if (url.includes('/applications') && method === 'POST') return { id: 'a1', name: 'ops', client_secret: 'cs_1', traits: [] }
      return universal
    })
    const result = await consoleApi.control.create('z1', {
      name: 'ops',
      scopes: ['zones:read'],
      maxTtlSeconds: 600,
      expiresAt: '2027-01-01T00:00:00Z',
    })
    expect(result).toMatchObject({ id: 'a1', clientSecret: 'cs_1', scopes: ['zones:read'] })
    const resourceCreate = calls.find((call) => call.method === 'POST' && call.url.endsWith('/v1/zones/z1/resources'))
    expect(resourceCreate?.body).toMatchObject({ identifier: CONTROL_AUDIENCE, scopes: CONTROL_SCOPES })
    const appCreate = calls.find((call) => call.method === 'POST' && call.url.endsWith('/applications'))
    expect(appCreate?.body).toMatchObject({
      traits: ['control:invoke', 'control:scope:zones:read', 'control:max-ttl:600', 'control:expires:2027-01-01T00:00:00Z'],
    })
  })

  it('widens an existing control resource by scope union and skips a matching one', async () => {
    const existing = { id: 'r1', identifier: CONTROL_AUDIENCE, scopes: [CONTROL_SCOPES[0]] }
    const calls = record((url, method) => {
      if (url.includes('/resources') && method === 'GET') return { items: [existing], next_cursor: null }
      if (url.includes('/applications') && method === 'POST') return { id: 'a1', name: 'ops', client_secret: 'cs_1' }
      return universal
    })
    await consoleApi.control.create('z1', { name: 'ops', scopes: [] })
    const patch = calls.find((call) => call.method === 'PATCH')
    expect(patch?.url).toBe('/api/console/v1/zones/z1/resources/r1')
    expect(patch?.body).toEqual({ scopes: [...CONTROL_SCOPES].sort() })

    const matching = { ...existing, scopes: [...CONTROL_SCOPES] }
    const quietCalls = record((url, method) => {
      if (url.includes('/resources') && method === 'GET') return { items: [matching], next_cursor: null }
      if (url.includes('/applications') && method === 'POST') return { id: 'a2', name: 'ops2', client_secret: 'cs_2' }
      return universal
    })
    await consoleApi.control.create('z1', { name: 'ops2', scopes: [] })
    expect(quietCalls.some((call) => call.method === 'PATCH')).toBe(false)
  })

  it('fails closed when the mint response omits the client secret', async () => {
    record((url, method) => {
      if (url.includes('/resources') && method === 'GET') return { items: [], next_cursor: null }
      if (method === 'POST') return { id: 'a1', name: 'ops' }
      return universal
    })
    await expect(consoleApi.control.create('z1', { name: 'ops', scopes: [] })).rejects.toMatchObject({
      status: 500,
      code: 'missing_client_secret',
    })
    await expect(consoleApi.control.rotate('z1', 'a1')).rejects.toMatchObject({
      code: 'missing_client_secret',
    })
  })

  it('rotates, revokes, toggles, and issues tokens through the control endpoints', async () => {
    const calls = record((url, method) => (method === 'POST' && url.includes('rotate-secret') ? { client_secret: 'cs_2' } : universal))
    expect(await consoleApi.control.rotate('z1', 'a1')).toEqual({ id: 'a1', clientSecret: 'cs_2' })
    await consoleApi.control.revoke('z1', 'a1')
    expect(last(calls)).toMatchObject({ method: 'DELETE', url: '/api/console/v1/zones/z1/applications/a1' })
    await consoleApi.control.status()
    expect(last(calls).url).toBe('/api/console/control/status')
    await consoleApi.control.enable()
    expect(last(calls)).toMatchObject({ method: 'POST', url: '/api/console/control/enable' })
    await consoleApi.control.disable()
    expect(last(calls).url).toBe('/api/console/control/disable')
    await consoleApi.control.issueToken('z1', { keyId: 'a1', scopes: ['zones:read'] })
    expect(last(calls).body).toMatchObject({ zoneId: 'z1', keyId: 'a1' })
  })
})

describe('error body fallbacks', () => {
  it('uses the HTTP status text when an error body is not JSON', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('gateway exploded', { status: 502, statusText: 'Bad Gateway' }),
    ) as unknown as typeof fetch
    await expect(consoleApi.status()).rejects.toMatchObject({ status: 502, code: 'Bad Gateway' })
  })

  it('falls back to request_failed when there is no status text', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 500, statusText: '' })) as unknown as typeof fetch
    await expect(consoleApi.status()).rejects.toMatchObject({ status: 500, code: 'request_failed' })
    expect(new ConsoleApiError(500, 'request_failed').timedOut).toBe(false)
  })
})
