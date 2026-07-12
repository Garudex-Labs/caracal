// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Provider route unit tests for zone ownership and configuration updates.

import { afterEach, describe, it, expect, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { SecretBackendError, providerSecretConfigRef } from '@caracalai/server-core'
import { providersRoutes } from '../../../../../apps/api/src/routes/providers.js'
import { isUnsafeIpAddress } from '../../../../../apps/api/src/provider-token.js'
import { buildRouteApp } from '../../../../shared/test-utils/typescript/fastify.js'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))
vi.mock('node:https', () => ({ request: vi.fn() }))

describe('provider private egress policy', () => {
  it('allows explicitly granted private ranges but never metadata or loopback ranges', () => {
    for (const address of ['10.0.0.1', '172.16.0.1', '192.168.0.1', '100.64.0.1', 'fd00::1']) {
      expect(isUnsafeIpAddress(address, true), address).toBe(false)
    }
    for (const address of ['127.0.0.1', '169.254.169.254', '::1', 'fe80::1', '64:ff9b::a9fe:a9fe']) {
      expect(isUnsafeIpAddress(address, true), address).toBe(true)
    }
  })
})

function seedProviderSecret(
  secrets: { values: Map<string, Buffer> },
  values: Record<string, string> = { client_secret: 'hooli-secret' },
): void {
  secrets.values.set(providerSecretConfigRef('z1', 'provider-1'), Buffer.from(JSON.stringify(values), 'utf8'))
}

function mockTokenResponse(body: Record<string, unknown> | string, statusCode: number): string[] {
  const bodies: string[] = []
  vi.mocked(httpsRequest).mockImplementation((_url, _opts, callback) => {
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
        res.emit('data', typeof body === 'string' ? body : JSON.stringify(body))
        res.emit('end')
      })
    }
    req.destroy = (err?: Error) => {
      if (err) req.emit('error', err)
    }
    return req
  })
  return bodies
}

function oauthProviderRow(kind: string, config: Record<string, unknown>): Record<string, unknown> {
  return {
    kind,
    config_json: config,
  }
}

describe('GET /v1/zones/:zoneId/providers/:id', () => {
  it('returns 404 when provider is outside the zone', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/providers/provider-other-zone' })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'provider_not_found' })
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1 AND zone_id = $2'), ['provider-other-zone', 'z1'])
  })
})

describe('POST /v1/zones/:zoneId/providers', () => {
  it('stores provider kind and validated config in provider_kind', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }).mockResolvedValueOnce({
      rows: [{ id: 'provider-1', zone_id: 'z1', identifier: 'provider://oauth-main', kind: 'oauth2_client_credentials' }],
    })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers',
      payload: {
        identifier: 'provider://oauth-main',
        kind: 'oauth2_client_credentials',
        config_json: {
          token_endpoint: 'https://issuer.example/oauth/token',
          client_id: 'hooli-client',
          client_secret: 'hooli-secret',
          scopes: ['pipernet.read'],
          audience: 'https://api.hooli.example',
          resource: 'https://resource.hooli.example',
          allowed_token_hosts: ['issuer.example'],
          allow_runtime_injection: true,
        },
      },
    })

    const values = db.query.mock.calls[1][1] as unknown[]
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'provider-1', kind: 'oauth2_client_credentials' })
    expect(values[4]).toBe('oauth2_client_credentials')
    expect(JSON.parse(values[5] as string)).toEqual({
      token_endpoint: 'https://issuer.example/oauth/token',
      client_id: 'hooli-client',
      client_auth_method: 'client_secret_basic',
      grant_type: 'client_credentials',
      scopes: ['pipernet.read'],
      audience: 'https://api.hooli.example',
      resource: 'https://resource.hooli.example',
      allowed_token_hosts: ['issuer.example'],
      allow_runtime_injection: true,
    })
    expect(values[6]).toEqual(['client_secret'])
  })

  it('stores private-key JWT client credentials with sealed private keys', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }).mockResolvedValueOnce({
      rows: [{ id: 'provider-1', zone_id: 'z1', identifier: 'provider://oauth-main', kind: 'oauth2_client_credentials' }],
    })

    await app.ready()
    const privateKeyPem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    }) as string
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers',
      payload: {
        identifier: 'provider://oauth-main',
        kind: 'oauth2_client_credentials',
        config_json: {
          token_endpoint: 'https://issuer.example/oauth/token',
          client_id: 'hooli-client',
          client_auth_method: 'private_key_jwt',
          key_id: 'key-1',
          private_key: privateKeyPem,
          allowed_token_hosts: ['issuer.example'],
        },
      },
    })

    const values = db.query.mock.calls[1][1] as unknown[]
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(values[5] as string)).toEqual({
      token_endpoint: 'https://issuer.example/oauth/token',
      client_id: 'hooli-client',
      client_auth_method: 'private_key_jwt',
      grant_type: 'client_credentials',
      key_id: 'key-1',
      allowed_token_hosts: ['issuer.example'],
    })
    expect(values[6]).toEqual(['private_key'])
  })

  it('rejects OAuth 2.0 client-credentials providers with invalid endpoint or token parameter config', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValue({ rows: [{ '?column?': 1 }] })

    await app.ready()
    for (const config of [
      {
        token_endpoint: 'http://issuer.example/oauth/token',
        client_id: 'hooli-client',
        client_secret: 'hooli-secret',
        allowed_token_hosts: ['issuer.example'],
      },
      {
        token_endpoint: 'https://issuer.example/oauth/token',
        client_id: 'hooli-client',
        client_secret: 'hooli-secret',
        allowed_token_hosts: ['issuer.example'],
        audience: '',
      },
      {
        token_endpoint: 'https://issuer.example/oauth/token',
        client_id: 'hooli-client',
        client_secret: 'hooli-secret',
        allowed_token_hosts: ['issuer.example'],
        auth_header: 'Authorization Header',
      },
      {
        token_endpoint: 'https://issuer.example/oauth/token',
        client_id: 'hooli-client',
        client_auth_method: 'private_key_jwt',
        allowed_token_hosts: ['issuer.example'],
      },
      {
        token_endpoint: 'https://issuer.example/oauth/token',
        client_id: 'hooli-client',
        client_secret: 'hooli-secret',
        private_key: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----',
        client_auth_method: 'private_key_jwt',
        allowed_token_hosts: ['issuer.example'],
      },
      {
        token_endpoint: 'https://issuer.example/oauth/token',
        client_id: 'hooli-client',
        client_secret: 'hooli-secret',
        key_id: 'key-1',
        allowed_token_hosts: ['issuer.example'],
      },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/zones/z1/providers',
        payload: { identifier: 'provider://hooli-client-creds', kind: 'oauth2_client_credentials', config_json: config },
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_provider_config' })
    }
  })

  it('creates Caracal mandate providers without secret config', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }).mockResolvedValueOnce({
      rows: [{ id: 'provider-1', zone_id: 'z1', identifier: 'provider://caracal-mandate', kind: 'caracal_mandate' }],
    })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers',
      payload: {
        identifier: 'provider://caracal-mandate',
        kind: 'caracal_mandate',
      },
    })

    const values = db.query.mock.calls[1][1] as unknown[]
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'provider-1', kind: 'caracal_mandate' })
    expect(values[4]).toBe('caracal_mandate')
    expect(JSON.parse(values[5] as string)).toEqual({})
    expect(values[6]).toEqual([])
    expect(values[7]).toBeNull()
  })

  it('creates none providers without credential config', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }).mockResolvedValueOnce({
      rows: [{ id: 'provider-1', zone_id: 'z1', identifier: 'provider://none', kind: 'none' }],
    })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers',
      payload: {
        identifier: 'provider://none',
        kind: 'none',
      },
    })

    const values = db.query.mock.calls[1][1] as unknown[]
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'provider-1', kind: 'none' })
    expect(values[4]).toBe('none')
    expect(JSON.parse(values[5] as string)).toEqual({})
    expect(values[6]).toEqual([])
    expect(values[7]).toBeNull()
  })

  it('rejects provider-native config on none providers', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers',
      payload: {
        identifier: 'provider://none',
        kind: 'none',
        config_json: { auth_header: 'Authorization' },
      },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_provider_config' })
  })

  it('rejects provider-native config on Caracal mandate providers', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers',
      payload: {
        identifier: 'provider://mandate-only',
        kind: 'caracal_mandate',
        config_json: {
          auth_header: 'Authorization',
          auth_scheme: 'Bearer',
          forward_caracal_identity: true,
          bearer_token: 'provider-token',
        },
      },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_provider_config' })
  })

  it('stores API key provider headers, schemes, and sealed secrets', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }).mockResolvedValueOnce({
      rows: [{ id: 'provider-1', zone_id: 'z1', identifier: 'provider://hooli-api-key', kind: 'api_key' }],
    })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers',
      payload: {
        identifier: 'provider://hooli-api-key',
        kind: 'api_key',
        config_json: {
          header_name: 'Authorization',
          auth_scheme: 'Bearer',
          allowed_token_hosts: ['api.hooli.example'],
          forward_caracal_identity: true,
          allow_runtime_injection: true,
          api_key: 'hooli-api-key',
        },
      },
    })

    const values = db.query.mock.calls[1][1] as unknown[]
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'provider-1', kind: 'api_key' })
    expect(JSON.parse(values[5] as string)).toEqual({
      auth_location: 'header',
      header_name: 'Authorization',
      auth_scheme: 'Bearer',
      allowed_token_hosts: ['api.hooli.example'],
      forward_caracal_identity: true,
      allow_runtime_injection: true,
    })
    expect(values[6]).toEqual(['api_key'])
  })

  it('stores API key provider query parameter placement and sealed secrets', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }).mockResolvedValueOnce({
      rows: [{ id: 'provider-1', zone_id: 'z1', identifier: 'provider://hooli-weather', kind: 'api_key' }],
    })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers',
      payload: {
        identifier: 'provider://hooli-weather',
        kind: 'api_key',
        config_json: {
          auth_location: 'query',
          query_param_name: 'api_key',
          api_key: 'hooli-api-key',
        },
      },
    })

    const values = db.query.mock.calls[1][1] as unknown[]
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'provider-1', kind: 'api_key' })
    expect(JSON.parse(values[5] as string)).toEqual({
      auth_location: 'query',
      query_param_name: 'api_key',
    })
    expect(values[6]).toEqual(['api_key'])
  })

  it('rejects API key providers with unsupported or malformed forwarding configuration', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValue({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const invalidConfigs: Array<Record<string, unknown>> = [
      {
        header_name: 'Authorization',
        auth_header: 'X-Api-Key',
        api_key: 'hooli-api-key',
      },
      {
        header_name: 'Authorization Header',
        api_key: 'hooli-api-key',
      },
      ...[
        'Host',
        'Connection',
        'Content-Length',
        'Transfer-Encoding',
        'X-Caracal-Identity',
        'X-Forwarded-For',
        'Proxy-Authorization',
        'Traceparent',
        'Baggage',
        'X-Request-Id',
      ].map((header_name) => ({ header_name, api_key: 'hooli-api-key' })),
      {
        header_name: 'Authorization',
        auth_scheme: 'Bearer Token',
        api_key: 'hooli-api-key',
      },
      {
        auth_location: 'query',
        api_key: 'hooli-api-key',
      },
      {
        auth_location: 'query',
        query_param_name: 'api key',
        api_key: 'hooli-api-key',
      },
      {
        auth_location: 'query',
        query_param_name: 'api_key',
        auth_scheme: 'Bearer',
        api_key: 'hooli-api-key',
      },
      {
        auth_location: 'cookie',
        api_key: 'hooli-api-key',
      },
      {
        header_name: 'Authorization',
        allowed_token_hosts: ['not a host'],
        api_key: 'hooli-api-key',
      },
      {
        header_name: 'Authorization',
        allow_runtime_injection: 'yes',
        api_key: 'hooli-api-key',
      },
    ]
    for (const config of invalidConfigs) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/zones/z1/providers',
        payload: { identifier: 'provider://hooli-api-key', kind: 'api_key', config_json: config },
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_provider_config' })
    }
  })

  it('stores bearer token provider routing config and sealed secrets', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }).mockResolvedValueOnce({
      rows: [{ id: 'provider-1', zone_id: 'z1', identifier: 'provider://hooli-bearer', kind: 'bearer_token' }],
    })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers',
      payload: {
        identifier: 'provider://hooli-bearer',
        kind: 'bearer_token',
        config_json: {
          bearer_token: 'hooli-provider-token',
          allowed_token_hosts: ['api.hooli.example'],
          auth_header: 'Authorization',
          auth_scheme: 'Bearer',
          forward_caracal_identity: true,
          allow_runtime_injection: true,
        },
      },
    })

    const values = db.query.mock.calls[1][1] as unknown[]
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'provider-1', kind: 'bearer_token' })
    expect(JSON.parse(values[5] as string)).toEqual({
      allowed_token_hosts: ['api.hooli.example'],
      auth_header: 'Authorization',
      auth_scheme: 'Bearer',
      forward_caracal_identity: true,
      allow_runtime_injection: true,
    })
    expect(values[6]).toEqual(['bearer_token'])
  })

  it('rejects bearer token providers with unsupported or malformed forwarding config', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValue({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const invalidConfigs: Array<Record<string, unknown>> = [
      {
        bearer_token: 'hooli-provider-token',
        header_name: 'Authorization',
      },
      {
        bearer_token: 'hooli-provider-token',
        auth_header: 'Authorization Header',
      },
      ...[
        'Host',
        'Connection',
        'Content-Length',
        'Transfer-Encoding',
        'X-Caracal-Identity',
        'X-Forwarded-For',
        'Proxy-Authorization',
        'Traceparent',
        'Baggage',
        'X-Request-Id',
      ].map((auth_header) => ({ bearer_token: 'hooli-provider-token', auth_header })),
      {
        bearer_token: 'hooli-provider-token',
        auth_scheme: 'Bearer Token',
      },
      {
        bearer_token: 'hooli-provider-token',
        allowed_token_hosts: ['https://api.hooli.example'],
      },
    ]
    for (const config of invalidConfigs) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/zones/z1/providers',
        payload: { identifier: 'provider://hooli-bearer', kind: 'bearer_token', config_json: config },
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_provider_config' })
    }
  })

  it('generates provider identifiers from provider names when omitted', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 'provider-1', zone_id: 'z1', identifier: 'provider://hooli-oauth', kind: 'caracal_mandate' }],
      })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers',
      payload: {
        identifier: '',
        name: 'Hooli OAuth',
        kind: 'caracal_mandate',
        config_json: {},
      },
    })

    const values = db.query.mock.calls[2][1] as unknown[]
    expect(res.statusCode).toBe(201)
    expect(values[2]).toBe('Hooli OAuth')
    expect(values[3]).toBe('provider://hooli-oauth')
  })

  it('suffixes generated provider identifiers when the provider name already exists in the zone', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 'provider-2', zone_id: 'z1', identifier: 'provider://hooli-oauth-2', kind: 'caracal_mandate' }],
      })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers',
      payload: {
        name: 'Hooli OAuth',
        kind: 'caracal_mandate',
        config_json: {},
      },
    })

    const values = db.query.mock.calls[3][1] as unknown[]
    expect(res.statusCode).toBe(201)
    expect(values[3]).toBe('provider://hooli-oauth-2')
  })

  it('rejects duplicate explicit provider identifiers in the zone', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    const conflict = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'providers_zone_identifier_active_uidx',
    })
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }).mockRejectedValueOnce(conflict)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers',
      payload: {
        identifier: 'provider://hooli-oauth',
        name: 'Hooli OAuth',
        kind: 'caracal_mandate',
        config_json: {},
      },
    })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'provider_identifier_conflict' })
  })

  it('rejects unsupported provider config fields', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers',
      payload: {
        identifier: 'provider://oauth-main',
        kind: 'oauth2_client_credentials',
        config_json: { authorization_endpoint: 'https://issuer.example/auth' },
      },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_provider_config' })
  })

  it('stores OAuth 2.0 auth-code provider config with validated callback and forwarding settings', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }).mockResolvedValueOnce({
      rows: [{ id: 'provider-1', zone_id: 'z1', identifier: 'provider://hooli-oidc', kind: 'oauth2_authorization_code' }],
    })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers',
      payload: {
        identifier: 'provider://hooli-oidc',
        kind: 'oauth2_authorization_code',
        config_json: {
          authorization_endpoint: 'https://login.hooli.example/oauth/authorize',
          token_endpoint: 'https://login.hooli.example/oauth/token',
          redirect_uri: 'http://localhost:3000/oauth/callback',
          client_id: 'hooli-client',
          client_secret: 'hooli-secret',
          allowed_token_hosts: ['login.hooli.example'],
          authorization_params: { access_type: 'offline', prompt: 'consent' },
          token_params: { tenant: 'hooli' },
          auth_header: 'Authorization',
          auth_scheme: 'Bearer',
        },
      },
    })

    const values = db.query.mock.calls[1][1] as unknown[]
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(values[5] as string)).toEqual({
      authorization_endpoint: 'https://login.hooli.example/oauth/authorize',
      token_endpoint: 'https://login.hooli.example/oauth/token',
      redirect_uri: 'http://localhost:3000/oauth/callback',
      client_id: 'hooli-client',
      client_auth_method: 'client_secret_basic',
      allowed_token_hosts: ['login.hooli.example'],
      authorization_params: { access_type: 'offline', prompt: 'consent' },
      token_params: { tenant: 'hooli' },
      auth_header: 'Authorization',
      auth_scheme: 'Bearer',
    })
    expect(values[6]).toEqual(['client_secret'])
  })

  it('rejects OAuth 2.0 auth-code providers with invalid URLs, unsupported client auth, or malformed forwarding schemes', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValue({ rows: [{ '?column?': 1 }] })

    await app.ready()
    for (const config of [
      {
        authorization_endpoint: 'http://login.hooli.example/oauth/authorize',
        token_endpoint: 'https://login.hooli.example/oauth/token',
        redirect_uri: 'http://localhost:3000/oauth/callback',
        client_id: 'hooli-client',
        client_secret: 'hooli-secret',
        allowed_token_hosts: ['login.hooli.example'],
      },
      {
        authorization_endpoint: 'https://login.hooli.example/oauth/authorize',
        token_endpoint: 'https://login.hooli.example/oauth/token',
        redirect_uri: '/oauth/callback',
        client_id: 'hooli-client',
        client_secret: 'hooli-secret',
        allowed_token_hosts: ['login.hooli.example'],
      },
      {
        authorization_endpoint: 'https://login.hooli.example/oauth/authorize',
        token_endpoint: 'https://login.hooli.example/oauth/token',
        redirect_uri: 'http://localhost:3000/oauth/callback',
        client_id: 'hooli-client',
        client_secret: 'hooli-secret',
        allowed_token_hosts: ['login.hooli.example'],
        auth_scheme: 'Bearer Token',
      },
      {
        authorization_endpoint: 'https://login.hooli.example/oauth/authorize',
        token_endpoint: 'https://login.hooli.example/oauth/token',
        redirect_uri: 'http://localhost:3000/oauth/callback',
        client_id: 'hooli-client',
        client_secret: 'hooli-secret',
        allowed_token_hosts: ['login.hooli.example'],
        authorization_params: { client_id: 'override' },
      },
      {
        authorization_endpoint: 'https://login.hooli.example/oauth/authorize',
        token_endpoint: 'https://login.hooli.example/oauth/token',
        redirect_uri: 'http://localhost:3000/oauth/callback',
        client_id: 'hooli-client',
        client_secret: 'hooli-secret',
        allowed_token_hosts: ['login.hooli.example'],
        token_params: { grant_type: 'override' },
      },
      {
        authorization_endpoint: 'https://login.hooli.example/oauth/authorize',
        token_endpoint: 'https://login.hooli.example/oauth/token',
        redirect_uri: 'http://localhost:3000/oauth/callback',
        client_id: 'hooli-client',
        client_auth_method: 'private_key_jwt',
        private_key: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----',
        allowed_token_hosts: ['login.hooli.example'],
      },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/zones/z1/providers',
        payload: { identifier: 'provider://hooli-oidc', kind: 'oauth2_authorization_code', config_json: config },
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_provider_config' })
    }
  })

  it('rejects provider identifiers outside the provider namespace', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers',
      payload: { identifier: 'oauth-main', kind: 'caracal_mandate' },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_provider_identifier' })
  })

  it('answers 502 and rolls the insert back when the secret backend rejects the credential write', async () => {
    const { app, db, secrets } = buildRouteApp(providersRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'provider-1', zone_id: 'z1', kind: 'api_key' }] })
    secrets.put.mockRejectedValueOnce(new SecretBackendError('secret backend write failed with status 503'))

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers',
      payload: { identifier: 'provider://piper-api', kind: 'api_key', config_json: { header_name: 'X-Api-Key', api_key: 'piper-key' } },
    })

    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'secret_backend_unavailable' })
    expect(db.connect).toHaveBeenCalled()
    expect(secrets.values.size).toBe(0)
    const issuedStatements = db.query.mock.calls.map((call) => String(call[0]))
    expect(issuedStatements.some((sql) => sql.includes('DELETE FROM providers'))).toBe(false)
  })
})

describe('PATCH /v1/zones/:zoneId/providers/:id', () => {
  it('rejects an empty update body', async () => {
    const { app, db } = buildRouteApp(providersRoutes)

    await app.ready()
    const res = await app.inject({ method: 'PATCH', url: '/v1/zones/z1/providers/provider-1', payload: {} })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'no_fields' })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('replaces provider config with validated provider settings', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'provider-1', zone_id: 'z1', identifier: 'provider://apikey-main', kind: 'api_key' }],
    })

    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1/providers/provider-1',
      payload: { kind: 'api_key', config_json: { header_name: 'X-Api-Key', api_key: 'hooli-api-key' } },
    })

    const values = db.query.mock.calls[0][1] as unknown[]
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'provider-1', kind: 'api_key' })
    expect(values.slice(0, 2)).toEqual(['provider-1', 'z1'])
    expect(values).toContain('api_key')
    expect(JSON.parse(values[3] as string)).toEqual({ auth_location: 'header', header_name: 'X-Api-Key' })
  })

  it('validates config-only patches against the existing provider kind', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ kind: 'oauth2_client_credentials', secret_config_keys: ['client_secret'] }] })
      .mockResolvedValueOnce({
        rows: [{ id: 'provider-1', zone_id: 'z1', identifier: 'provider://oauth-main', kind: 'oauth2_client_credentials' }],
      })

    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1/providers/provider-1',
      payload: {
        config_json: {
          token_endpoint: 'https://issuer.example/oauth/token',
          client_id: 'hooli-client',
          allowed_token_hosts: ['issuer.example'],
        },
      },
    })

    const values = db.query.mock.calls[1][1] as unknown[]
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'provider-1', kind: 'oauth2_client_credentials' })
    expect(values.slice(0, 2)).toEqual(['provider-1', 'z1'])
    expect(JSON.parse(values[2] as string)).toEqual({
      token_endpoint: 'https://issuer.example/oauth/token',
      client_id: 'hooli-client',
      client_auth_method: 'client_secret_basic',
      grant_type: 'client_credentials',
      allowed_token_hosts: ['issuer.example'],
    })
  })

  it('rejects provider identifier edits outside the provider namespace', async () => {
    const { app, db } = buildRouteApp(providersRoutes)

    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1/providers/provider-1',
      payload: { identifier: 'resource://pipernet' },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_provider_identifier' })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('rejects provider identifier patches that conflict in the zone', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    const conflict = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'providers_zone_identifier_active_uidx',
    })
    db.query.mockRejectedValueOnce(conflict)

    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1/providers/provider-1',
      payload: { identifier: 'provider://hooli-oauth2' },
    })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'provider_identifier_conflict' })
  })

  it('answers 502 and rolls the row update back when the secret backend rejects the credential write', async () => {
    const { app, db, secrets } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'provider-1', zone_id: 'z1', kind: 'api_key' }] })
    secrets.put.mockRejectedValueOnce(new SecretBackendError('secret backend write failed with status 503'))

    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1/providers/provider-1',
      payload: { kind: 'api_key', config_json: { header_name: 'X-Api-Key', api_key: 'piper-key' } },
    })

    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'secret_backend_unavailable' })
    expect(db.connect).toHaveBeenCalled()
    expect(secrets.values.size).toBe(0)
  })

  it('clears the stored credential document when a kind change drops the secret config', async () => {
    const { app, db, secrets } = buildRouteApp(providersRoutes)
    seedProviderSecret(secrets)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'provider-1', zone_id: 'z1', kind: 'none' }] })

    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1/providers/provider-1',
      payload: { kind: 'none', config_json: {} },
    })

    expect(res.statusCode).toBe(200)
    expect(secrets.delete).toHaveBeenCalledWith(providerSecretConfigRef('z1', 'provider-1'))
    expect(secrets.values.size).toBe(0)
  })
})

describe('GET /v1/zones/:zoneId/providers', () => {
  it('lists providers for the zone', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValueOnce({
      rows: [
        { id: 'provider-1', zone_id: 'z1' },
        { id: 'provider-2', zone_id: 'z1' },
      ],
    })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/providers' })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.items).toHaveLength(2)
    expect(body.next_cursor).toBeNull()
  })

  it('lists archived providers for audit when requested', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'provider-retired', zone_id: 'z1', archived_at: '2026-07-01T00:00:00.000Z' }],
    })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/providers?status=archived' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).items).toHaveLength(1)
    expect(String(db.query.mock.calls[0][0])).toContain('archived_at IS NOT NULL')
  })

  it('rejects an unknown status filter', async () => {
    const { app } = buildRouteApp(providersRoutes)
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/providers?status=all' })
    expect(res.statusCode).toBe(400)
  })
})

describe('DELETE /v1/zones/:zoneId/providers/:id', () => {
  it('archives an existing provider', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValueOnce({ rowCount: 1 })

    await app.ready()
    const res = await app.inject({ method: 'DELETE', url: '/v1/zones/z1/providers/provider-1' })

    expect(res.statusCode).toBe(204)
  })

  it('returns 404 when the provider is missing', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValueOnce({ rowCount: 0 })

    await app.ready()
    const res = await app.inject({ method: 'DELETE', url: '/v1/zones/z1/providers/missing' })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'provider_not_found' })
  })
})

describe('POST /v1/zones/:zoneId/providers/:id/test', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('rejects checks for kinds without a checkable endpoint instead of faking a pass', async () => {
    const { app, db, redis } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValueOnce({
      rows: [{ kind: 'api_key', config_json: { header_name: 'X-API-Key' } }],
    })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/providers/provider-1/test', payload: {} })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'provider_check_unsupported' })
    expect(httpsRequest).not.toHaveBeenCalled()
    expect(redis.incr).not.toHaveBeenCalled()
    expect(db.query).toHaveBeenCalledTimes(1)
  })

  it('rate limits OAuth connectivity checks per zone', async () => {
    const { app, db, redis, secrets } = buildRouteApp(providersRoutes)
    seedProviderSecret(secrets)
    db.query.mockResolvedValueOnce({
      rows: [
        oauthProviderRow('oauth2_client_credentials', {
          token_endpoint: 'https://login.hooli.example/oauth/token',
          client_id: 'hooli-client',
          client_auth_method: 'client_secret_basic',
          allowed_token_hosts: ['login.hooli.example'],
        }),
      ],
    })
    redis.incr.mockResolvedValueOnce(11)

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/providers/provider-1/test', payload: {} })

    expect(res.statusCode).toBe(429)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'provider_test_rate_limited' })
  })

  it('verifies client-credentials providers with a real token request and never returns the token', async () => {
    const { app, db, redis, secrets } = buildRouteApp(providersRoutes)
    seedProviderSecret(secrets)
    redis.incr.mockResolvedValueOnce(1)
    db.query.mockResolvedValueOnce({
      rows: [
        oauthProviderRow('oauth2_client_credentials', {
          token_endpoint: 'https://login.hooli.example/oauth/token',
          client_id: 'hooli-client',
          client_auth_method: 'client_secret_basic',
          allowed_token_hosts: ['login.hooli.example'],
          scopes: ['pipernet.read'],
        }),
      ],
    })
    vi.mocked(lookup).mockResolvedValue([{ address: '203.0.113.10', family: 4 }] as never)
    const bodies = mockTokenResponse({ access_token: 'issued-token', token_type: 'Bearer' }, 200)

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/providers/provider-1/test', payload: {} })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ status: 'ok' })
    expect(res.body).not.toContain('issued-token')
    expect(bodies.join('')).toContain('grant_type=client_credentials')
    expect(bodies.join('')).toContain('scope=pipernet.read')
    const requestHeaders = (vi.mocked(httpsRequest).mock.calls[0][1] as { headers: Record<string, string> }).headers
    expect(requestHeaders.Accept).toBe('application/json')
    expect(db.query).toHaveBeenLastCalledWith(expect.stringContaining('SET connectivity_failed_at'), ['provider-1', 'z1', null])
  })

  it('classifies rejected client credentials as auth_failed', async () => {
    const { app, db, redis, secrets } = buildRouteApp(providersRoutes)
    seedProviderSecret(secrets)
    redis.incr.mockResolvedValueOnce(1)
    db.query.mockResolvedValueOnce({
      rows: [
        oauthProviderRow('oauth2_client_credentials', {
          token_endpoint: 'https://login.hooli.example/oauth/token',
          client_id: 'hooli-client',
          client_auth_method: 'client_secret_basic',
          allowed_token_hosts: ['login.hooli.example'],
        }),
      ],
    })
    vi.mocked(lookup).mockResolvedValue([{ address: '203.0.113.10', family: 4 }] as never)
    mockTokenResponse({ error: 'invalid_client' }, 401)

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/providers/provider-1/test', payload: {} })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ status: 'auth_failed' })
    const [, updateValues] = db.query.mock.calls[1] as [string, unknown[]]
    expect(updateValues[2]).toBeInstanceOf(Date)
  })

  it('treats invalid_grant for the placeholder code as a verified authorization-code provider', async () => {
    const { app, db, redis, secrets } = buildRouteApp(providersRoutes)
    seedProviderSecret(secrets)
    redis.incr.mockResolvedValueOnce(1)
    db.query.mockResolvedValueOnce({
      rows: [
        oauthProviderRow('oauth2_authorization_code', {
          authorization_endpoint: 'https://login.hooli.example/oauth/authorize',
          token_endpoint: 'https://login.hooli.example/oauth/token',
          redirect_uri: 'https://caracal.piedpiper.example/v1/zones/z1/provider-grants/oauth/callback',
          client_id: 'hooli-client',
          client_auth_method: 'client_secret_basic',
          allowed_token_hosts: ['login.hooli.example'],
        }),
      ],
    })
    vi.mocked(lookup).mockResolvedValue([{ address: '203.0.113.10', family: 4 }] as never)
    const bodies = mockTokenResponse({ error: 'invalid_grant' }, 400)

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/providers/provider-1/test', payload: {} })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ status: 'ok' })
    expect(bodies.join('')).toContain('code=caracal-connection-test')
    expect(bodies.join('')).toContain('code_verifier=')
  })

  it('reads form-encoded HTTP 200 vendor errors so GitHub-style endpoints classify correctly', async () => {
    const config = {
      authorization_endpoint: 'https://login.hooli.example/oauth/authorize',
      token_endpoint: 'https://login.hooli.example/oauth/token',
      redirect_uri: 'https://caracal.piedpiper.example/v1/zones/z1/provider-grants/oauth/callback',
      client_id: 'hooli-client',
      client_auth_method: 'client_secret_post',
      allowed_token_hosts: ['login.hooli.example'],
    }
    for (const [kind, errBody, status] of [
      ['oauth2_authorization_code', 'error=bad_verification_code&error_description=The+code+passed+is+incorrect', 'ok'],
      [
        'oauth2_authorization_code',
        'error=incorrect_client_credentials&error_description=The+client_id+or+client_secret+is+incorrect',
        'auth_failed',
      ],
      [
        'oauth2_client_credentials',
        'error=incorrect_client_credentials&error_description=The+client_id+or+client_secret+is+incorrect',
        'auth_failed',
      ],
    ] as const) {
      const { app, db, redis, secrets } = buildRouteApp(providersRoutes)
      seedProviderSecret(secrets)
      redis.incr.mockResolvedValueOnce(1)
      db.query.mockResolvedValueOnce({ rows: [oauthProviderRow(kind, config)] })
      vi.mocked(lookup).mockResolvedValue([{ address: '203.0.113.10', family: 4 }] as never)
      mockTokenResponse(errBody, 200)

      await app.ready()
      const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/providers/provider-1/test', payload: {} })

      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toMatchObject({ status })
      vi.clearAllMocks()
    }
  })

  it('classifies scope and audience rejections as configuration errors', async () => {
    const { app, db, redis, secrets } = buildRouteApp(providersRoutes)
    seedProviderSecret(secrets)
    redis.incr.mockResolvedValueOnce(1)
    db.query.mockResolvedValueOnce({
      rows: [
        oauthProviderRow('oauth2_client_credentials', {
          token_endpoint: 'https://login.hooli.example/oauth/token',
          client_id: 'hooli-client',
          client_auth_method: 'client_secret_basic',
          allowed_token_hosts: ['login.hooli.example'],
          scopes: ['pipernet.admin'],
        }),
      ],
    })
    vi.mocked(lookup).mockResolvedValue([{ address: '203.0.113.10', family: 4 }] as never)
    mockTokenResponse({ error: 'invalid_scope' }, 400)

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/providers/provider-1/test', payload: {} })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ status: 'config_error' })
    expect(JSON.parse(res.body).detail).toContain('invalid_scope')
  })

  it('reports a non-allowlisted token endpoint as config_error without any outbound request', async () => {
    const { app, db, redis, secrets } = buildRouteApp(providersRoutes)
    seedProviderSecret(secrets)
    redis.incr.mockResolvedValueOnce(1)
    db.query.mockResolvedValueOnce({
      rows: [
        oauthProviderRow('oauth2_client_credentials', {
          token_endpoint: 'https://attacker.example/oauth/token',
          client_id: 'hooli-client',
          client_auth_method: 'client_secret_basic',
          allowed_token_hosts: ['login.hooli.example'],
        }),
      ],
    })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/providers/provider-1/test', payload: {} })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ status: 'config_error' })
    expect(httpsRequest).not.toHaveBeenCalled()
  })
})

describe('POST /v1/zones/:zoneId/providers with connectivity check', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  const oauthPayload = {
    identifier: 'provider://hooli-oidc',
    kind: 'oauth2_client_credentials',
    config_json: {
      token_endpoint: 'https://login.hooli.example/oauth/token',
      client_id: 'hooli-client',
      client_secret: 'hooli-secret',
    },
  }

  it('creates a checked OAuth provider clean after a passing check and never returns the token', async () => {
    const { app, db, redis } = buildRouteApp(providersRoutes)
    redis.incr.mockResolvedValueOnce(1)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }).mockResolvedValueOnce({
      rows: [{ id: 'provider-1', zone_id: 'z1', identifier: 'provider://hooli-oidc', kind: 'oauth2_client_credentials' }],
    })
    vi.mocked(lookup).mockResolvedValue([{ address: '203.0.113.10', family: 4 }] as never)
    const bodies = mockTokenResponse({ access_token: 'issued-token', token_type: 'Bearer' }, 200)

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/providers', payload: { ...oauthPayload, check: true } })

    expect(res.statusCode).toBe(201)
    expect(res.body).not.toContain('issued-token')
    expect(bodies.join('')).toContain('grant_type=client_credentials')
    const values = db.query.mock.calls[1][1] as unknown[]
    expect(values[7]).toBeNull()
  })

  it('returns the check result and creates nothing when the check fails', async () => {
    const { app, db, redis } = buildRouteApp(providersRoutes)
    redis.incr.mockResolvedValueOnce(1)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    vi.mocked(lookup).mockResolvedValue([{ address: '203.0.113.10', family: 4 }] as never)
    mockTokenResponse({ error: 'invalid_client' }, 401)

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/providers', payload: { ...oauthPayload, check: true } })

    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'provider_check_failed', details: { check: { status: 'auth_failed' } } })
    expect(db.query).toHaveBeenCalledTimes(1)
  })

  it('rate limits checked OAuth creation per zone', async () => {
    const { app, db, redis } = buildRouteApp(providersRoutes)
    redis.incr.mockResolvedValueOnce(11)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/providers', payload: { ...oauthPayload, check: true } })

    expect(res.statusCode).toBe(429)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'provider_test_rate_limited' })
    expect(httpsRequest).not.toHaveBeenCalled()
  })

  it('signs a private_key_jwt client assertion for the connectivity check', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    const { app, db, redis } = buildRouteApp(providersRoutes)
    redis.incr.mockResolvedValueOnce(1)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }).mockResolvedValueOnce({
      rows: [{ id: 'provider-1', zone_id: 'z1', identifier: 'provider://hooli-oidc', kind: 'oauth2_client_credentials' }],
    })
    vi.mocked(lookup).mockResolvedValue([{ address: '203.0.113.10', family: 4 }] as never)
    const bodies = mockTokenResponse({ access_token: 'issued-token', token_type: 'Bearer' }, 200)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers',
      payload: {
        identifier: 'provider://hooli-oidc',
        kind: 'oauth2_client_credentials',
        check: true,
        config_json: {
          token_endpoint: 'https://login.hooli.example/oauth/token',
          client_id: 'hooli-client',
          client_auth_method: 'private_key_jwt',
          key_id: 'key-1',
          private_key: pem,
        },
      },
    })

    expect(res.statusCode).toBe(201)
    const body = bodies.join('')
    expect(body).toContain('grant_type=client_credentials')
    expect(body).toContain('client_assertion_type=urn%3Aietf%3Aparams%3Aoauth%3Aclient-assertion-type%3Ajwt-bearer')
    expect(body).toContain('client_assertion=')
  })

  it('marks an unchecked OAuth provider as connectivity failed at creation', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }).mockResolvedValueOnce({
      rows: [{ id: 'provider-1', zone_id: 'z1', identifier: 'provider://hooli-oidc', kind: 'oauth2_client_credentials' }],
    })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/providers', payload: oauthPayload })

    expect(res.statusCode).toBe(201)
    expect(httpsRequest).not.toHaveBeenCalled()
    const values = db.query.mock.calls[1][1] as unknown[]
    expect(values[7]).toBeInstanceOf(Date)
  })

  it('rejects check requests for kinds without a checkable endpoint', async () => {
    const { app, db, redis } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers',
      payload: {
        identifier: 'provider://not-hotdog-api',
        kind: 'api_key',
        check: true,
        config_json: { header_name: 'X-API-Key', api_key: 'hotdog-secret' },
      },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'provider_check_unsupported' })
    expect(httpsRequest).not.toHaveBeenCalled()
    expect(redis.incr).not.toHaveBeenCalled()
    expect(db.query).toHaveBeenCalledTimes(1)
  })
})

// Static EC P-256 test fixture: a throwaway self-signed pair used only to exercise
// certificate parsing and thumbprint headers, never a real credential.
const TEST_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBljCCATugAwIBAgIUCIvavTQpsWT0/TbSfm8CoHAeumkwCgYIKoZIzj0EAwIw
IDEeMBwGA1UEAwwVY2FyYWNhbC1wcm92aWRlci10ZXN0MB4XDTI2MDcwNjA3MDgw
M1oXDTM2MDcwMzA3MDgwM1owIDEeMBwGA1UEAwwVY2FyYWNhbC1wcm92aWRlci10
ZXN0MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEr+0KCRqFP1Tq61FKDLYCadly
7CPqO7BUu8SyH1RxyFRp3jHHLXG6BUSPtGNcniAI13bAehg6UbVNXmx9SHBJUKNT
MFEwHQYDVR0OBBYEFJdXYq44/XLHFtgE42SCyoRoe6R8MB8GA1UdIwQYMBaAFJdX
Yq44/XLHFtgE42SCyoRoe6R8MA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwID
SQAwRgIhAOTXrAasAk4caclzDW8NvH06gVtghTZHSwLjyCpImvhaAiEA3kUJ/vRD
l/L5GomD3TmOEq09SHU30dPFv2VA+SWTZbA=
-----END CERTIFICATE-----`
const TEST_CERTIFICATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgNlZmm7FKTOHdXBlr
rhlWuIX4JbFnIYKi06HWrc4ylkahRANCAASv7QoJGoU/VOrrUUoMtgJp2XLsI+o7
sFS7xLIfVHHIVGneMcctcboFRI+0Y1yeIAjXdsB6GDpRtU1ebH1IcElQ
-----END PRIVATE KEY-----`

describe('POST /v1/zones/:zoneId/providers secret intake hygiene', () => {
  it('trims outer whitespace from a pasted secret before sealing', async () => {
    const { app, db, secrets } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }).mockResolvedValueOnce({
      rows: [{ id: 'provider-1', zone_id: 'z1', identifier: 'provider://hoolibox-token', kind: 'bearer_token' }],
    })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers',
      payload: {
        identifier: 'provider://hoolibox-token',
        kind: 'bearer_token',
        config_json: { bearer_token: '  hoolibox-static-token\n' },
      },
    })

    expect(res.statusCode).toBe(201)
    const values = db.query.mock.calls[1][1] as unknown[]
    const stored = secrets.values.get(providerSecretConfigRef('z1', values[0] as string))
    expect(JSON.parse(stored!.toString('utf8'))).toEqual({ bearer_token: 'hoolibox-static-token' })
  })

  it('rejects embedded control characters in single-line secrets', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValue({ rows: [{ '?column?': 1 }] })

    await app.ready()
    for (const [kind, config] of [
      ['bearer_token', { bearer_token: 'line-one\nline-two' }],
      ['http_basic', { username: 'richard.hendricks@piedpiper.example', password: 'pass\tword' }],
    ] as const) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/zones/z1/providers',
        payload: { identifier: 'provider://hoolibox-token', kind, config_json: config },
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).error_description).toContain('must not contain control characters')
    }
  })

  it('rejects a credential pasted with the composed authorization scheme attached', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValue({ rows: [{ '?column?': 1 }] })

    await app.ready()
    for (const payload of [
      { kind: 'bearer_token', config_json: { bearer_token: 'Bearer hoolibox-static-token' } },
      { kind: 'bearer_token', config_json: { bearer_token: 'token hoolibox-static-token', auth_scheme: 'Token' } },
      { kind: 'api_key', config_json: { header_name: 'Authorization', auth_scheme: 'Bearer', api_key: 'bearer sk-hooli' } },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/zones/z1/providers',
        payload: { identifier: 'provider://hoolibox-token', ...payload },
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).error_description).toContain('the gateway adds it')
    }
  })

  it('accepts a schemeless api_key value carrying an intentional prefix', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }).mockResolvedValueOnce({
      rows: [{ id: 'provider-1', zone_id: 'z1', identifier: 'provider://hoolibox-raw', kind: 'api_key' }],
    })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers',
      payload: {
        identifier: 'provider://hoolibox-raw',
        kind: 'api_key',
        config_json: { header_name: 'X-Custom-Auth', api_key: 'Bearer raw-forwarded-value' },
      },
    })

    expect(res.statusCode).toBe(201)
  })
})

describe('POST /v1/zones/:zoneId/providers with http_basic kind', () => {
  it('stores the username publicly and seals only the password', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }).mockResolvedValueOnce({
      rows: [{ id: 'provider-1', zone_id: 'z1', identifier: 'provider://hoolibox-basic', kind: 'http_basic' }],
    })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers',
      payload: {
        identifier: 'provider://hoolibox-basic',
        kind: 'http_basic',
        config_json: {
          username: 'richard.hendricks@piedpiper.example',
          password: 'jira-api-token',
          allowed_token_hosts: ['api.hoolibox.example'],
        },
      },
    })

    const values = db.query.mock.calls[1][1] as unknown[]
    expect(res.statusCode).toBe(201)
    expect(values[4]).toBe('http_basic')
    expect(JSON.parse(values[5] as string)).toEqual({
      username: 'richard.hendricks@piedpiper.example',
      allowed_token_hosts: ['api.hoolibox.example'],
    })
    expect(values[6]).toEqual(['password'])
    expect(values[5]).not.toContain('jira-api-token')
  })

  it('rejects http_basic providers missing the username or password', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValue({ rows: [{ '?column?': 1 }] })

    await app.ready()
    for (const config of [{ password: 'jira-api-token' }, { username: 'richard.hendricks@piedpiper.example' }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/zones/z1/providers',
        payload: { identifier: 'provider://hoolibox-basic', kind: 'http_basic', config_json: config },
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_provider_config' })
    }
  })

  it('rejects runtime injection configuration on http_basic providers', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValue({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers',
      payload: {
        identifier: 'provider://hoolibox-basic',
        kind: 'http_basic',
        config_json: { username: 'richard.hendricks@piedpiper.example', password: 'x', allow_runtime_injection: true },
      },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error_description).toContain('unsupported keys: allow_runtime_injection')
  })
})

describe('POST /v1/zones/:zoneId/providers with jwt_bearer grant type', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  function jwtBearerConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    return {
      token_endpoint: 'https://oauth2.googleapis.example/token',
      client_id: 'anton@pied-piper.iam.gserviceaccount.example',
      grant_type: 'jwt_bearer',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
      scopes: ['https://www.googleapis.example/auth/cloud-platform'],
      ...extra,
    }
  }

  it('defaults client authentication to none and stores the assertion fields', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }).mockResolvedValueOnce({
      rows: [{ id: 'provider-1', zone_id: 'z1', identifier: 'provider://vertex-sa', kind: 'oauth2_client_credentials' }],
    })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers',
      payload: {
        identifier: 'provider://vertex-sa',
        kind: 'oauth2_client_credentials',
        config_json: jwtBearerConfig({ assertion_subject: 'monica.hall@piedpiper.example' }),
      },
    })

    const values = db.query.mock.calls[1][1] as unknown[]
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(values[5] as string)).toMatchObject({
      grant_type: 'jwt_bearer',
      client_auth_method: 'none',
      assertion_subject: 'monica.hall@piedpiper.example',
    })
    expect(values[6]).toEqual(['private_key'])
  })

  it('rejects invalid jwt_bearer combinations', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValue({ rows: [{ '?column?': 1 }] })

    await app.ready()
    for (const config of [
      jwtBearerConfig({ client_auth_method: 'private_key_jwt' }),
      jwtBearerConfig({ audience: 'https://api.hooli.example' }),
      jwtBearerConfig({ private_key: undefined }),
      { ...jwtBearerConfig(), grant_type: 'client_credentials', client_secret: 's', assertion_subject: 'x' },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/zones/z1/providers',
        payload: { identifier: 'provider://vertex-sa', kind: 'oauth2_client_credentials', config_json: config },
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_provider_config' })
    }
  })

  it('rejects a private_key that is not parseable PEM at creation', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValue({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers',
      payload: {
        identifier: 'provider://vertex-sa',
        kind: 'oauth2_client_credentials',
        config_json: jwtBearerConfig({ private_key: '-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----' }),
      },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error_description).toContain('private_key must be a valid PEM private key')
  })

  it('submits a signed assertion grant with scopes in the claim for the connectivity check', async () => {
    const { app, db, redis } = buildRouteApp(providersRoutes)
    redis.incr.mockResolvedValueOnce(1)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }).mockResolvedValueOnce({
      rows: [{ id: 'provider-1', zone_id: 'z1', identifier: 'provider://vertex-sa', kind: 'oauth2_client_credentials' }],
    })
    vi.mocked(lookup).mockResolvedValue([{ address: '203.0.113.10', family: 4 }] as never)
    const bodies = mockTokenResponse({ access_token: 'issued-token', token_type: 'Bearer' }, 200)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers',
      payload: {
        identifier: 'provider://vertex-sa',
        kind: 'oauth2_client_credentials',
        check: true,
        config_json: jwtBearerConfig(),
      },
    })

    expect(res.statusCode).toBe(201)
    const form = new URLSearchParams(bodies.join(''))
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    expect(form.get('scope')).toBeNull()
    const assertion = form.get('assertion') ?? ''
    const claims = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString()) as Record<string, unknown>
    expect(claims).toMatchObject({
      iss: 'anton@pied-piper.iam.gserviceaccount.example',
      sub: 'anton@pied-piper.iam.gserviceaccount.example',
      aud: 'https://oauth2.googleapis.example/token',
      scope: 'https://www.googleapis.example/auth/cloud-platform',
    })
  })

  it('classifies an invalid_grant answer to a jwt_bearer check as an authentication failure', async () => {
    const { app, db, redis } = buildRouteApp(providersRoutes)
    redis.incr.mockResolvedValueOnce(1)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    vi.mocked(lookup).mockResolvedValue([{ address: '203.0.113.10', family: 4 }] as never)
    mockTokenResponse({ error: 'invalid_grant' }, 400)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers',
      payload: {
        identifier: 'provider://vertex-sa',
        kind: 'oauth2_client_credentials',
        check: true,
        config_json: jwtBearerConfig(),
      },
    })

    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'provider_check_failed', details: { check: { status: 'auth_failed' } } })
  })
})

describe('POST /v1/zones/:zoneId/providers with private_key_jwt certificate', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  function certConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      token_endpoint: 'https://login.hooli.example/oauth/token',
      client_id: 'hooli-client',
      client_auth_method: 'private_key_jwt',
      private_key: TEST_CERTIFICATE_KEY,
      certificate: TEST_CERTIFICATE,
      ...extra,
    }
  }

  it('stores a matching certificate and emits x5t thumbprint headers on the client assertion', async () => {
    const { app, db, redis } = buildRouteApp(providersRoutes)
    redis.incr.mockResolvedValueOnce(1)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }).mockResolvedValueOnce({
      rows: [{ id: 'provider-1', zone_id: 'z1', identifier: 'provider://entra-app', kind: 'oauth2_client_credentials' }],
    })
    vi.mocked(lookup).mockResolvedValue([{ address: '203.0.113.10', family: 4 }] as never)
    const bodies = mockTokenResponse({ access_token: 'issued-token', token_type: 'Bearer' }, 200)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers',
      payload: { identifier: 'provider://entra-app', kind: 'oauth2_client_credentials', check: true, config_json: certConfig() },
    })

    expect(res.statusCode).toBe(201)
    const values = db.query.mock.calls[1][1] as unknown[]
    expect(JSON.parse(values[5] as string).certificate).toBe(TEST_CERTIFICATE)
    const assertion = new URLSearchParams(bodies.join('')).get('client_assertion') ?? ''
    const header = JSON.parse(Buffer.from(assertion.split('.')[0], 'base64url').toString()) as Record<string, unknown>
    expect(typeof header.x5t).toBe('string')
    expect(typeof header['x5t#S256']).toBe('string')
  })

  it('rejects a certificate that does not match the private key or sits on the wrong method', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const otherKey = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValue({ rows: [{ '?column?': 1 }] })

    await app.ready()
    for (const config of [
      certConfig({ private_key: otherKey }),
      certConfig({ certificate: 'not a certificate' }),
      {
        token_endpoint: 'https://login.hooli.example/oauth/token',
        client_id: 'hooli-client',
        client_secret: 'hooli-secret',
        certificate: TEST_CERTIFICATE,
      },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/zones/z1/providers',
        payload: { identifier: 'provider://entra-app', kind: 'oauth2_client_credentials', config_json: config },
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_provider_config' })
    }
  })
})

describe('POST /v1/zones/:zoneId/providers/discovery', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  const metadata = {
    issuer: 'https://login.hooli.example',
    authorization_endpoint: 'https://login.hooli.example/oauth/authorize',
    token_endpoint: 'https://login.hooli.example/oauth/token',
    scopes_supported: ['openid', 'pipernet.read'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'private_key_jwt', 'tls_client_auth'],
  }

  it('resolves issuer metadata into endpoint fields with unsupported auth methods filtered', async () => {
    const { app, db, redis } = buildRouteApp(providersRoutes)
    redis.incr.mockResolvedValueOnce(1)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    vi.mocked(lookup).mockResolvedValue([{ address: '203.0.113.10', family: 4 }] as never)
    mockTokenResponse(metadata, 200)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers/discovery',
      payload: { issuer: 'https://login.hooli.example' },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      issuer: 'https://login.hooli.example',
      token_endpoint: 'https://login.hooli.example/oauth/token',
      authorization_endpoint: 'https://login.hooli.example/oauth/authorize',
      scopes_supported: ['openid', 'pipernet.read'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'private_key_jwt'],
    })
  })

  it('rejects issuers that are not clean HTTPS URLs', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValue({ rows: [{ '?column?': 1 }] })

    await app.ready()
    for (const issuer of ['http://login.hooli.example', 'https://login.hooli.example?x=1', 'not a url']) {
      const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/providers/discovery', payload: { issuer } })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_issuer' })
    }
    expect(httpsRequest).not.toHaveBeenCalled()
  })

  it('rejects metadata whose issuer does not match the requested issuer', async () => {
    const { app, db, redis } = buildRouteApp(providersRoutes)
    redis.incr.mockResolvedValueOnce(1)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    vi.mocked(lookup).mockResolvedValue([{ address: '203.0.113.10', family: 4 }] as never)
    mockTokenResponse({ ...metadata, issuer: 'https://login.endframe.example' }, 200)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers/discovery',
      payload: { issuer: 'https://login.hooli.example' },
    })

    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'provider_discovery_failed' })
  })

  it('rate limits discovery probes per zone', async () => {
    const { app, db, redis } = buildRouteApp(providersRoutes)
    redis.incr.mockResolvedValueOnce(11)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers/discovery',
      payload: { issuer: 'https://login.hooli.example' },
    })

    expect(res.statusCode).toBe(429)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'provider_discovery_rate_limited' })
    expect(httpsRequest).not.toHaveBeenCalled()
  })
})
