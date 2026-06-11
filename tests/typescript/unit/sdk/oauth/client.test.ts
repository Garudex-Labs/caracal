// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// OAuthClient unit tests: exchange, cache hit, 401-retry, interaction_required.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OAuthClient } from '../../../../../packages/oauth/ts/src/client.js'
import { InteractionRequiredError } from '../../../../../packages/oauth/ts/src/types.js'

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
    expect(body.get('runtime_credential_injection')).toBeNull()
  })

  it('sends runtime credential injection requests and returns upstream directives', async () => {
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
    const res = await client.exchange('', 'resource://openai', {
      clientSecret: 'secret-1',
      runtimeCredentialInjection: true,
    })

    const body = fetchMock.mock.calls[0][1].body as URLSearchParams
    expect(body.get('runtime_credential_injection')).toBe('true')
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

  it('throws InteractionRequiredError on interaction_required', async () => {
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
    expect(err).toBeInstanceOf(InteractionRequiredError)
    expect(err.challengeId).toBe('chal-1')
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

  it('sends assertion, actor, session, agent session, and delegation edge fields', async () => {
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
      actorToken: 'actor-1',
      sessionId: 'session-1',
      agentSessionId: 'agent-session-1',
      delegationEdgeId: 'edge-1',
    })
    const body = fetchMock.mock.calls[0][1].body as URLSearchParams
    expect(body.get('client_assertion')).toBe('assertion-1')
    expect(body.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer')
    expect(body.get('actor_token')).toBe('actor-1')
    expect(body.get('session_id')).toBe('session-1')
    expect(body.get('agent_session_id')).toBe('agent-session-1')
    expect(body.get('delegation_edge_id')).toBe('edge-1')
  })

  it('does not share cache across delegation edges', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'tok-edge', expires_in: 900 }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')
    await client.exchange('subject-a', 'resource://api', { delegationEdgeId: 'edge-a' })
    await client.exchange('subject-a', 'resource://api', { delegationEdgeId: 'edge-b' })
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

  it('does not share cache across agent graph sessions', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'tok-agent-session', expires_in: 900 }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')
    await client.exchange('subject-a', 'resource://api', { agentSessionId: 'agent-a' })
    await client.exchange('subject-a', 'resource://api', { agentSessionId: 'agent-b' })
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

  it('refreshes cached tokens inside the timeout preflight window', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'tok-fresh', expires_in: 20 }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new OAuthClient('http://sts:8080', 'zone1', 'app1')

    await client.exchange('subject-a', 'resource://api', { timeoutMs: 5_000 })
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
})
