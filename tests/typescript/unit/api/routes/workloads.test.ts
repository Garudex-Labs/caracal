// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Workload route unit tests for launcher identity lifecycle and binding validation.

import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import type { DB } from '../../../../../apps/api/src/db.js'
import '../../../../../apps/api/src/fastify-augmentation.js'
import { workloadsRoutes } from '../../../../../apps/api/src/routes/workloads.js'

function buildApp() {
  const app = Fastify({ logger: false })
  const db = { query: vi.fn() }
  app.decorate('db', db as unknown as DB)
  app.addHook('preHandler', async (req) => {
    ;(req as unknown as { actor: unknown }).actor = {
      id: 'actor-1',
      name: 'operator',
      scope: 'zone',
      capability: 'write',
      zoneId: 'z1',
      createdBy: 'admin:op',
    }
  })
  app.register(workloadsRoutes, { prefix: '/v1' })
  return { app, db }
}

const workloadRow = {
  id: 'wl-1',
  zone_id: 'z1',
  name: 'Son of Anton',
  bindings: [],
  created_at: '2026-06-01T12:00:00.000Z',
  updated_by: null,
  updated_at: null,
}

describe('POST /v1/zones/:zoneId/workloads', () => {
  it('returns 404 when creating in a missing zone', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/workloads', payload: { name: 'Son of Anton' } })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'zone_not_found' })
  })

  it('creates a workload with a generated one-time secret', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    db.query.mockResolvedValueOnce({ rows: [] })
    db.query.mockResolvedValueOnce({ rows: [workloadRow] })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/workloads', payload: { name: 'Son of Anton' } })

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'wl-1', secret: expect.stringMatching(/^ws_[A-Za-z0-9_-]+$/) })
    const insertValues = db.query.mock.calls[2][1] as unknown[]
    expect(insertValues[3]).toMatch(/^argon2id\$/)
  })

  it('rejects a duplicate workload name', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/workloads', payload: { name: 'Son of Anton' } })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'workload_name_taken' })
  })

  it('rejects a whitespace-only workload name', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/workloads', payload: { name: '   ' } })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_workload' })
  })
})

describe('GET /v1/zones/:zoneId/workloads', () => {
  it('lists workloads without secret material', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [workloadRow] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/workloads' })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body).toHaveLength(1)
    expect(body[0]).not.toHaveProperty('secret_hash')
    expect(db.query.mock.calls[0][0]).not.toContain('secret_hash')
  })
})

describe('GET /v1/zones/:zoneId/workloads/:id', () => {
  it('returns the workload', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [workloadRow] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/workloads/wl-1' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'wl-1', name: 'Son of Anton' })
  })

  it('returns 404 for a missing workload', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/workloads/missing' })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'workload_not_found' })
  })
})

describe('PUT /v1/zones/:zoneId/workloads/:id', () => {
  it('stores normalized bindings with an authorship stamp', async () => {
    const { app, db } = buildApp()
    const stored = [
      { env: 'PIPERNET_TOKEN', resource: 'resource://pipernet', scopes: ['pipernet:read'] },
      { env: 'HOOLIBOX_TOKEN', resource: 'resource://hoolibox', optional: true, on_failure: 'warn' },
    ]
    db.query.mockResolvedValueOnce({ rows: [{ ...workloadRow, bindings: stored, updated_by: 'admin:op' }] })

    await app.ready()
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/zones/z1/workloads/wl-1',
      payload: {
        bindings: [
          { env: 'PIPERNET_TOKEN', resource: 'resource://pipernet', scopes: ['pipernet:read'] },
          { env: 'HOOLIBOX_TOKEN', resource: 'resource://hoolibox', optional: true, on_failure: 'warn' },
        ],
      },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'wl-1', bindings: stored })
    const updateValues = db.query.mock.calls[0][1] as unknown[]
    expect(JSON.parse(updateValues[2] as string)).toEqual(stored)
    expect(updateValues[3]).toBe('operator')
  })

  it('rejects blocked env names', async () => {
    const { app, db } = buildApp()

    await app.ready()
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/zones/z1/workloads/wl-1',
      payload: { bindings: [{ env: 'LD_PRELOAD', resource: 'resource://pipernet' }] },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_credential_env', env: 'LD_PRELOAD' })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('rejects duplicate env names', async () => {
    const { app, db } = buildApp()

    await app.ready()
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/zones/z1/workloads/wl-1',
      payload: {
        bindings: [
          { env: 'PIPERNET_TOKEN', resource: 'resource://pipernet' },
          { env: 'PIPERNET_TOKEN', resource: 'resource://hoolibox' },
        ],
      },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'duplicate_credential_env', env: 'PIPERNET_TOKEN' })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('rejects a rename to a taken name', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const res = await app.inject({ method: 'PUT', url: '/v1/zones/z1/workloads/wl-1', payload: { name: 'Fiona' } })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'workload_name_taken' })
  })

  it('rejects an empty update', async () => {
    const { app, db } = buildApp()

    await app.ready()
    const res = await app.inject({ method: 'PUT', url: '/v1/zones/z1/workloads/wl-1', payload: {} })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'no_fields' })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('returns 404 for a missing workload', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/zones/z1/workloads/missing',
      payload: { bindings: [{ env: 'PIPERNET_TOKEN', resource: 'resource://pipernet' }] },
    })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'workload_not_found' })
  })
})

describe('POST /v1/zones/:zoneId/workloads/:id/rotate-secret', () => {
  it('issues a fresh one-time secret', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [workloadRow] })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/workloads/wl-1/rotate-secret' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'wl-1', secret: expect.stringMatching(/^ws_[A-Za-z0-9_-]+$/) })
  })

  it('returns 404 for a missing workload', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/workloads/missing/rotate-secret' })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'workload_not_found' })
  })
})

describe('DELETE /v1/zones/:zoneId/workloads/:id', () => {
  it('hard-deletes the workload so its credentials stop resolving', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rowCount: 1 })

    await app.ready()
    const res = await app.inject({ method: 'DELETE', url: '/v1/zones/z1/workloads/wl-1' })

    expect(res.statusCode).toBe(204)
    expect(db.query.mock.calls[0][0]).toContain('DELETE FROM workloads')
  })

  it('returns 404 for a missing workload', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rowCount: 0 })

    await app.ready()
    const res = await app.inject({ method: 'DELETE', url: '/v1/zones/z1/workloads/missing' })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'workload_not_found' })
  })
})
