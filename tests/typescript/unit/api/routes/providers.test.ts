// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Provider route unit tests for zone ownership and configuration updates.

import { describe, it, expect } from 'vitest'
import { providersRoutes } from '../../../../../apps/api/src/routes/providers.js'
import { buildRouteApp } from '../../../../shared/test-utils/typescript/fastify.js'

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
}

describe('POST /v1/zones/:zoneId/providers', () => {
  it('stores provider kind in provider_kind', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({
        rows: [{ id: 'provider-1', zone_id: 'z1', identifier: 'oidc-main', kind: 'oidc' }],
      })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/providers',
      payload: { identifier: 'oidc-main', kind: 'oidc', config_json: { issuer: 'https://issuer.example' } },
    })

    const values = db.query.mock.calls[1][1] as unknown[]
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'provider-1', kind: 'oidc' })
    expect(values[6]).toBe('oidc')
    expect(JSON.parse(values[7] as string)).toEqual({ issuer: 'https://issuer.example' })
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

  it('merges provider config without dropping existing columns', async () => {
    const { app, db } = buildRouteApp(providersRoutes)
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'provider-1', zone_id: 'z1', identifier: 'workload-main', kind: 'workload' }],
    })

    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1/providers/provider-1',
      payload: { kind: 'workload', config_json: { audience: 'resource://api' } },
    })

    const values = db.query.mock.calls[0][1] as unknown[]
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'provider-1', kind: 'workload' })
    expect(values.slice(0, 2)).toEqual(['provider-1', 'z1'])
    expect(values).toContain('workload')
    expect(JSON.parse(values[3] as string)).toEqual({ audience: 'resource://api' })
  })
})
