// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// ControlClient unit tests covering scoped token minting, invoke dispatch, and secret-safe error handling.

import { describe, it, expect, vi } from 'vitest'
import { ControlClient, ControlClientError, type ControlClientOptions } from '../../../../packages/admin/ts/src/control.js'

function options(overrides: Partial<ControlClientOptions> = {}): ControlClientOptions {
  return {
    stsUrl: 'https://sts.example.com',
    controlUrl: 'https://api.example.com',
    audience: 'caracal-control',
    applicationId: 'app-operator',
    clientSecret: 'cs_super_secret',
    ...overrides,
  }
}

function client(overrides: Partial<ControlClientOptions> = {}, fetchMock?: ReturnType<typeof vi.fn>): ControlClient {
  return new ControlClient({ ...options(overrides), fetchImpl: fetchMock as unknown as typeof fetch })
}

function tokenResponse(token = 'tok-123'): Response {
  return new Response(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: 300 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function invokeResponse(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('ControlClient invoke', () => {
  it('mints a token scoped to exactly the requested scopes, then invokes the control command', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(invokeResponse([{ id: 'z1' }]))

    const result = await client({}, fetchMock).invoke('zone', 'list', {}, ['control:zone:read'])

    expect(result).toEqual([{ id: 'z1' }])
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(tokenUrl).toBe('https://sts.example.com/oauth/2/token')
    const form = new URLSearchParams(tokenInit.body as string)
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange')
    expect(form.get('application_id')).toBe('app-operator')
    expect(form.get('resource')).toBe('caracal-control')
    expect(form.get('scope')).toBe('control:zone:read')

    const [invokeUrl, invokeInit] = fetchMock.mock.calls[1]! as [string, RequestInit]
    expect(invokeUrl).toBe('https://api.example.com/v1/control/invoke')
    expect((invokeInit.headers as Record<string, string>).authorization).toBe('Bearer tok-123')
    expect(JSON.parse(invokeInit.body as string)).toEqual({ command: 'zone', subcommand: 'list', flags: {} })
  })

  it('joins multiple scopes and forwards the requested ttl', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(invokeResponse({ ok: true }))

    await client({ ttlSeconds: 60 }, fetchMock).invoke('grant', 'create', { 'application-id': 'a' }, [
      'control:grant:write',
      'control:grant:read',
    ])

    const form = new URLSearchParams((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    expect(form.get('scope')).toBe('control:grant:write control:grant:read')
    expect(form.get('ttl_seconds')).toBe('60')
  })

  it('applies one total deadline signal to token mint and invoke', async () => {
    const signals: AbortSignal[] = []
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal)
      return signals.length === 1 ? tokenResponse() : invokeResponse({ ok: true })
    })

    await client({ timeoutMs: 1_000 }, fetchMock).invoke('zone', 'list', {}, ['control:zone:read'])

    expect(signals).toHaveLength(2)
    expect(signals[0]).toBe(signals[1])
    expect(signals[0]).toBeInstanceOf(AbortSignal)
  })

  it('normalizes a total-deadline abort as an outcome-ambiguous invoke failure', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) return tokenResponse()
      await new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }))
      return invokeResponse(null)
    })

    const error = await client({ timeoutMs: 5 }, fetchMock)
      .invoke('zone', 'create', { name: 'x' }, ['control:zone:write'])
      .catch((err) => err)

    expect(error).toBeInstanceOf(ControlClientError)
    expect(error.stage).toBe('invoke')
    expect(error.status).toBe(0)
    expect(error.definitive).toBe(false)
  })

  it('rides the configured authorizing actor in the invoke body when set', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(invokeResponse({ ok: true }))

    await client({ authorizedBy: 'account-7' }, fetchMock).invoke('grant', 'create', { 'application-id': 'a' }, ['control:grant:write'])

    expect(JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string)).toEqual({
      command: 'grant',
      subcommand: 'create',
      flags: { 'application-id': 'a' },
      authorized_by: 'account-7',
    })
  })

  it('trims trailing slashes from the configured base urls', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(invokeResponse(null))

    await client({ stsUrl: 'https://sts.example.com/', controlUrl: 'https://api.example.com/' }, fetchMock).invoke('zone', 'list', {}, [
      'control:zone:read',
    ])

    expect(fetchMock.mock.calls[0]![0]).toBe('https://sts.example.com/oauth/2/token')
    expect(fetchMock.mock.calls[1]![0]).toBe('https://api.example.com/v1/control/invoke')
  })

  it('raises a token-stage error and never calls invoke when the exchange is denied', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'access_denied', reason: 'policy denied' } }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const error = await client({}, fetchMock)
      .invoke('zone', 'create', { name: 'x' }, ['control:zone:write'])
      .catch((e) => e)
    expect(error).toBeInstanceOf(ControlClientError)
    expect(error.stage).toBe('token')
    expect(error.status).toBe(403)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('raises an invoke-stage error carrying the structured control denial', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error: { code: 'denied', reason: 'missing scope control:zone:write' } }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
      )

    const error = await client({}, fetchMock)
      .invoke('zone', 'create', { name: 'x' }, ['control:zone:read'])
      .catch((e) => e)
    expect(error).toBeInstanceOf(ControlClientError)
    expect(error.stage).toBe('invoke')
    expect(error.code).toBe('denied')
    expect(error.reason).toBe('missing scope control:zone:write')
  })

  it('treats an empty access_token as a token failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: '' }), { status: 200, headers: { 'content-type': 'application/json' } }),
      )
    await expect(client({}, fetchMock).invoke('zone', 'list', {}, ['control:zone:read'])).rejects.toBeInstanceOf(ControlClientError)
  })

  it('does not retry a transient token response', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('upstream boom', { status: 502 }))

    await expect(client({}, fetchMock).invoke('zone', 'list', {}, ['control:zone:read'])).rejects.toBeInstanceOf(ControlClientError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry a thrown token network failure', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed'))

    await expect(client({}, fetchMock).invoke('zone', 'list', {}, ['control:zone:read'])).rejects.toBeInstanceOf(ControlClientError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry a denied token exchange', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'access_denied', reason: 'policy denied' } }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    )

    await expect(client({}, fetchMock).invoke('zone', 'list', {}, ['control:zone:read'])).rejects.toBeInstanceOf(ControlClientError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('never retries an invoke failure: the mutation may already have applied', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response('gateway timeout', { status: 504 }))

    const error = await client({}, fetchMock)
      .invoke('zone', 'create', { name: 'x' }, ['control:zone:write'])
      .catch((e) => e)
    expect(error.stage).toBe('invoke')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('normalizes a thrown invoke network failure into the taxonomy as status 0', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(tokenResponse()).mockRejectedValueOnce(new TypeError('socket hang up'))

    const error = await client({}, fetchMock)
      .invoke('zone', 'create', { name: 'x' }, ['control:zone:write'])
      .catch((e) => e)
    expect(error).toBeInstanceOf(ControlClientError)
    expect(error.stage).toBe('invoke')
    expect(error.status).toBe(0)
    expect(error.reason).toContain('socket hang up')
  })

  it('classifies definitive failures: token always, invoke only on a client error', () => {
    expect(new ControlClientError('token', 503, 'unavailable').definitive).toBe(true)
    expect(new ControlClientError('token', 0, 'network').definitive).toBe(true)
    expect(new ControlClientError('invoke', 403, 'denied').definitive).toBe(true)
    expect(new ControlClientError('invoke', 504, 'timeout').definitive).toBe(false)
    expect(new ControlClientError('invoke', 0, 'network').definitive).toBe(false)
  })

  it('keeps the client secret out of error surfaces', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('upstream boom', { status: 502 }))
      .mockResolvedValueOnce(new Response('upstream boom', { status: 502 }))
    const error = await client({}, fetchMock)
      .invoke('zone', 'list', {}, ['control:zone:read'])
      .catch((e) => e)
    expect(error).toBeInstanceOf(ControlClientError)
    expect(JSON.stringify({ message: error.message, reason: error.reason })).not.toContain('cs_super_secret')
  })
})
