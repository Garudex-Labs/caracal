// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// OAuthClient unit tests: exchange, cache hit, 401-retry, interaction_required.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OAuthClient } from '../../../../../packages/oauth/ts/src/client.js'
import {
  CaracalError,
  ApprovalRequiredError,
  type OAuthEvent,
  type TokenExchangeEvent,
} from '../../../../../packages/oauth/ts/src/types.js'

describe('OAuthClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('exchanges a token successfully', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'tok-1', expires_in: 900 }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')
    const res = await client.exchange('subject-tok', 'resource://api', { clientSecret: 'secret-1' })
    expect(res.accessToken).toBe('tok-1')
    expect(res.expiresIn).toBe(900)
    const body = fetchMock.mock.calls[0][1].body as URLSearchParams
    expect(body.get('client_secret')).toBe('secret-1')
  })

  it('mints distinct one-shot tokens without cache or single-flight sharing', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ access_token: `token-${++calls}`, token_type: 'Bearer', expires_in: 900 }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')

    const tokens = await Promise.all([
      client.exchange('', 'resource://pipernet', { clientSecret: 'secret', scopes: ['read'], cache: false }),
      client.exchange('', 'resource://pipernet', { clientSecret: 'secret', scopes: ['read'], cache: false }),
    ])

    expect(tokens.map((token) => token.accessToken).sort()).toEqual(['token-1', 'token-2'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns upstream directives from gateway-authenticated exchanges', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'caracal-mandate',
        expires_in: 900,
        target_resources: ['resource://openai'],
        upstreams: {
          'resource://openai': {
            auth_mode: 'provider_apikey',
            provider_token: 'provider-token',
            auth_header: 'Authorization',
          },
        },
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')
    const res = await client.exchange('', 'resource://openai', { clientSecret: 'secret-1' })

    expect(res.upstreams?.['resource://openai']?.providerToken).toBe('provider-token')
  })

  it('supports application-principal exchanges with multiple resources', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'tok-app', expires_in: 900 }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')
    const res = await client.exchange('', ['resource://a', 'resource://b'], { clientSecret: 'secret-1' })
    expect(res.accessToken).toBe('tok-app')
    const body = fetchMock.mock.calls[0][1].body as URLSearchParams
    expect(body.get('subject_token')).toBeNull()
    expect(body.getAll('resource')).toEqual(['resource://a', 'resource://b'])
  })

  it('sends ttl seconds and omits blank resource entries', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'tok-ttl', expires_in: 900 }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')

    await client.exchange('subject-tok', [' resource://api ', ' '], { ttlSeconds: 60 })

    const body = fetchMock.mock.calls[0][1].body as URLSearchParams
    expect(body.getAll('resource')).toEqual(['resource://api'])
    expect(body.get('ttl_seconds')).toBe('60')
  })

  it('returns cached token without calling STS again', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'tok-cached', expires_in: 900 }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')
    await client.exchange('subject-tok', 'resource://api')
    await client.exchange('subject-tok', 'resource://api')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('drops cached tokens on invalidate', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: `token-${++calls}`, expires_in: 900 }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')

    expect((await client.exchange('subject', 'resource://api')).accessToken).toBe('token-1')
    client.invalidate()
    expect((await client.exchange('subject', 'resource://api')).accessToken).toBe('token-2')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('never serves an approval-bearing exchange from cache', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: `token-${++calls}`, expires_in: 900 }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')

    await client.exchange('', 'resource://api', { clientSecret: 'secret', scopes: ['read'] })
    const approved = await client.exchange('', 'resource://api', {
      clientSecret: 'secret',
      scopes: ['read'],
      challengeId: 'approval-1',
    })

    expect(approved.accessToken).toBe('token-2')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries once on 401', async () => {
    let callCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          return { ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) }
        }
        return { ok: true, status: 200, json: async () => ({ access_token: 'tok-retry', expires_in: 900 }) }
      }),
    )
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')
    const res = await client.exchange('subject-tok', 'resource://api')
    expect(res.accessToken).toBe('tok-retry')
    expect(callCount).toBe(2)
  })

  it('throws ApprovalRequiredError on interaction_required', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({
          error: 'interaction_required',
          error_description: 'MFA required',
          challenge_id: 'chal-1',
        }),
      }),
    )
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')
    const err = await client.exchange('subject-tok', 'resource://api').catch((error: unknown) => error)
    expect(err).toBeInstanceOf(ApprovalRequiredError)
    expect(err.approvalId).toBe('chal-1')
    expect(err.resource).toBe('resource://api')
  })

  it('does not share cache across subjects', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'tok-shared', expires_in: 900 }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')
    await client.exchange('subject-a', 'resource://api')
    await client.exchange('subject-b', 'resource://api')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not share cache across requested scopes', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'tok-scoped', expires_in: 900 }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')
    await client.exchange('subject-a', 'resource://api', { scopes: ['read'] })
    await client.exchange('subject-a', 'resource://api', { scopes: ['write'] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('sends assertion, Authority record, Session, and Delegation fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'tok-delegated', expires_in: 900 }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')
    await client.exchange('subject-a', 'resource://api', {
      clientAssertion: 'assertion-1',
      clientAssertionType: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      authorityRecordId: 'record-1',
      sessionId: 'session-1',
      delegationId: 'delegation-1',
    })
    const body = fetchMock.mock.calls[0][1].body as URLSearchParams
    expect(body.get('client_assertion')).toBe('assertion-1')
    expect(body.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer')
    expect(body.get('actor_token')).toBeNull()
    expect(body.get('session_id')).toBe('record-1')
    expect(body.get('agent_session_id')).toBe('session-1')
    expect(body.get('delegation_edge_id')).toBe('delegation-1')
  })

  it('does not share cache across Delegations', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'tok-edge', expires_in: 900 }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')
    await client.exchange('subject-a', 'resource://api', { delegationId: 'delegation-a' })
    await client.exchange('subject-a', 'resource://api', { delegationId: 'delegation-b' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not share cache across client secrets', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      const body = init.body as URLSearchParams
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: body.get('client_secret') === 'secret-a' ? 'tok-a' : 'tok-b',
          expires_in: 900,
        }),
      }
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')

    const first = await client.exchange('subject-a', 'resource://api', { clientSecret: 'secret-a' })
    const second = await client.exchange('subject-a', 'resource://api', { clientSecret: 'secret-b' })

    expect(first.accessToken).toBe('tok-a')
    expect(second.accessToken).toBe('tok-b')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not share cache across Sessions', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'tok-session', expires_in: 900 }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')
    await client.exchange('subject-a', 'resource://api', { sessionId: 'session-a' })
    await client.exchange('subject-a', 'resource://api', { sessionId: 'session-b' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('normalizes duplicate scopes before exchange and cache lookup', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'tok-normalized', expires_in: 900 }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')

    await client.exchange('subject-a', 'resource://api', { scopes: ['write', 'read', 'write'] })
    await client.exchange('subject-a', 'resource://api', { scopes: ['read', 'write'] })

    const body = fetchMock.mock.calls[0][1].body as URLSearchParams
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(body.get('scope')).toBe('read write')
  })

  it('caps the preflight window at half the token lifetime', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'tok-fresh', expires_in: 20 }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')

    await client.exchange('subject-a', 'resource://api', { timeoutMs: 5_000 })
    await client.exchange('subject-a', 'resource://api', { timeoutMs: 5_000 })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 11_000)
    const res = await client.exchange('subject-a', 'resource://api', { timeoutMs: 5_000 })

    expect(res.accessToken).toBe('tok-fresh')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects malformed STS error bodies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => 'not-json',
      }),
    )
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')

    await expect(client.exchange('subject-tok', 'resource://api')).rejects.toThrow('invalid error response')
  })

  it('formats STS errors from json-only responses and request ids', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error_description: 'Denied', requestId: 'req-1' }),
      }),
    )
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')

    await expect(client.exchange('subject-tok', 'resource://api')).rejects.toThrow('Denied (request_id=req-1)')
  })

  it('uses retry-after headers for transient STS retries', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: () => '0' },
        text: async () => JSON.stringify({ error: 'rate_limited' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ access_token: 'tok-retry-after', expires_in: 900 }),
      })
    vi.stubGlobal('fetch', fetchMock)
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')

    await expect(client.exchange('subject-tok', 'resource://api', { retries: 1 })).resolves.toMatchObject({
      accessToken: 'tok-retry-after',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rethrows final fetch errors and times out expired deadlines', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')

    await expect(client.exchange('subject-tok', 'resource://api', { retries: 0 })).rejects.toThrow('network down')
    await expect(client.exchange('subject-tok', 'resource://api', { timeoutMs: -1 })).rejects.toThrow('STS request timed out')
  })

  it('rejects non-json successful STS responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'text/html' },
        json: async () => ({ access_token: 'tok-html', expires_in: 900 }),
      }),
    )
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')

    await expect(client.exchange('subject-tok', 'resource://api')).rejects.toThrow('expected application/json')
  })

  it('rejects malformed successful STS responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ access_token: '', expires_in: 900 }),
      }),
    )
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')

    await expect(client.exchange('subject-tok', 'resource://api')).rejects.toThrow('access_token is required')
  })

  it.each([
    [{ access_token: 'tok', token_type: 'Basic', expires_in: 900 }, 'token_type must be Bearer'],
    [{ access_token: 'tok', expires_in: 0 }, 'expires_in must be a positive integer'],
    [{ access_token: 'tok', expires_in: 900, target_resources: ['ok', 1] }, 'target_resources must be a string array'],
    [{ access_token: 'tok', expires_in: 900, upstreams: [] }, 'upstreams must be an object'],
    [{ access_token: 'tok', expires_in: 900, upstreams: { r: null } }, 'upstream directive must be an object'],
    [
      { access_token: 'tok', expires_in: 900, upstreams: { r: { allowed_token_hosts: ['a', 1] } } },
      'allowed_token_hosts must be a string array',
    ],
    [
      { access_token: 'tok', expires_in: 900, upstreams: { r: { forward_caracal_identity: 'true' } } },
      'forward_caracal_identity must be a boolean',
    ],
    [{ access_token: 'tok', expires_in: 900, upstreams: { r: { expires_at: 1.5 } } }, 'expires_at must be an integer'],
  ])('rejects invalid successful STS response shape %#', async (body, message) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json; charset=utf-8' },
        json: async () => body,
      }),
    )
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')

    await expect(client.exchange('subject-tok', 'resource://api')).rejects.toThrow(message)
  })

  it('carries typed error fields on STS denials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: 'access_denied', error_description: 'Denied', requestId: 'req-2' }),
      }),
    )
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')

    const err = await client.exchange('subject-tok', 'resource://api').catch((error: unknown) => error)
    expect(err).toBeInstanceOf(CaracalError)
    expect((err as CaracalError).code).toBe('access_denied')
    expect((err as CaracalError).requestId).toBe('req-2')
    expect((err as CaracalError).httpStatus).toBe(403)
  })

  it('carries request id and status on ApprovalRequiredError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({
          error: 'interaction_required',
          error_description: 'Approval required',
          challenge_id: 'chal-9',
          requestId: 'req-9',
        }),
      }),
    )
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')

    const err = await client.exchange('subject-tok', 'resource://api').catch((error: unknown) => error)
    expect(err).toBeInstanceOf(ApprovalRequiredError)
    expect((err as ApprovalRequiredError).requestId).toBe('req-9')
    expect((err as ApprovalRequiredError).httpStatus).toBe(401)
  })

  it('emits token.exchange events for fresh, cached, and failed exchanges', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'tok-events', expires_in: 900 }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ error: 'access_denied', error_description: 'Denied' }),
      })
    vi.stubGlobal('fetch', fetchMock)
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')
    const events: OAuthEvent[] = []
    client.onEvent = (event) => events.push(event)

    await client.exchange('subject-a', 'resource://api', { scopes: ['write', 'read'] })
    await client.exchange('subject-a', 'resource://api', { scopes: ['read', 'write'] })
    await client.exchange('subject-b', 'resource://api').catch(() => undefined)

    expect(events).toHaveLength(3)
    expect(events[0]).toMatchObject({
      type: 'token.exchange',
      ok: true,
      cached: false,
      resources: ['resource://api'],
      scopes: ['read', 'write'],
    })
    expect(events[1]).toMatchObject({ type: 'token.exchange', ok: true, cached: true })
    expect(events[2]).toMatchObject({ type: 'token.exchange', ok: false, cached: false, status: 403, code: 'access_denied' })
    expect((events[0] as TokenExchangeEvent).durationMs).toBeGreaterThanOrEqual(0)
  })

  it('emits approval.wait events and survives a throwing sink', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ state: 'approved' }),
      }),
    )
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')
    const events: OAuthEvent[] = []
    client.onEvent = (event) => {
      events.push(event)
      throw new Error('sink failure')
    }

    await expect(client.waitForApproval('chal-1', { timeoutSeconds: 5 })).resolves.toBe('approved')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'approval.wait', ok: true, approvalId: 'chal-1', state: 'approved' })
  })

  it('rejects an unknown challenge state instead of returning it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ state: 'vaporized' }),
      }),
    )
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')
    await expect(client.waitForApproval('chal-1')).rejects.toThrow(/unknown challenge state: vaporized/)
  })

  it('aborts the wait when the signal fires', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init?: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
        })
      }),
    )
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')
    const controller = new AbortController()
    const pending = client.waitForApproval('chal-1', { signal: controller.signal })
    controller.abort(new Error('caller gave up'))
    await expect(pending).rejects.toThrow('caller gave up')
  })
})

describe('federateSubject', () => {
  it('posts the id_token subject type with no resources and returns the user session', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'user-session-token', token_type: 'Bearer', expires_in: 3600 }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')
    const res = await client.federateSubject('external-id-token', { clientSecret: 'secret-1' })
    expect(res.accessToken).toBe('user-session-token')
    const body = fetchMock.mock.calls[0][1].body as URLSearchParams
    expect(body.get('subject_token')).toBe('external-id-token')
    expect(body.get('subject_token_type')).toBe('urn:ietf:params:oauth:token-type:id_token')
    expect(body.get('resource')).toBeNull()
    expect(body.get('client_secret')).toBe('secret-1')
  })

  it('rejects an empty id token and surfaces STS denials as CaracalError', async () => {
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')
    await expect(client.federateSubject('')).rejects.toThrow('identity token')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: 'invalid_token', error_description: 'issuer not trusted' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(client.federateSubject('bad-token')).rejects.toMatchObject({ code: 'invalid_token' })
  })
})

describe('decideApproval', () => {
  it('posts the bearer decision with the exact binding', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')
    await client.decideApproval({
      subjectToken: 'user-session-token',
      approvalId: 'ch-1',
      binding: 'abcd',
      decision: 'approved',
      reason: 'refund reviewed',
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('http://sts:8080/step-up/ch-1/decision')
    expect(init.headers.Authorization).toBe('Bearer user-session-token')
    expect(JSON.parse(init.body as string)).toEqual({ decision: 'approved', binding: 'abcd', reason: 'refund reviewed' })
  })

  it('requires subjectToken, approvalId, and binding', async () => {
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')
    await expect(client.decideApproval({ subjectToken: '', approvalId: 'ch-1', binding: 'x', decision: 'approved' })).rejects.toThrow(
      'requires',
    )
  })
})
