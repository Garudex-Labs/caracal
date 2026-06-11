// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Delegated grant route unit tests for same-zone references and scope boundaries.

import { afterEach, describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { loadZoneKek, seal } from '@caracalai/core'
import { grantsRoutes } from '../../../../../apps/api/src/routes/grants.js'
import { buildRouteApp } from '../../../../shared/test-utils/typescript/fastify.js'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))
vi.mock('node:https', () => ({ request: vi.fn() }))

// Test-only deterministic KEK fixture (32-byte hex). Never use in production.
process.env.ZONE_KEK = '8f3d9a71c2b44e5f96a103d7be28cc41d5f09ab6731e4c8f2a7db56019ce34af'

const grantBody = {
  application_id: 'app-1',
  user_id: 'user-1',
  resource_id: 'res-1',
  scopes: ['read'],
}

function sealedSecretConfig(config: Record<string, string>): { ciphertext: Buffer; nonce: Buffer } {
  return seal(loadZoneKek(), Buffer.from(JSON.stringify(config), 'utf8'))
}

function mockProviderTokenResponse(
  body: Record<string, unknown>,
  statusCode = 200,
): { bodies: string[]; options: Record<string, unknown>[] } {
  const bodies: string[] = []
  const options: Record<string, unknown>[] = []
  vi.mocked(httpsRequest).mockImplementation((_url, opts, callback) => {
    options.push(opts as Record<string, unknown>)
    const req = new EventEmitter() as EventEmitter & { write: (chunk: string) => void; end: () => void; destroy: (err?: Error) => void }
    req.write = (chunk: string) => {
      bodies.push(String(chunk))
    }
    req.end = () => {
      const res = new EventEmitter() as EventEmitter & { statusCode: number; setEncoding: () => void; destroy: (err?: Error) => void }
      res.statusCode = statusCode
      res.setEncoding = () => undefined
      res.destroy = (err?: Error) => {
        if (err) res.emit('error', err)
      }
      queueMicrotask(() => {
        callback(res)
        res.emit('data', JSON.stringify(body))
        res.emit('end')
      })
    }
    req.destroy = (err?: Error) => {
      if (err) req.emit('error', err)
    }
    return req
  })
  return { bodies, options }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('POST /v1/zones/:zoneId/grants', () => {
  it('rejects application references outside the zone', async () => {
    const { app, db } = buildRouteApp(grantsRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ application_exists: false, resource_scopes: ['read'] }] })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/grants', payload: grantBody })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'application_not_found' })
  })

  it('rejects resource references outside the zone', async () => {
    const { app, db } = buildRouteApp(grantsRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ application_exists: true, resource_scopes: null }] })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/grants', payload: grantBody })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'resource_not_found' })
  })

  it('rejects grant scopes outside the resource scope set', async () => {
    const { app, db } = buildRouteApp(grantsRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ application_exists: true, resource_scopes: ['read'] }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/grants',
      payload: { ...grantBody, scopes: ['write'] },
    })

    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'grant_scopes_exceed_resource' })
  })

  it('creates a grant with same-zone references and bounded scopes', async () => {
    const { app, db } = buildRouteApp(grantsRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ application_exists: true, resource_scopes: ['read', 'write'] }] })
      .mockResolvedValueOnce({ rows: [{ id: 'grant-1', zone_id: 'z1', scopes: ['read'] }] })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/grants', payload: grantBody })

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'grant-1', scopes: ['read'] })
  })
})

describe('POST /v1/zones/:zoneId/provider-grants', () => {
  it('rejects invalid provider grant payloads and missing zones', async () => {
    const invalid = buildRouteApp(grantsRoutes)
    invalid.db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    await invalid.app.ready()
    const invalidRes = await invalid.app.inject({
      method: 'POST',
      url: '/v1/zones/z1/provider-grants',
      payload: { user_id: 'user-1' },
    })
    expect(invalidRes.statusCode).toBe(400)

    const missingZone = buildRouteApp(grantsRoutes)
    missingZone.db.query.mockResolvedValueOnce({ rows: [] })
    await missingZone.app.ready()
    const missingZoneRes = await missingZone.app.inject({
      method: 'POST',
      url: '/v1/zones/z1/provider-grants',
      payload: {
        user_id: 'user-1',
        resource_id: 'res-1',
        provider_id: 'provider-1',
        scopes: ['read'],
        access_token: 'token',
      },
    })
    expect(missingZoneRes.statusCode).toBe(404)
    expect(JSON.parse(missingZoneRes.body)).toMatchObject({ error: 'zone_not_found' })
  })

  it('rejects unsupported providers, resource mismatches, and oversized scopes', async () => {
    const unsupported = buildRouteApp(grantsRoutes)
    unsupported.db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ provider_kind: 'api_key', resource_scopes: ['read'], resource_provider_id: 'provider-1' }] })
    await unsupported.app.ready()
    const unsupportedRes = await unsupported.app.inject({
      method: 'POST',
      url: '/v1/zones/z1/provider-grants',
      payload: {
        user_id: 'user-1',
        resource_id: 'res-1',
        provider_id: 'provider-1',
        scopes: ['read'],
        access_token: 'token',
      },
    })
    expect(unsupportedRes.statusCode).toBe(400)
    expect(JSON.parse(unsupportedRes.body)).toMatchObject({ error: 'provider_grant_unsupported' })

    const mismatch = buildRouteApp(grantsRoutes)
    mismatch.db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }).mockResolvedValueOnce({
      rows: [{ provider_kind: 'oauth2_authorization_code', resource_scopes: ['read'], resource_provider_id: 'other-provider' }],
    })
    await mismatch.app.ready()
    const mismatchRes = await mismatch.app.inject({
      method: 'POST',
      url: '/v1/zones/z1/provider-grants',
      payload: {
        user_id: 'user-1',
        resource_id: 'res-1',
        provider_id: 'provider-1',
        scopes: ['read'],
        access_token: 'token',
      },
    })
    expect(mismatchRes.statusCode).toBe(400)
    expect(JSON.parse(mismatchRes.body)).toMatchObject({ error: 'provider_resource_mismatch' })

    const forbidden = buildRouteApp(grantsRoutes)
    forbidden.db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }).mockResolvedValueOnce({
      rows: [{ provider_kind: 'oauth2_authorization_code', resource_scopes: ['read'], resource_provider_id: 'provider-1' }],
    })
    await forbidden.app.ready()
    const forbiddenRes = await forbidden.app.inject({
      method: 'POST',
      url: '/v1/zones/z1/provider-grants',
      payload: {
        user_id: 'user-1',
        resource_id: 'res-1',
        provider_id: 'provider-1',
        scopes: ['write'],
        access_token: 'token',
      },
    })
    expect(forbiddenRes.statusCode).toBe(403)
    expect(JSON.parse(forbiddenRes.body)).toMatchObject({ error: 'grant_scopes_exceed_resource' })
  })

  it('stores delegated provider tokens only for matching authorization-code resources', async () => {
    const { app, db } = buildRouteApp(grantsRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            provider_kind: 'oauth2_authorization_code',
            resource_scopes: ['read', 'write'],
            resource_provider_id: 'provider-1',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'provider-grant-1', zone_id: 'z1', provider_id: 'provider-1', scopes: ['read'] }],
      })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/provider-grants',
      payload: {
        user_id: 'user-1',
        resource_id: 'res-1',
        provider_id: 'provider-1',
        scopes: ['read'],
        access_token: 'provider-access',
        refresh_token: 'provider-refresh',
      },
    })

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'provider-grant-1', provider_id: 'provider-1' })
    expect(String(db.query.mock.calls[2][0])).toContain('ON CONFLICT (zone_id, user_id, resource_id, provider_id)')
    const values = db.query.mock.calls[2][1] as unknown[]
    expect(values[6]).toBeInstanceOf(Buffer)
    expect(values[7]).toBeInstanceOf(Buffer)
  })
})

describe('OAuth provider grant browser flow', () => {
  it('creates a provider authorization URL with state and PKCE', async () => {
    const { app, db, redis } = buildRouteApp(grantsRoutes)
    redis.set.mockResolvedValue('OK')
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }).mockResolvedValueOnce({
      rows: [
        {
          id: 'provider-1',
          provider_kind: 'oauth2_authorization_code',
          config_json: {
            authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
            token_endpoint: 'https://oauth2.googleapis.com/token',
            redirect_uri: 'http://localhost:3000/v1/zones/z1/provider-grants/oauth/callback',
            client_id: 'google-client',
            client_auth_method: 'client_secret_basic',
            scopes: ['https://www.googleapis.com/auth/drive.readonly'],
            allowed_token_hosts: ['oauth2.googleapis.com'],
            authorization_params: { access_type: 'offline', prompt: 'consent' },
          },
          secret_config_ct: null,
          secret_config_nonce: null,
          resource_scopes: ['read', 'write'],
          resource_provider_id: 'provider-1',
        },
      ],
    })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/provider-grants/oauth/authorize',
      payload: {
        user_id: 'user-1',
        resource_id: 'res-1',
        provider_id: 'provider-1',
        scopes: ['read'],
      },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { authorization_url: string; state: string }
    const url = new URL(body.authorization_url)
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('google-client')
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.readonly')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe(body.state)
    expect(redis.set).toHaveBeenCalledWith(`api:provider_oauth_state:${body.state}`, expect.any(String), 'EX', 600)
  })

  it('rejects authorization setup with invalid provider configuration', async () => {
    const { app, db } = buildRouteApp(grantsRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }).mockResolvedValueOnce({
      rows: [
        {
          id: 'provider-1',
          provider_kind: 'oauth2_authorization_code',
          config_json: {
            authorization_endpoint: 'http://accounts.example.com/auth',
            redirect_uri: 'http://localhost/cb',
            client_id: 'client',
          },
          secret_config_ct: null,
          secret_config_nonce: null,
          resource_scopes: ['read'],
          resource_provider_id: 'provider-1',
        },
      ],
    })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/provider-grants/oauth/authorize',
      payload: {
        user_id: 'user-1',
        resource_id: 'res-1',
        provider_id: 'provider-1',
        scopes: ['read'],
      },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'provider_authorization_endpoint_invalid' })
  })

  it('exchanges callback authorization codes and stores provider grants', async () => {
    const { app, db, redis } = buildRouteApp(grantsRoutes)
    const state = 'abcdefghijklmnopqrstuvwxyz1234567890'
    const sealed = sealedSecretConfig({ client_secret: 'google-secret' })
    redis.call.mockResolvedValue(
      JSON.stringify({
        zone_id: 'z1',
        user_id: 'user-1',
        resource_id: 'res-1',
        provider_id: 'provider-1',
        scopes: ['read'],
        code_verifier: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890-._~',
      }),
    )
    db.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'provider-1',
            provider_kind: 'oauth2_authorization_code',
            config_json: {
              token_endpoint: 'https://oauth2.googleapis.com/token',
              redirect_uri: 'http://localhost:3000/v1/zones/z1/provider-grants/oauth/callback',
              client_id: 'google-client',
              client_auth_method: 'client_secret_basic',
              allowed_token_hosts: ['oauth2.googleapis.com'],
              token_params: { tenant: 'hooli' },
            },
            secret_config_ct: sealed.ciphertext,
            secret_config_nonce: sealed.nonce,
            resource_scopes: ['read', 'write'],
            resource_provider_id: 'provider-1',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'provider-grant-1', zone_id: 'z1', provider_id: 'provider-1', scopes: ['read'] }],
      })
    vi.mocked(lookup).mockResolvedValue([{ address: '142.250.0.1', family: 4 }])
    const exchange = mockProviderTokenResponse({ access_token: 'google-access', refresh_token: 'google-refresh', expires_in: 3600 })

    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: `/v1/zones/z1/provider-grants/oauth/callback?state=${state}&code=provider-code`,
    })

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'provider-grant-1', provider_id: 'provider-1' })
    expect(redis.call).toHaveBeenCalledWith('GETDEL', `api:provider_oauth_state:${state}`)
    expect(String(db.query.mock.calls[1][0])).toContain('ON CONFLICT (zone_id, user_id, resource_id, provider_id)')
    const values = db.query.mock.calls[1][1] as unknown[]
    expect(values[6]).toBeInstanceOf(Buffer)
    expect(values[7]).toBeInstanceOf(Buffer)
    expect(httpsRequest).toHaveBeenCalledOnce()
    expect(exchange.options[0].method).toBe('POST')
    expect((exchange.options[0].headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('google-client:google-secret').toString('base64')}`,
    )
    const body = new URLSearchParams(exchange.bodies[0])
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('provider-code')
    expect(body.get('code_verifier')).toBe('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890-._~')
    expect(body.get('tenant')).toBe('hooli')
  })

  it('rejects callback token exchanges outside the provider host allow-list', async () => {
    const { app, db, redis } = buildRouteApp(grantsRoutes)
    const state = 'abcdefghijklmnopqrstuvwxyz1234567890'
    redis.call.mockResolvedValue(
      JSON.stringify({
        zone_id: 'z1',
        user_id: 'user-1',
        resource_id: 'res-1',
        provider_id: 'provider-1',
        scopes: ['read'],
        code_verifier: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890-._~',
      }),
    )
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'provider-1',
          provider_kind: 'oauth2_authorization_code',
          config_json: {
            token_endpoint: 'https://oauth2.googleapis.com/token',
            redirect_uri: 'http://localhost:3000/v1/zones/z1/provider-grants/oauth/callback',
            client_id: 'google-client',
            client_auth_method: 'none',
            allowed_token_hosts: ['login.example.com'],
          },
          secret_config_ct: null,
          secret_config_nonce: null,
          resource_scopes: ['read'],
          resource_provider_id: 'provider-1',
        },
      ],
    })
    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: `/v1/zones/z1/provider-grants/oauth/callback?state=${state}&code=provider-code`,
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'provider_token_endpoint_not_allowed' })
    expect(httpsRequest).not.toHaveBeenCalled()
  })

  it('rejects callback token endpoints that resolve to private addresses', async () => {
    const { app, db, redis } = buildRouteApp(grantsRoutes)
    const state = 'abcdefghijklmnopqrstuvwxyz1234567890'
    const sealed = sealedSecretConfig({ client_secret: 'google-secret' })
    redis.call.mockResolvedValue(
      JSON.stringify({
        zone_id: 'z1',
        user_id: 'user-1',
        resource_id: 'res-1',
        provider_id: 'provider-1',
        scopes: ['read'],
        code_verifier: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890-._~',
      }),
    )
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'provider-1',
          provider_kind: 'oauth2_authorization_code',
          config_json: {
            token_endpoint: 'https://oauth2.googleapis.com/token',
            redirect_uri: 'http://localhost:3000/v1/zones/z1/provider-grants/oauth/callback',
            client_id: 'google-client',
            client_auth_method: 'client_secret_basic',
            allowed_token_hosts: ['oauth2.googleapis.com'],
          },
          secret_config_ct: sealed.ciphertext,
          secret_config_nonce: sealed.nonce,
          resource_scopes: ['read'],
          resource_provider_id: 'provider-1',
        },
      ],
    })
    vi.mocked(lookup).mockResolvedValue([{ address: '127.0.0.1', family: 4 }])

    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: `/v1/zones/z1/provider-grants/oauth/callback?state=${state}&code=provider-code`,
    })

    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'provider_token_exchange_failed' })
    expect(httpsRequest).not.toHaveBeenCalled()
  })

  it('rejects callback token endpoints that resolve to NAT64-embedded metadata addresses', async () => {
    const { app, db, redis } = buildRouteApp(grantsRoutes)
    const state = 'abcdefghijklmnopqrstuvwxyz1234567890'
    const sealed = sealedSecretConfig({ client_secret: 'google-secret' })
    redis.call.mockResolvedValue(
      JSON.stringify({
        zone_id: 'z1',
        user_id: 'user-1',
        resource_id: 'res-1',
        provider_id: 'provider-1',
        scopes: ['read'],
        code_verifier: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890-._~',
      }),
    )
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'provider-1',
          provider_kind: 'oauth2_authorization_code',
          config_json: {
            token_endpoint: 'https://oauth2.googleapis.com/token',
            redirect_uri: 'http://localhost:3000/v1/zones/z1/provider-grants/oauth/callback',
            client_id: 'google-client',
            client_auth_method: 'client_secret_basic',
            allowed_token_hosts: ['oauth2.googleapis.com'],
          },
          secret_config_ct: sealed.ciphertext,
          secret_config_nonce: sealed.nonce,
          resource_scopes: ['read'],
          resource_provider_id: 'provider-1',
        },
      ],
    })
    vi.mocked(lookup).mockResolvedValue([{ address: '64:ff9b::a9fe:a9fe', family: 6 }])

    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: `/v1/zones/z1/provider-grants/oauth/callback?state=${state}&code=provider-code`,
    })

    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'provider_token_exchange_failed' })
    expect(httpsRequest).not.toHaveBeenCalled()
  })

  it('rejects callback token endpoints that resolve to IPv4-mapped metadata addresses', async () => {
    const { app, db, redis } = buildRouteApp(grantsRoutes)
    const state = 'abcdefghijklmnopqrstuvwxyz1234567890'
    const sealed = sealedSecretConfig({ client_secret: 'google-secret' })
    redis.call.mockResolvedValue(
      JSON.stringify({
        zone_id: 'z1',
        user_id: 'user-1',
        resource_id: 'res-1',
        provider_id: 'provider-1',
        scopes: ['read'],
        code_verifier: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890-._~',
      }),
    )
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'provider-1',
          provider_kind: 'oauth2_authorization_code',
          config_json: {
            token_endpoint: 'https://oauth2.googleapis.com/token',
            redirect_uri: 'http://localhost:3000/v1/zones/z1/provider-grants/oauth/callback',
            client_id: 'google-client',
            client_auth_method: 'client_secret_basic',
            allowed_token_hosts: ['oauth2.googleapis.com'],
          },
          secret_config_ct: sealed.ciphertext,
          secret_config_nonce: sealed.nonce,
          resource_scopes: ['read'],
          resource_provider_id: 'provider-1',
        },
      ],
    })
    vi.mocked(lookup).mockResolvedValue([{ address: '::ffff:169.254.169.254', family: 6 }])

    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: `/v1/zones/z1/provider-grants/oauth/callback?state=${state}&code=provider-code`,
    })

    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'provider_token_exchange_failed' })
    expect(httpsRequest).not.toHaveBeenCalled()
  })

  it('renders browser-facing callback success pages', async () => {
    const { app, db, redis } = buildRouteApp(grantsRoutes)
    const state = 'abcdefghijklmnopqrstuvwxyz1234567890'
    const sealed = sealedSecretConfig({ client_secret: 'google-secret' })
    redis.call.mockResolvedValue(
      JSON.stringify({
        zone_id: 'z1',
        user_id: 'user-1',
        resource_id: 'res-1',
        provider_id: 'provider-1',
        scopes: ['read'],
        code_verifier: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890-._~',
      }),
    )
    db.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'provider-1',
            provider_kind: 'oauth2_authorization_code',
            config_json: {
              token_endpoint: 'https://oauth2.googleapis.com/token',
              redirect_uri: 'http://localhost:3000/v1/zones/z1/provider-grants/oauth/callback',
              client_id: 'google-client',
              client_auth_method: 'client_secret_basic',
              allowed_token_hosts: ['oauth2.googleapis.com'],
            },
            secret_config_ct: sealed.ciphertext,
            secret_config_nonce: sealed.nonce,
            resource_scopes: ['read'],
            resource_provider_id: 'provider-1',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'provider-grant-1', zone_id: 'z1', provider_id: 'provider-1', scopes: ['read'] }],
      })
    vi.mocked(lookup).mockResolvedValue([{ address: '142.250.0.1', family: 4 }])
    mockProviderTokenResponse({ access_token: 'google-access', refresh_token: 'google-refresh', expires_in: 3600 })

    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: `/v1/zones/z1/provider-grants/oauth/callback?state=${state}&code=provider-code`,
      headers: { accept: 'text/html' },
    })

    expect(res.statusCode).toBe(201)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain('OAuth provider connected')
  })

  it('handles expired, denied, and malformed callback state without provider calls', async () => {
    const expired = buildRouteApp(grantsRoutes)
    expired.redis.call.mockResolvedValue(null)
    await expired.app.ready()
    const expiredRes = await expired.app.inject({
      method: 'GET',
      url: '/v1/zones/z1/provider-grants/oauth/callback?state=abcdefghijklmnopqrstuvwxyz1234567890&code=provider-code',
    })
    expect(expiredRes.statusCode).toBe(400)
    expect(JSON.parse(expiredRes.body)).toMatchObject({ error: 'oauth_state_expired' })

    const invalid = buildRouteApp(grantsRoutes)
    invalid.redis.call.mockResolvedValue('{')
    await invalid.app.ready()
    const invalidRes = await invalid.app.inject({
      method: 'GET',
      url: '/v1/zones/z1/provider-grants/oauth/callback?state=abcdefghijklmnopqrstuvwxyz1234567890&code=provider-code',
    })
    expect(invalidRes.statusCode).toBe(400)
    expect(JSON.parse(invalidRes.body)).toMatchObject({ error: 'oauth_state_invalid' })

    const denied = buildRouteApp(grantsRoutes)
    denied.redis.call.mockResolvedValue(
      JSON.stringify({
        zone_id: 'z1',
        user_id: 'user-1',
        resource_id: 'res-1',
        provider_id: 'provider-1',
        scopes: ['read'],
        code_verifier: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890-._~',
      }),
    )
    await denied.app.ready()
    const deniedRes = await denied.app.inject({
      method: 'GET',
      url: '/v1/zones/z1/provider-grants/oauth/callback?state=abcdefghijklmnopqrstuvwxyz1234567890&error=access_denied',
      headers: { accept: 'text/html' },
    })
    expect(deniedRes.statusCode).toBe(400)
    expect(deniedRes.headers['content-type']).toContain('text/html')
    expect(deniedRes.body).toContain('OAuth authorization denied')
    expect(httpsRequest).not.toHaveBeenCalled()
  })
})

describe('POST /v1/zones/:zoneId/provider-grants/revoke', () => {
  it('revokes the active provider grant for a user resource provider binding', async () => {
    const { app, db } = buildRouteApp(grantsRoutes)
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'provider-grant-1', zone_id: 'z1', provider_id: 'provider-1', status: 'revoked' }],
    })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/provider-grants/revoke',
      payload: {
        user_id: 'user-1',
        resource_id: 'res-1',
        provider_id: 'provider-1',
      },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'provider-grant-1', status: 'revoked' })
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("status = 'revoked'"), ['z1', 'user-1', 'res-1', 'provider-1'])
  })

  it('returns 404 when there is no active provider grant to revoke', async () => {
    const { app, db } = buildRouteApp(grantsRoutes)
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/provider-grants/revoke',
      payload: {
        user_id: 'user-1',
        resource_id: 'res-1',
        provider_id: 'provider-1',
      },
    })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'provider_grant_not_found' })
  })
})

describe('DELETE /v1/zones/:zoneId/grants/:id bounded session revocation', () => {
  it('returns 404 when the delegated grant is missing', async () => {
    const { app, db } = buildRouteApp(grantsRoutes)
    const client = { query: vi.fn(), release: vi.fn() }
    client.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
    db.connect.mockResolvedValue(client)

    await app.ready()
    const res = await app.inject({ method: 'DELETE', url: '/v1/zones/z1/grants/missing' })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'grant_not_found' })
  })

  it('pages session revocation in batches of 1000 and stops at the short batch', async () => {
    const { app, db } = buildRouteApp(grantsRoutes)

    const fullBatch = Array.from({ length: 1000 }, (_, i) => ({ id: `s${i}` }))
    const tailBatch = [{ id: 's-tail' }]

    const client = {
      query: vi.fn(),
      release: vi.fn(),
    }
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ user_id: 'user-1' }] })
      .mockResolvedValueOnce({ rows: fullBatch })

    for (let i = 0; i < fullBatch.length; i += 1) {
      client.query.mockResolvedValueOnce({ rows: [] })
    }

    client.query.mockResolvedValueOnce({ rows: tailBatch })
    client.query.mockResolvedValueOnce({ rows: [] })
    client.query.mockResolvedValueOnce({ rows: [] })

    db.connect.mockResolvedValue(client)

    await app.ready()
    const res = await app.inject({ method: 'DELETE', url: '/v1/zones/z1/grants/g1' })

    expect(res.statusCode).toBe(204)
    const updates = client.query.mock.calls.filter((c: unknown[]) => /UPDATE sessions SET status = 'revoked'/.test(c[0] as string))
    expect(updates.length).toBe(2)
    const limitArg = (updates[0][1] as unknown[])[2]
    expect(limitArg).toBe(1000)
  })
})

describe('GET /v1/zones/:zoneId/grants list and detail', () => {
  it('lists grants for the zone', async () => {
    const { app, db } = buildRouteApp(grantsRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'grant-1' }, { id: 'grant-2' }] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/grants' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toHaveLength(2)
  })

  it('applies grant list filters and enriches provider context', async () => {
    const { app, db } = buildRouteApp(grantsRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'grant-1', provider_id: 'provider-1' }] })

    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones/z1/grants?application_id=app-1&subject_id=user-1&resource_id=res-1&provider_id=provider-1&status=active&scopes=read,write',
    })

    expect(res.statusCode).toBe(200)
    const [sql, values] = db.query.mock.calls[0]
    expect(sql).toContain('LEFT JOIN applications')
    expect(sql).toContain('r.credential_provider_id = $5')
    expect(sql).toContain('dg.scopes @> $7::text[]')
    expect(values).toEqual(['z1', 'app-1', 'user-1', 'res-1', 'provider-1', 'active', ['read', 'write'], 200])
  })

  it('returns a single grant', async () => {
    const { app, db } = buildRouteApp(grantsRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'grant-1', status: 'active' }] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/grants/grant-1' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'grant-1' })
  })

  it('returns 404 for a missing grant', async () => {
    const { app, db } = buildRouteApp(grantsRoutes)
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/grants/missing' })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'grant_not_found' })
  })
})
