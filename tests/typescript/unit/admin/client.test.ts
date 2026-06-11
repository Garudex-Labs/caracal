// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// AdminClient unit tests covering request shape, query encoding, and error mapping.

import { describe, it, expect, vi } from 'vitest'
import { AdminClient } from '../../../../packages/admin/ts/src/client.js'
import { AdminApiError } from '../../../../packages/admin/ts/src/errors.js'

function fetchOk(body: unknown, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    status,
    statusText: 'OK',
    text: async () => JSON.stringify(body),
    json: async () => body,
  }) as unknown as typeof fetch
}

function fetchErr(status: number, body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: 'Bad Request',
    headers: new Headers(),
    text: async () => JSON.stringify(body),
    json: async () => body,
  }) as unknown as typeof fetch
}

describe('AdminClient', () => {
  it('sends Bearer token and parses JSON', async () => {
    const f = fetchOk([{ id: 'z1', slug: 'demo' }])
    const c = new AdminClient({ apiUrl: 'http://api', adminToken: 't', fetchImpl: f })
    const out = await c.zones.list()
    expect(out).toEqual([{ id: 'z1', slug: 'demo' }])
    const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(url).toBe('http://api/v1/zones')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t')
  })

  it('encodes query parameters and skips empty values', async () => {
    const f = fetchOk({ rows: [], next_cursor: null })
    const c = new AdminClient({ apiUrl: 'http://api/', adminToken: 't', fetchImpl: f })
    await c.audit.list('z1', { decision: 'deny', limit: 50, since: undefined })
    const [url] = (f as unknown as { mock: { calls: [string][] } }).mock.calls[0]
    expect(url).toBe('http://api/v1/zones/z1/audit?decision=deny&limit=50')
  })

  it('unwraps paged audit and session responses', async () => {
    const f = fetchOk({ rows: [{ id: 'ev1' }], next_cursor: null })
    const c = new AdminClient({ apiUrl: 'http://api', adminToken: 't', fetchImpl: f })

    await expect(c.audit.list('z1')).resolves.toEqual([{ id: 'ev1' }])
    await expect(c.sessions.list('z1')).resolves.toEqual([{ id: 'ev1' }])
  })

  it('rejects paged audit and session responses without rows', async () => {
    const c = new AdminClient({ apiUrl: 'http://api', adminToken: 't', fetchImpl: fetchOk({ next_cursor: null }) })

    await expect(c.audit.list('z1')).rejects.toThrow(/audit response missing rows/)
    await expect(c.sessions.list('z1')).rejects.toThrow(/sessions response missing rows/)
  })

  it('serializes JSON body with Content-Type', async () => {
    const f = fetchOk({ id: 'z2', slug: 'new' })
    const c = new AdminClient({ apiUrl: 'http://api', adminToken: 't', fetchImpl: f })
    await c.zones.create({ slug: 'new', display_name: 'New Zone' })
    const [, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual({ slug: 'new', display_name: 'New Zone' })
  })

  it('requests DCR zone status and sends shutdown mode on zone patch', async () => {
    const f = fetchOk({ id: 'z1', dcr_enabled: false, live_dcr_applications: 2 })
    const c = new AdminClient({ apiUrl: 'http://api', adminToken: 't', fetchImpl: f })

    await c.zones.dcrStatus('z1')
    await c.zones.patch('z1', { dcr_enabled: false, dcr_shutdown: 'revoke_live' })

    const calls = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls
    expect(calls[0][0]).toBe('http://api/v1/zones/z1/dcr-status')
    expect(calls[1][0]).toBe('http://api/v1/zones/z1')
    expect(calls[1][1].method).toBe('PATCH')
    expect(JSON.parse(calls[1][1].body as string)).toEqual({ dcr_enabled: false, dcr_shutdown: 'revoke_live' })
  })

  it('returns undefined for 204 / expectEmpty', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 204, statusText: 'No Content', text: async () => '', json: async () => undefined }) as unknown as typeof fetch
    const c = new AdminClient({ apiUrl: 'http://api', adminToken: 't', fetchImpl: f })
    const out = await c.zones.delete('z1')
    expect(out).toBeUndefined()
  })

  it('throws AdminApiError with parsed body and code', async () => {
    const f = fetchErr(400, { error: 'invalid_input', detail: 'bad slug' })
    const c = new AdminClient({ apiUrl: 'http://api', adminToken: 't', fetchImpl: f })
    await expect(c.zones.create({ slug: '!!', display_name: 'x' })).rejects.toMatchObject({
      name: 'AdminApiError',
      status: 400,
      code: 'invalid_input',
    })
    try {
      await c.zones.create({ slug: '!!', display_name: 'x' })
    } catch (e) {
      expect(e).toBeInstanceOf(AdminApiError)
      expect((e as AdminApiError).body).toEqual({ error: 'invalid_input', detail: 'bad slug' })
    }
  })

  it('falls back to status text when response is not JSON', async () => {
    const f = vi.fn().mockResolvedValue({
      ok: false, status: 500, statusText: 'Server Error',
      text: async () => '<html>nope</html>', json: async () => { throw new Error('x') },
    }) as unknown as typeof fetch
    const c = new AdminClient({ apiUrl: 'http://api', adminToken: 't', fetchImpl: f, retries: 0 })
    await expect(c.zones.list()).rejects.toMatchObject({ status: 500, code: 'Server Error' })
  })

  it('routes coordinator calls to the coordinator base with its token', async () => {
    const f = fetchOk({ items: [], next_cursor: null })
    const c = new AdminClient({
      apiUrl: 'http://api',
      coordinatorUrl: 'http://coord',
      adminToken: 'a',
      coordinatorToken: 'jwt',
      fetchImpl: f,
    })
    await c.agents.list('z1')
    const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(url).toBe('http://coord/zones/z1/agents')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt')
  })

  it('forwards agent list filters as query params', async () => {
    const f = fetchOk({ items: [], next_cursor: null })
    const c = new AdminClient({
      apiUrl: 'http://api',
      coordinatorUrl: 'http://coord',
      adminToken: 'a',
      coordinatorToken: 'jwt',
      fetchImpl: f,
    })
    await c.agents.list('z1', { status: 'active', lifecycle: 'service', application_id: 'app-1', label: 'worker', limit: 25 })
    const [url] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(url).toContain('status=active')
    expect(url).toContain('lifecycle=service')
    expect(url).toContain('application_id=app-1')
    expect(url).toContain('label=worker')
    expect(url).toContain('limit=25')
  })

  it('parses coordinator agent list responses', async () => {
    const f = fetchOk({
      items: [{
        agent_session_id: 'agent-1',
        zone_id: 'z1',
        application_id: 'app-1',
        parent_id: null,
        subject_session_id: 'subject-1',
        status: 'active',
        depth: 0,
        spawned_at: '2026-01-01T00:00:00Z',
        terminated_at: null,
      }],
      next_cursor: null,
    })
    const c = new AdminClient({
      apiUrl: 'http://api',
      coordinatorUrl: 'http://coord',
      adminToken: 'a',
      coordinatorToken: 'jwt',
      fetchImpl: f,
    })

    await expect(c.agents.list('z1')).resolves.toEqual([
      expect.objectContaining({ agent_session_id: 'agent-1' }),
    ])
  })

  it('rejects malformed coordinator agent list responses', async () => {
    const c = new AdminClient({
      apiUrl: 'http://api',
      coordinatorUrl: 'http://coord',
      adminToken: 'a',
      coordinatorToken: 'jwt',
      fetchImpl: fetchOk({ next_cursor: null }),
    })

    await expect(c.agents.list('z1')).rejects.toThrow(/agents response missing items/)
  })

  it('marks coordinator response errors with the coordinator target', async () => {
    const f = fetchErr(401, { error: 'invalid_token' })
    const c = new AdminClient({
      apiUrl: 'http://api',
      coordinatorUrl: 'http://coord',
      adminToken: 'a',
      coordinatorToken: 'jwt',
      fetchImpl: f,
    })

    await expect(c.agents.list('z1')).rejects.toMatchObject({
      name: 'AdminApiError',
      status: 401,
      code: 'invalid_token',
      target: 'coordinator',
    })
  })

  it('throws when coordinator URL is missing', async () => {
    const c = new AdminClient({ apiUrl: 'http://api', adminToken: 'a', fetchImpl: fetchOk([]) })
    await expect(c.agents.list('z1')).rejects.toThrow(/coordinator_url_not_configured/)
  })

  it('throws when coordinator token is missing', async () => {
    const c = new AdminClient({
      apiUrl: 'http://api',
      coordinatorUrl: 'http://coord',
      adminToken: 'a',
      fetchImpl: fetchOk([]),
    })
    await expect(c.agents.list('z1')).rejects.toThrow(/coordinator_token_not_configured/)
  })

  it('hits the audit by-request detail endpoint', async () => {
    const f = fetchOk([{ id: 'a1', event_type: 'token.exchange', request_id: 'req-9' }])
    const c = new AdminClient({ apiUrl: 'http://api', adminToken: 't', fetchImpl: f })
    const rows = await c.audit.byRequest('z1', 'req-9')
    expect(rows).toHaveLength(1)
    const [url] = (f as unknown as { mock: { calls: [string][] } }).mock.calls[0]
    expect(url).toBe('http://api/v1/zones/z1/audit/by-request/req-9')
  })

  it('hits the audit decision trace endpoint', async () => {
    const f = fetchOk({ request_id: 'req-9', zone_id: 'z1', final_decision: 'allow', denied: [], events: [] })
    const c = new AdminClient({ apiUrl: 'http://api', adminToken: 't', fetchImpl: f })
    const trace = await c.audit.explain('z1', 'req-9')
    expect(trace.final_decision).toBe('allow')
    const [url] = (f as unknown as { mock: { calls: [string][] } }).mock.calls[0]
    expect(url).toBe('http://api/v1/zones/z1/audit/by-request/req-9/explain')
  })

  it('PATCH revoke sends method and parses body', async () => {
    const f = fetchOk({ revoked_edges: 3, affected_sessions: 2 })
    const c = new AdminClient({
      apiUrl: 'http://api', coordinatorUrl: 'http://coord',
      adminToken: 'a', coordinatorToken: 'jwt', fetchImpl: f,
    })
    const out = await c.delegations.revoke('z1', 'edge-1')
    expect(out).toEqual({ revoked_edges: 3, affected_sessions: 2 })
    const [, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(init.method).toBe('PATCH')
  })

  it('retries transient GET failures', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Unavailable',
        headers: new Headers({ 'retry-after': '0' }),
        text: async () => JSON.stringify({ error: 'unavailable' }),
        json: async () => ({ error: 'unavailable' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: async () => JSON.stringify([{ id: 'z1' }]),
        json: async () => [{ id: 'z1' }],
      }) as unknown as typeof fetch
    const c = new AdminClient({ apiUrl: 'http://api', adminToken: 't', fetchImpl: f, retries: 1 })

    await expect(c.zones.list()).resolves.toEqual([{ id: 'z1' }])
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('does not retry mutating requests without idempotency support', async () => {
    const f = fetchErr(503, { error: 'unavailable' })
    const c = new AdminClient({ apiUrl: 'http://api', adminToken: 't', fetchImpl: f, retries: 3 })

    await expect(c.zones.create({ name: 'Demo' })).rejects.toMatchObject({ status: 503 })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('honours a date-based retry-after header', async () => {
    const when = new Date(Date.now() + 10).toUTCString()
    const f = vi.fn()
      .mockResolvedValueOnce({
        ok: false, status: 429, statusText: 'Too Many',
        headers: new Headers({ 'retry-after': when }),
        text: async () => '{}', json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true, status: 200, statusText: 'OK', headers: new Headers(),
        text: async () => '[]', json: async () => [],
      }) as unknown as typeof fetch
    const c = new AdminClient({ apiUrl: 'http://api', adminToken: 't', fetchImpl: f, retries: 1 })
    await expect(c.zones.list()).resolves.toEqual([])
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('aborts when the caller signal fires', async () => {
    const controller = new AbortController()
    const f = vi.fn().mockImplementation(() => {
      controller.abort()
      return Promise.reject(new DOMException('aborted', 'AbortError'))
    }) as unknown as typeof fetch
    const c = new AdminClient({
      apiUrl: 'http://api', adminToken: 't', fetchImpl: f, retries: 3, signal: controller.signal,
    })
    await expect(c.zones.list()).rejects.toBeInstanceOf(DOMException)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('throws policy_template_not_found when a template id is missing', async () => {
    const c = new AdminClient({
      apiUrl: 'http://api', adminToken: 't', fetchImpl: fetchOk([{ id: 'known' }]),
    })
    await expect(c.policyTemplates.get('ghost')).rejects.toMatchObject({
      status: 404, code: 'policy_template_not_found',
    })
  })

  it('covers the API namespace surface with correct path and method', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = []
    const f = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body as string | undefined })
      const body = url.includes('/audit') || url.includes('/sessions')
        ? { rows: [], next_cursor: null }
        : {}
      return Promise.resolve({
        ok: true, status: 200, statusText: 'OK', headers: new Headers(),
        text: async () => JSON.stringify(body), json: async () => body,
      })
    }) as unknown as typeof fetch
    const c = new AdminClient({
      apiUrl: 'http://api', coordinatorUrl: 'http://coord',
      adminToken: 'a', coordinatorToken: 'c', fetchImpl: f,
    })

    await c.zones.get('z1')
    await c.zones.dcrStatus('z1')
    await c.zones.delete('z1')
    await c.applications.list('z1')
    await c.applications.get('z1', 'a1')
    await c.applications.create('z1', { name: 'A' } as never)
    await c.applications.patch('z1', 'a1', { name: 'B' } as never)
    await c.applications.delete('z1', 'a1')
    await c.applications.dcr('z1', {} as never)
    await c.resources.list('z1')
    await c.resources.get('z1', 'r1')
    await c.resources.create('z1', {} as never)
    await c.resources.patch('z1', 'r1', {})
    await c.resources.delete('z1', 'r1')
    await c.providers.list('z1')
    await c.providers.get('z1', 'p1')
    await c.providers.create('z1', {} as never)
    await c.providers.patch('z1', 'p1', {})
    await c.providers.delete('z1', 'p1')
    await c.policies.list('z1')
    await c.policies.get('z1', 'pol1')
    await c.policies.create('z1', {} as never)
    await c.policies.validate('package x', '2026-05-20')
    await c.policies.addVersion('z1', 'pol1', 'content')
    await c.policies.delete('z1', 'pol1')
    await c.policyTemplates.list()
    await c.policySets.list('z1')
    await c.policySets.get('z1', 'ps1')
    await c.policySets.create('z1', 'Set', 'desc')
    await c.policySets.addVersion('z1', 'ps1', [{ policy_version_id: 'v1' }])
    await c.policySets.simulate('z1', 'ps1', 'v1', { foo: 1 })
    await c.policySets.activate('z1', 'ps1', 'v1', 'shadow')
    await c.policySets.delete('z1', 'ps1')
    await c.grants.list('z1', { subject_id: 'user-1', provider_id: 'provider-1', scopes: ['read', 'write'] })
    await c.grants.get('z1', 'g1')
    await c.grants.create('z1', {} as never)
    await c.grants.revoke('z1', 'g1')
    await c.providerGrants.create('z1', {} as never)
    await c.providerGrants.authorizeOAuth('z1', {} as never)
    await c.providerGrants.revoke('z1', {} as never)
    await c.sessions.list('z1', { status: 'active' } as never)
    await c.audit.list('z1', { limit: 5 } as never)
    await c.stepUpChallenges.list('z1')
    await c.stepUpChallenges.get('z1', 'challenge1')
    await c.stepUpChallenges.satisfy('z1', 'challenge1')

    await c.agents.get('z1', 'ag1')
    await c.agents.children('z1', 'ag1')
    await c.agents.suspend('z1', 'ag1')
    await c.agents.resume('z1', 'ag1')
    await c.agents.terminate('z1', 'ag1')
    await c.delegations.active('z1')
    await c.delegations.inbound('z1', 's1')
    await c.delegations.outbound('z1', 's1')
    await c.delegations.traverse('z1', 'd1')
    await c.delegations.impact('z1', 'd1')
    await c.delegations.revoke('z1', 'd1')

    expect(calls.some((x) => x.url === 'http://api/v1/zones/z1' && x.method === 'DELETE')).toBe(true)
    expect(calls.some((x) => x.url === 'http://api/v1/policies/validate' && x.method === 'POST')).toBe(true)
    expect(calls.some((x) => x.url === 'http://api/v1/zones/z1/grants?provider_id=provider-1&user_id=user-1&scopes=read%2Cwrite')).toBe(true)
    expect(calls.some((x) => x.url === 'http://api/v1/zones/z1/provider-grants' && x.method === 'POST')).toBe(true)
    expect(calls.some((x) => x.url === 'http://api/v1/zones/z1/step-up-challenges/challenge1/satisfy' && x.method === 'POST')).toBe(true)
    expect(calls.some((x) => x.url === 'http://coord/zones/z1/agents/ag1/suspend' && x.method === 'PATCH')).toBe(true)
    expect(calls.some((x) => x.url === 'http://coord/zones/z1/delegations/d1/revoke' && x.method === 'PATCH')).toBe(true)
    expect(calls.some((x) => x.url === 'http://api/v1/zones/z1/sessions?status=active')).toBe(true)
  })
})
