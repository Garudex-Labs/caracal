// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Resource route unit tests for same-zone provider ownership.

import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import { resourcesRoutes } from '../../../../../apps/api/src/routes/resources.js'

function buildApp() {
  const app = Fastify({ logger: false })
  const db = {
    query: vi.fn(),
    connect: vi.fn(),
  }
  app.decorate('db', db as never)
  app.decorate('redis', { xadd: vi.fn() } as never)
  app.register(resourcesRoutes, { prefix: '/v1' })
  return { app, db }
}

describe('POST /v1/zones/:zoneId/resources', () => {
  it('rejects provider references outside the zone', async () => {
    const { app, db } = buildApp()
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

  it('creates a resource when provider belongs to the zone', async () => {
    const { app, db } = buildApp()
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ exists: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'res-1', zone_id: 'z1', credential_provider_id: 'provider-1' }] })

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

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'res-1', credential_provider_id: 'provider-1' })
  })
})

describe('PATCH /v1/zones/:zoneId/resources/:id', () => {
  it('rejects provider rebinding outside the zone', async () => {
    const { app, db } = buildApp()
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
})