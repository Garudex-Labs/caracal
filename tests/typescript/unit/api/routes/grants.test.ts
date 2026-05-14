// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Delegated grant route unit tests for same-zone references and scope boundaries.

import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import type { DB } from '../../../../../apps/api/src/db.js'
import type { RedisClient } from '../../../../../apps/api/src/redis.js'
import '../../../../../apps/api/src/fastify-augmentation.js'
import { grantsRoutes } from '../../../../../apps/api/src/routes/grants.js'

function buildApp() {
  const app = Fastify({ logger: false })
  const db = {
    query: vi.fn(),
    connect: vi.fn(),
  }
  const redis = { xadd: vi.fn() }
  app.decorate('db', db as unknown as DB)
  app.decorate('redis', redis as unknown as RedisClient)
  app.register(grantsRoutes, { prefix: '/v1' })
  return { app, db, redis }
}

const grantBody = {
  application_id: 'app-1',
  user_id: 'user-1',
  resource_id: 'res-1',
  scopes: ['read'],
}

describe('POST /v1/zones/:zoneId/grants', () => {
  it('rejects application references outside the zone', async () => {
    const { app, db } = buildApp()
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ application_exists: false, resource_scopes: ['read'] }] })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/grants', payload: grantBody })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'application_not_found' })
  })

  it('rejects resource references outside the zone', async () => {
    const { app, db } = buildApp()
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ application_exists: true, resource_scopes: null }] })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/grants', payload: grantBody })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'resource_not_found' })
  })

  it('rejects grant scopes outside the resource scope set', async () => {
    const { app, db } = buildApp()
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
    const { app, db } = buildApp()
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