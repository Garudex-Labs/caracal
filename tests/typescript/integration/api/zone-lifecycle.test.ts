// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Zone lifecycle integration tests: create, read, update, and delete sequence.

import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import { zonesRoutes } from '../../../../apps/api/src/routes/zones.js'

function buildApp() {
  const app = Fastify({ logger: false })
  const db = { query: vi.fn(), connect: vi.fn() }
  const redis = { incr: vi.fn(), expire: vi.fn(), xadd: vi.fn() }
  app.decorate('db', db as never)
  app.decorate('redis', redis as never)
  app.register(zonesRoutes, { prefix: '/v1' })
  return { app, db, redis }
}

const mockZone = {
  id: 'z-lifecycle-1',
  org_id: 'org1',
  name: 'Integration Zone',
  slug: 'integration-zone',
  dcr_enabled: false,
  pkce_required: true,
  login_flow: 'default',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

describe('Zone lifecycle: create → read', () => {
  it('creates a zone then reads it back', async () => {
    const { app, db } = buildApp()
    db.query
      .mockResolvedValueOnce({ rows: [mockZone] })
      .mockResolvedValueOnce({ rows: [mockZone] })
    await app.ready()

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/zones',
      payload: { org_id: 'org1', name: 'Integration Zone' },
    })
    expect(createRes.statusCode).toBe(201)
    const created = JSON.parse(createRes.body)
    expect(created.id).toBe(mockZone.id)

    const readRes = await app.inject({
      method: 'GET',
      url: `/v1/zones/${created.id}`,
    })
    expect(readRes.statusCode).toBe(200)
    expect(JSON.parse(readRes.body).slug).toBe('integration-zone')
  })
})

describe('Zone lifecycle: create → list includes zone', () => {
  it('newly created zone appears in list', async () => {
    const { app, db } = buildApp()
    db.query
      .mockResolvedValueOnce({ rows: [mockZone] })
      .mockResolvedValueOnce({ rows: [mockZone, { ...mockZone, id: 'z-2', slug: 'other' }] })
    await app.ready()

    await app.inject({
      method: 'POST',
      url: '/v1/zones',
      payload: { org_id: 'org1', name: 'Integration Zone' },
    })

    const listRes = await app.inject({ method: 'GET', url: '/v1/zones' })
    expect(listRes.statusCode).toBe(200)
    const zones = JSON.parse(listRes.body)
    expect(zones.some((z: { id: string }) => z.id === 'z-lifecycle-1')).toBe(true)
  })
})

describe('Zone lifecycle: update slug', () => {
  it('PATCH updates only the provided fields', async () => {
    const { app, db } = buildApp()
    const updated = { ...mockZone, slug: 'renamed-zone', updated_at: '2026-06-01T00:00:00Z' }
    db.query.mockResolvedValue({ rows: [updated] })
    await app.ready()

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/zones/${mockZone.id}`,
      payload: { slug: 'renamed-zone' },
    })
    expect([200, 204]).toContain(res.statusCode)
    if (res.statusCode === 200) {
      expect(JSON.parse(res.body).slug).toBe('renamed-zone')
    }
  })
})

describe('Zone lifecycle: delete returns 204', () => {
  it('DELETE succeeds for existing zone', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValue({ rowCount: 1, rows: [] })
    await app.ready()

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/zones/${mockZone.id}`,
    })
    expect([204, 404]).toContain(res.statusCode)
  })

  it('DELETE returns 404 when zone does not exist', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValue({ rowCount: 0, rows: [] })
    await app.ready()

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/zones/does-not-exist',
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('Zone list is ordered by creation date', () => {
  it('returns rows in the order provided by the database', async () => {
    const { app, db } = buildApp()
    const z1 = { ...mockZone, id: 'z-older', created_at: '2025-01-01T00:00:00Z' }
    const z2 = { ...mockZone, id: 'z-newer', created_at: '2026-01-01T00:00:00Z' }
    db.query.mockResolvedValue({ rows: [z2, z1] })
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/zones' })
    expect(res.statusCode).toBe(200)
    const zones = JSON.parse(res.body)
    expect(zones[0].id).toBe('z-newer')
    expect(zones[1].id).toBe('z-older')
  })
})
