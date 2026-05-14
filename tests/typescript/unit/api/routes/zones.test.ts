// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Zone CRUD route unit tests using Fastify inject with mocked DB and Redis.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import type { DB } from '../../../../../apps/api/src/db.js'
import type { RedisClient } from '../../../../../apps/api/src/redis.js'
import '../../../../../apps/api/src/fastify-augmentation.js'
import { zonesRoutes } from '../../../../../apps/api/src/routes/zones.js'

function buildApp() {
  const app = Fastify({ logger: false })
  const db = {
    query: vi.fn(),
    connect: vi.fn(),
  }
  const redis = {
    incr: vi.fn(),
    expire: vi.fn(),
    xadd: vi.fn(),
  }
  app.decorate('db', db as unknown as DB)
  app.decorate('redis', redis as unknown as RedisClient)
  app.register(zonesRoutes, { prefix: '/v1' })
  return { app, db, redis }
}

describe('GET /v1/zones/:id', () => {
  it('returns 404 when zone not found', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValue({ rows: [] })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/missing-id' })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'zone_not_found' })
  })

  it('returns zone when found', async () => {
    const { app, db } = buildApp()
    const zone = { id: 'z1', org_id: 'org1', slug: 'test-zone', dcr_enabled: false }
    db.query.mockResolvedValue({ rows: [zone] })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'z1' })
  })
})

describe('POST /v1/zones', () => {
  it('rejects invalid slug', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValue({ rows: [] })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones',
      payload: { org_id: 'org1', name: 'Test Zone', slug: 'INVALID SLUG' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('creates zone and returns 201', async () => {
    const { app, db } = buildApp()
    const created = { id: 'z2', org_id: 'org1', name: 'My Zone', slug: 'my-zone', dcr_enabled: false }
    db.query.mockResolvedValue({ rows: [created] })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones',
      payload: { org_id: 'org1', name: 'My Zone', slug: 'my-zone' },
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'z2', slug: 'my-zone' })
  })
})

describe('PATCH /v1/zones/:id', () => {
  it('returns 400 when no fields supplied', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValue({ rows: [] })
    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1',
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'no_fields' })
  })

  it('returns 404 when zone not found', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValue({ rows: [] })
    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/missing',
      payload: { slug: 'new-slug' },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('DELETE /v1/zones/:id', () => {
  it('returns 204 when row was archived', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValue({ rowCount: 1, rows: [] })
    await app.ready()
    const res = await app.inject({ method: 'DELETE', url: '/v1/zones/z1' })
    expect(res.statusCode).toBe(204)
  })

  it('returns 404 when zone is missing', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValue({ rowCount: 0, rows: [] })
    await app.ready()
    const res = await app.inject({ method: 'DELETE', url: '/v1/zones/missing' })
    expect(res.statusCode).toBe(404)
  })
})
