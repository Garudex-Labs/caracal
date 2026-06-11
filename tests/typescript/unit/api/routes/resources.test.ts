// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Resource route unit tests for same-zone provider ownership.

import { describe, it, expect, vi } from 'vitest'
import { resourcesRoutes } from '../../../../../apps/api/src/routes/resources.js'
import { buildRouteApp } from '../../../../shared/test-utils/typescript/fastify.js'

describe('GET /v1/zones/:zoneId/resources', () => {
  it('hides the Control API resource from generic resource lists', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'res-demo', identifier: 'demo-api', created_at: '2026-05-25T00:00:00.000Z' }],
    })

    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones/z1/resources',
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual([{ id: 'res-demo', identifier: 'demo-api', created_at: '2026-05-25T00:00:00.000Z' }])
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('r.identifier <> $2'),
      ['z1', 'caracal-control', 200],
    )
  })

  it('lets the Control path include the Control API resource', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes, { prefix: '/v1' }, { actor: { scope: 'global' } })
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'res-control', identifier: 'caracal-control', created_at: '2026-05-25T00:00:00.000Z' }],
    })

    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones/z1/resources',
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual([{ id: 'res-control', identifier: 'caracal-control', created_at: '2026-05-25T00:00:00.000Z' }])
    expect(db.query).not.toHaveBeenCalledWith(
      expect.stringContaining('r.identifier <> $2'),
      expect.anything(),
    )
  })
})

describe('GET /v1/zones/:zoneId/resources/:id', () => {
  it('hides the Control API resource from generic resource details', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'res-control', identifier: 'caracal-control' }] })

    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones/z1/resources/res-control',
    })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'resource_not_found' })
  })
})

describe('POST /v1/zones/:zoneId/resources', () => {
  it('rejects provider references outside the zone', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/resources',
      payload: {
        identifier: 'resource://api',
        scopes: ['read'],
        credential_provider_id: 'provider-other-zone',
      },
    })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'provider_not_found' })
    expect(db.query).toHaveBeenCalledTimes(2)
  })

  it('rejects relative or provider-shaped resource identifiers', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

    await app.ready()
    for (const identifier of ['pipernet', 'provider://pipernet']) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/zones/z1/resources',
        payload: {
          identifier,
          upstream_url: 'https://api.pipernet.example',
          scopes: ['read'],
          gateway_application_id: 'app-1',
          credential_provider_id: 'provider-1',
        },
      })

      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_resource_identifier' })
    }
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('rejects resources without Gateway routing', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ exists: 1 }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/resources',
      payload: {
        identifier: 'resource://api',
        scopes: ['read'],
        credential_provider_id: 'provider-1',
      },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'upstream_url_required' })
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('requires a provider for gateway-routed resources', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/resources',
      payload: {
        identifier: 'resource://api',
        upstream_url: 'https://api.example.com',
        gateway_application_id: 'app-1',
        scopes: ['read'],
      },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'credential_provider_required' })
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('requires a gateway application for gateway-routed resources', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/resources',
      payload: {
        identifier: 'resource://api',
        upstream_url: 'https://api.example.com',
        scopes: ['read'],
        credential_provider_id: 'provider-1',
      },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'gateway_application_required' })
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('creates a gateway binding atomically with upstream resources', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{
            id: 'res-1',
            zone_id: 'z1',
            identifier: 'resource://api',
            upstream_url: 'https://api.example.com',
            scopes: ['read'],
          }],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ registration_method: 'managed' }] })
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/resources',
      payload: {
        identifier: 'resource://api',
        upstream_url: 'https://api.example.com',
        scopes: ['read'],
        gateway_application_id: 'app-1',
        credential_provider_id: 'provider-1',
      },
    })

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'res-1', gateway_application_id: 'app-1' })
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO gateway_resource_bindings'),
      ['resource://api', 'z1', 'app-1'],
    )
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE gateway_binding_revision'),
    )
    expect(client.query).toHaveBeenCalledWith('COMMIT')
    expect(client.release).toHaveBeenCalled()
  })

  it('suffixes generated resource identifiers when the resource name already exists in the zone', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{
            id: 'res-2',
            zone_id: 'z1',
            identifier: 'resource://api-2',
            upstream_url: 'https://api.example.com',
            scopes: ['read'],
          }],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ registration_method: 'managed' }] })
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/resources',
      payload: {
        name: 'API',
        upstream_url: 'https://api.example.com',
        scopes: ['read'],
        gateway_application_id: 'app-1',
        credential_provider_id: 'provider-1',
      },
    })

    const insertValues = client.query.mock.calls[1]![1] as unknown[]
    expect(res.statusCode).toBe(201)
    expect(insertValues[3]).toBe('resource://api-2')
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO gateway_resource_bindings'),
      ['resource://api-2', 'z1', 'app-1'],
    )
  })

  it('returns conflict for explicit duplicate resource identifiers', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    const conflict = Object.assign(new Error('duplicate resource identifier'), {
      code: '23505',
      constraint: 'resources_zone_id_identifier_key',
    })
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockRejectedValueOnce(conflict)
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ registration_method: 'managed' }] })
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/resources',
      payload: {
        identifier: 'resource://api',
        upstream_url: 'https://api.example.com',
        scopes: ['read'],
        gateway_application_id: 'app-1',
        credential_provider_id: 'provider-1',
      },
    })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'resource_identifier_conflict' })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
    expect(client.release).toHaveBeenCalled()
  })

  it('rejects resource creation when the zone resource quota is exhausted', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    app.decorate('cfg', { maxResourcesPerZone: 1 })
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ registration_method: 'managed' }] })
      .mockResolvedValueOnce({ rows: [{ resource_count: '1' }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/resources',
      payload: {
        identifier: 'resource://api',
        upstream_url: 'https://api.example.com',
        gateway_application_id: 'app-1',
        scopes: ['read'],
        credential_provider_id: 'provider-1',
      },
    })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'resource_quota_exceeded' })
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('rejects binding a DCR application as the Gateway identity', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ registration_method: 'dcr' }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/resources',
      payload: {
        identifier: 'resource://api',
        upstream_url: 'https://api.example.com',
        scopes: ['read'],
        gateway_application_id: 'dcr-app',
        credential_provider_id: 'provider-1',
      },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'gateway_exchange_application_must_be_managed' })
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('blocks generic creation of the Control API resource', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/resources',
      payload: {
        identifier: 'caracal-control',
        scopes: ['control:agent:write'],
      },
    })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'protected_resource' })
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('allows the Control path to create the Control API resource', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes, { prefix: '/v1' }, { actor: { scope: 'global' } })
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'provider-none-z1' }] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'res-control', identifier: 'caracal-control', scopes: ['control:agent:write'] }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/resources',
      payload: {
        identifier: 'caracal-control',
        scopes: ['control:agent:write'],
      },
    })

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'res-control', identifier: 'caracal-control' })
  })
})

describe('PATCH /v1/zones/:zoneId/resources/:id', () => {
  it('rejects gateway application rebinding outside the zone', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1/resources/res-1',
      payload: { gateway_application_id: 'app-other-zone' },
    })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'gateway_application_not_found' })
    expect(db.query).toHaveBeenCalledTimes(1)
  })

  it('returns 404 when the resource is missing during patch', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1/resources/missing',
      payload: { name: 'Missing' },
    })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'resource_not_found' })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('returns no_fields when patch does not change resource data or gateway binding', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{
            identifier: 'resource://api',
            upstream_url: 'https://api.example.com',
            credential_provider_id: 'provider-1',
            gateway_application_id: 'app-1',
          }],
        })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1/resources/res-1',
      payload: {},
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'no_fields' })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('rejects provider rebinding outside the zone', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1/resources/res-1',
      payload: { credential_provider_id: 'provider-other-zone' },
    })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'provider_not_found' })
    expect(db.query).toHaveBeenCalledTimes(1)
  })

  it('moves the gateway binding when the resource identifier changes', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{
            identifier: 'resource://api',
            upstream_url: 'https://api.example.com',
            credential_provider_id: 'provider-1',
            gateway_application_id: 'app-1',
          }],
        })
        .mockResolvedValueOnce({
          rows: [{
            id: 'res-1',
            zone_id: 'z1',
            identifier: 'resource://api/v2',
            upstream_url: 'https://api.example.com',
            scopes: ['read'],
          }],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1/resources/res-1',
      payload: { identifier: 'resource://api/v2' },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({
      identifier: 'resource://api/v2',
      gateway_application_id: 'app-1',
    })
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM gateway_resource_bindings'),
      ['resource://api', 'z1'],
    )
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO gateway_resource_bindings'),
      ['resource://api/v2', 'z1', 'app-1'],
    )
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE gateway_binding_revision'),
    )
  })

  it('rejects resource identifier patches that use the provider namespace', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{
            identifier: 'resource://api',
            upstream_url: 'https://api.example.com',
            credential_provider_id: 'provider-1',
            gateway_application_id: 'app-1',
          }],
        })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1/resources/res-1',
      payload: { identifier: 'provider://api' },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_resource_identifier' })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
    expect(client.release).toHaveBeenCalled()
  })

  it('blocks generic edits to the Control API resource', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{
            identifier: 'caracal-control',
            upstream_url: null,
            credential_provider_id: null,
            gateway_application_id: null,
          }],
        })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1/resources/res-control',
      payload: { scopes: ['control:agent:write'] },
    })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'protected_resource' })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })
})

describe('DELETE /v1/zones/:zoneId/resources/:id', () => {
  it('returns 404 when deleting a missing resource', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/zones/z1/resources/missing',
    })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'resource_not_found' })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('archives the resource and removes its gateway binding atomically', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ identifier: 'resource://api' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/zones/z1/resources/res-1',
    })

    expect(res.statusCode).toBe(204)
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM gateway_resource_bindings'),
      ['resource://api', 'z1'],
    )
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE gateway_binding_revision'),
    )
    expect(client.query).toHaveBeenCalledWith('COMMIT')
    expect(client.release).toHaveBeenCalled()
  })

  it('blocks deletion of the Control API resource', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ identifier: 'caracal-control' }] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/zones/z1/resources/res-control',
    })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'protected_resource' })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })
})
