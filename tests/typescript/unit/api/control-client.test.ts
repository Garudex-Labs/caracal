// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the internal control-plane client: scoped token minting, invoke dispatch, and secret-safe error handling.

import { describe, it, expect, vi } from 'vitest'
import { createControlClient, ControlClientError, type ControlClientConfig } from '../../../../apps/api/src/control-client.js'

function config(overrides: Partial<ControlClientConfig> = {}): ControlClientConfig {
  return {
    stsUrl: 'https://sts.example.com',
    controlUrl: 'https://api.example.com',
    audience: 'caracal-control',
    applicationId: 'app-operator',
    clientSecret: 'cs_super_secret',
    ...overrides,
  }
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

describe('createControlClient invoke', () => {
  it('mints a token scoped to exactly the requested scopes, then invokes the control command', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(invokeResponse([{ id: 'z1' }]))
    const client = createControlClient(config(), fetchMock as unknown as typeof fetch)

    const result = await client.invoke('zone', 'list', {}, ['control:zone:read'])

    expect(result).toEqual([{ id: 'z1' }])
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(tokenUrl).toBe('https://sts.example.com/oauth/2/token')
    const form = new URLSearchParams(tokenInit.body as string)
    expect(form.get('grant_type')).toBe('client_credentials')
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
    const client = createControlClient(config({ ttlSeconds: 60 }), fetchMock as unknown as typeof fetch)

    await client.invoke('grant', 'create', { 'application-id': 'a' }, ['control:grant:write', 'control:grant:read'])

    const form = new URLSearchParams((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    expect(form.get('scope')).toBe('control:grant:write control:grant:read')
    expect(form.get('ttl_seconds')).toBe('60')
  })

  it('rides the configured authorizing actor in the invoke body when set', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(invokeResponse({ ok: true }))
    const client = createControlClient(config({ authorizedBy: 'account-7' }), fetchMock as unknown as typeof fetch)

    await client.invoke('grant', 'create', { 'application-id': 'a' }, ['control:grant:write'])

    expect(JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string)).toEqual({
      command: 'grant',
      subcommand: 'create',
      flags: { 'application-id': 'a' },
      authorized_by: 'account-7',
    })
  })

  it('trims trailing slashes from the configured base urls', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(invokeResponse(null))
    const client = createControlClient(
      config({ stsUrl: 'https://sts.example.com/', controlUrl: 'https://api.example.com/' }),
      fetchMock as unknown as typeof fetch,
    )

    await client.invoke('zone', 'list', {}, ['control:zone:read'])

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
    const client = createControlClient(config(), fetchMock as unknown as typeof fetch)

    const error = await client.invoke('zone', 'create', { name: 'x' }, ['control:zone:write']).catch((e) => e)
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
    const client = createControlClient(config(), fetchMock as unknown as typeof fetch)

    const error = await client.invoke('zone', 'create', { name: 'x' }, ['control:zone:read']).catch((e) => e)
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
    const client = createControlClient(config(), fetchMock as unknown as typeof fetch)
    await expect(client.invoke('zone', 'list', {}, ['control:zone:read'])).rejects.toBeInstanceOf(ControlClientError)
  })

  it('keeps the client secret out of error surfaces', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('upstream boom', { status: 502 }))
    const client = createControlClient(config(), fetchMock as unknown as typeof fetch)
    const error = await client.invoke('zone', 'list', {}, ['control:zone:read']).catch((e) => e)
    expect(JSON.stringify({ message: error.message, reason: error.reason })).not.toContain('cs_super_secret')
  })
})
