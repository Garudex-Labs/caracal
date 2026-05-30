// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Provider route unit tests for zone ownership and configuration updates.

import { describe, it, expect } from 'vitest'
import { providersRoutes } from '../../../../../apps/api/src/routes/providers.js'
import { buildRouteApp } from '../../../../shared/test-utils/typescript/fastify.js'

process.env.ZONE_KEK = '1111111111111111111111111111111111111111111111111111111111111111'

describe('GET /v1/zones/:zoneId/providers/:id', () => {
  it('returns 404 when provider is outside the zone', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/providers/provider-other-zone' })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'provider_not_found' })
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1 AND zone_id = $2'), [
      'provider-other-zone',
      'z1',
    ])
  })
})

describe('POST /v1/zones/:zoneId/providers', () => {
  it('stores provider kind and validated config in provider_kind', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({
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
      scopes: ['pipernet.read'],
      audience: 'https://api.hooli.example',
      resource: 'https://resource.hooli.example',
      allowed_token_hosts: ['issuer.example'],
      allow_runtime_injection: true,
    })
    expect(values[8]).toEqual(['client_secret'])
  })

  it('stores private-key JWT client credentials with sealed private keys', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({
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
          client_auth_method: 'private_key_jwt',
          key_id: 'key-1',
          private_key: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----',
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
      key_id: 'key-1',
      allowed_token_hosts: ['issuer.example'],
    })
    expect(values[8]).toEqual(['private_key'])
  })

  it('rejects OAuth2 client-credentials providers with invalid endpoint or token parameter config', async () => {
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
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({
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
    expect(values[6]).toBeNull()
    expect(values[7]).toBeNull()
    expect(values[8]).toEqual([])
  })

  it('creates none providers without credential config', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({
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
    expect(values[6]).toBeNull()
    expect(values[7]).toBeNull()
    expect(values[8]).toEqual([])
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
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({
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
      forward_caracal_identity: true,
      allow_runtime_injection: true,
    })
    expect(values[8]).toEqual(['api_key'])
  })

  it('stores API key provider query parameter placement and sealed secrets', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({
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
    expect(values[8]).toEqual(['api_key'])
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
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({
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
    expect(values[8]).toEqual(['bearer_token'])
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
        rows: [{ id: 'provider-1', zone_id: 'z1', identifier: 'provider://hooli-oauth2', kind: 'caracal_mandate' }],
      })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers',
      payload: {
        identifier: '',
        name: 'Hooli OAuth2',
        kind: 'caracal_mandate',
        config_json: {},
      },
    })

    const values = db.query.mock.calls[2][1] as unknown[]
    expect(res.statusCode).toBe(201)
    expect(values[2]).toBe('Hooli OAuth2')
    expect(values[3]).toBe('provider://hooli-oauth2')
  })

  it('suffixes generated provider identifiers when the provider name already exists in the zone', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 'provider-2', zone_id: 'z1', identifier: 'provider://hooli-oauth2-2', kind: 'caracal_mandate' }],
      })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers',
      payload: {
        name: 'Hooli OAuth2',
        kind: 'caracal_mandate',
        config_json: {},
      },
    })

    const values = db.query.mock.calls[3][1] as unknown[]
    expect(res.statusCode).toBe(201)
    expect(values[3]).toBe('provider://hooli-oauth2-2')
  })

  it('rejects duplicate explicit provider identifiers in the zone', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    const conflict = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'providers_zone_identifier_active_uidx',
    })
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockRejectedValueOnce(conflict)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers',
      payload: {
        identifier: 'provider://hooli-oauth2',
        name: 'Hooli OAuth2',
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
      payload: { identifier: 'provider://oauth-main', kind: 'oauth2_client_credentials', config_json: { authorization_endpoint: 'https://issuer.example/auth' } },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_provider_config' })
  })

  it('stores OAuth2 auth-code provider config with validated callback and forwarding settings', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({
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
    expect(values[8]).toEqual(['client_secret'])
  })

  it('rejects OAuth2 auth-code providers with invalid URLs or malformed forwarding schemes', async () => {
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
})

describe('GET /v1/zones/:zoneId/providers', () => {
  it('lists providers for the zone', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'provider-1', zone_id: 'z1' }, { id: 'provider-2', zone_id: 'z1' }] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/providers' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toHaveLength(2)
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
