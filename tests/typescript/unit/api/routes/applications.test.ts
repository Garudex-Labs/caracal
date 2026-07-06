// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Application route unit tests for dynamic client registration zone controls.

import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import type { DB } from '../../../../../apps/api/src/db.js'
import type { RedisClient } from '../../../../../apps/api/src/redis.js'
import '../../../../../apps/api/src/fastify-augmentation.js'
import { applicationsRoutes } from '../../../../../apps/api/src/routes/applications.js'

function buildApp(scope: 'zone' | 'global' | 'provisioner' = 'zone') {
  const app = Fastify({ logger: false })
  const clientQuery = vi.fn()
  const db = {
    query: vi.fn(),
    connect: vi.fn().mockResolvedValue({
      query: clientQuery,
      release: vi.fn(),
    }),
  }
  const redis = {
    set: vi.fn().mockResolvedValue('OK'),
    incr: vi.fn(),
    expire: vi.fn(),
  }
  app.decorate('db', db as unknown as DB)
  app.decorate('redis', redis as unknown as RedisClient)
  app.addHook('preHandler', async (req) => {
    ;(req as unknown as { actor: unknown }).actor =
      scope === 'zone'
        ? { id: 'actor-1', name: 'operator', scope: 'zone', capability: 'write', zoneId: 'z1', createdBy: 'admin:op' }
        : scope === 'provisioner'
          ? { id: 'actor-1', name: 'bootstrap', scope: 'global', capability: 'write', zoneId: null, createdBy: 'env-bootstrap' }
          : { id: 'actor-1', name: 'operator', scope: 'global', capability: 'write', zoneId: null, createdBy: 'env-derived-write' }
  })
  app.register(applicationsRoutes, { prefix: '/v1' })
  return { app, db, clientQuery, redis }
}

describe('POST /v1/zones/:zoneId/applications', () => {
  it('returns 404 when creating in a missing zone', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/applications',
      payload: { name: 'Runner', registration_method: 'managed' },
    })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'zone_not_found' })
  })

  it('creates managed applications with a generated one-time client secret', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    db.query.mockResolvedValueOnce({ rows: [] })
    db.query.mockResolvedValueOnce({ rows: [{ id: 'app-1', zone_id: 'z1', name: 'Runner', registration_method: 'managed' }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/applications',
      payload: { name: 'Runner', registration_method: 'managed' },
    })

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'app-1', client_secret: expect.stringMatching(/^cs_[A-Za-z0-9_-]+$/) })
    expect(db.query).toHaveBeenCalledTimes(3)
  })

  it('rejects a duplicate active managed application name', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/applications',
      payload: { name: 'Runner', registration_method: 'managed' },
    })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'application_name_taken' })
    expect(db.query).toHaveBeenCalledTimes(2)
  })

  it('rejects a whitespace-only application name', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/applications',
      payload: { name: '   ', registration_method: 'managed' },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_application' })
  })

  it('rejects an application name longer than the maximum length', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/applications',
      payload: { name: 'a'.repeat(201), registration_method: 'managed' },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_application' })
  })

  it('rejects Control-key minting traits from a zone-scoped actor on the managed route', async () => {
    const { app, db } = buildApp('zone')
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/applications',
      payload: {
        name: 'Backdoor Key',
        registration_method: 'managed',
        traits: ['control:invoke', 'control:scope:app:write'],
      },
    })

    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'trait_forbidden' })
    expect(db.query).toHaveBeenCalledTimes(1)
  })

  it('rejects a reserved caracal.sys application name from a zone-scoped tenant', async () => {
    const { app, db } = buildApp('zone')
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/applications',
      payload: { name: 'caracal.sys/operator', registration_method: 'managed' },
    })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'reserved_namespace' })
    // The tenant is refused before any application row is written.
    expect(db.query).toHaveBeenCalledTimes(1)
  })

  it('rejects a reserved caracal.sys application name from a non-provisioner global actor', async () => {
    const { app, db } = buildApp('global')
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/applications',
      payload: { name: 'caracal.sys/operator', registration_method: 'managed' },
    })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'reserved_namespace' })
    // A global Console or external admin token is refused before any application row is written.
    expect(db.query).toHaveBeenCalledTimes(1)
  })

  it('allows the internal provisioner to register a reserved caracal.sys application', async () => {
    const { app, db } = buildApp('provisioner')
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    db.query.mockResolvedValueOnce({ rows: [] })
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'app-sys', zone_id: 'z1', name: 'caracal.sys/operator', registration_method: 'managed' }],
    })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/applications',
      payload: { name: 'caracal.sys/operator', registration_method: 'managed' },
    })

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'app-sys' })
  })

  it('rejects unsupported credential types', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/applications',
      payload: {
        name: 'Browser',
        registration_method: 'managed',
        credential_type: 'public',
      },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_application' })
    expect(db.query).toHaveBeenCalledTimes(1)
  })

  it('rejects DCR registration through the managed application route', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/applications',
      payload: {
        name: 'Dynamic App',
        registration_method: 'dcr',
      },
    })

    expect(res.statusCode).toBe(400)
    expect(db.query).toHaveBeenCalledTimes(1)
  })

  it('rejects unused application consent configuration', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/applications',
      payload: {
        name: 'Runner',
        registration_method: 'managed',
        consent: true,
      },
    })

    expect(res.statusCode).toBe(400)
    expect(db.query).toHaveBeenCalledTimes(1)
  })
})

describe('POST /v1/zones/:zoneId/applications/dcr', () => {
  it('returns 404 when DCR targets a missing zone', async () => {
    const { app, clientQuery, redis } = buildApp()
    redis.incr.mockResolvedValueOnce(1)
    clientQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/applications/dcr',
      payload: { name: 'Dynamic App' },
    })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'zone_not_found' })
  })

  it('rejects DCR when the zone has disabled it', async () => {
    const { app, clientQuery, redis } = buildApp()
    redis.incr.mockResolvedValueOnce(1)
    clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ dcr_enabled: false }] }) // zone select
      .mockResolvedValueOnce({ rows: [] }) // ROLLBACK

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/applications/dcr',
      payload: { name: 'Dynamic App' },
    })

    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'dcr_disabled' })
  })

  it('creates a DCR application when the zone enables it', async () => {
    const { app, clientQuery, redis } = buildApp()
    redis.incr.mockResolvedValueOnce(1)
    clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ dcr_enabled: true }] })
      .mockResolvedValueOnce({ rows: [{ n: '0' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'app-1', zone_id: 'z1', registration_method: 'dcr', expires_at: '2026-05-28T09:00:00.000Z' }] })
      .mockResolvedValueOnce({ rows: [] }) // COMMIT

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/applications/dcr',
      payload: { name: 'Dynamic App' },
    })

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({
      id: 'app-1',
      registration_method: 'dcr',
      expires_at: '2026-05-28T09:00:00.000Z',
      client_secret: expect.stringMatching(/^cs_[A-Za-z0-9_-]+$/),
    })
    const insertCall = clientQuery.mock.calls.find((call) => String(call[0]).includes('INSERT INTO applications'))
    expect(insertCall?.[1]?.[6]).toBe(3600)
  })

  it('rejects DCR lifetimes above the one-hour maximum', async () => {
    const { app, db, redis } = buildApp()
    redis.incr.mockResolvedValueOnce(1)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/applications/dcr',
      payload: { name: 'Dynamic App', expires_in: 3601 },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_application' })
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('rejects internal traits on DCR registration', async () => {
    const { app, db } = buildApp()

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/applications/dcr',
      payload: { name: 'Dynamic App', traits: ['control:invoke'] },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_application' })
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('returns 429 when the DCR rate limit is exceeded', async () => {
    const { app, db, redis } = buildApp()
    redis.incr.mockResolvedValueOnce(11)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/applications/dcr',
      payload: { name: 'Dynamic App' },
    })

    expect(res.statusCode).toBe(429)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'dcr_rate_limit_exceeded' })
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('returns 429 when the active DCR application cap is reached', async () => {
    const { app, clientQuery, redis } = buildApp()
    redis.incr.mockResolvedValueOnce(1)
    clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ dcr_enabled: true }] })
      .mockResolvedValueOnce({ rows: [{ n: '1000' }] })
      .mockResolvedValueOnce({ rows: [] }) // ROLLBACK

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/applications/dcr',
      payload: { name: 'Dynamic App' },
    })

    expect(res.statusCode).toBe(429)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'dcr_limit_exceeded' })
  })
})

describe('GET /v1/zones/:zoneId/applications', () => {
  it('lists applications for the zone', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({
      rows: [
        { id: 'app-1', name: 'One' },
        { id: 'app-2', name: 'Two' },
      ],
    })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/applications' })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.items).toHaveLength(2)
    expect(body.next_cursor).toBeNull()
    expect(String(db.query.mock.calls[0][0])).toContain('archived_at IS NULL')
  })

  it('lists archived applications for audit when requested', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'app-3', name: 'Retired', archived_at: '2026-07-01T00:00:00.000Z' }],
    })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/applications?status=archived' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).items).toHaveLength(1)
    expect(String(db.query.mock.calls[0][0])).toContain('archived_at IS NOT NULL')
  })

  it('rejects an unknown status filter', async () => {
    const { app } = buildApp()
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/applications?status=all' })
    expect(res.statusCode).toBe(400)
  })

  it('includes internal traits only for Control callers and paginates full pages', async () => {
    const { app, db } = buildApp('global')
    db.query.mockResolvedValueOnce({
      rows: [
        { id: 'app-2', name: 'Two', traits: ['control:invoke'], created_at: '2026-01-02T00:00:00.000Z' },
        { id: 'app-1', name: 'One', traits: [], created_at: '2026-01-01T00:00:00.000Z' },
      ],
    })

    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones/z1/applications?limit=2',
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).next_cursor).toEqual(expect.any(String))
    expect(String(db.query.mock.calls[0][0])).toContain('traits')
  })
})

describe('GET /v1/zones/:zoneId/applications/:id', () => {
  it('returns a single application', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ id: 'app-1', name: 'One' }] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/applications/app-1' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'app-1' })
  })

  it('returns 404 when the application is missing', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/applications/missing' })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'application_not_found' })
  })

  it('includes internal traits on detail only for Control callers', async () => {
    const { app, db } = buildApp('global')
    db.query.mockResolvedValueOnce({ rows: [{ id: 'app-1', name: 'One', traits: ['control:invoke'] }] })

    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones/z1/applications/app-1',
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ traits: ['control:invoke'] })
    expect(String(db.query.mock.calls[0][0])).toContain('traits')
  })
})

describe('PATCH /v1/zones/:zoneId/applications/:id', () => {
  it('updates the application name', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [] })
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'app-1',
          zone_id: 'z1',
          name: 'Renamed',
          registration_method: 'managed',
          expires_at: null,
          created_by: 'admin:op-1',
          created_via_operator: false,
          updated_by: 'admin:op-1',
          updated_via_operator: false,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
        },
      ],
    })

    await app.ready()
    const res = await app.inject({ method: 'PATCH', url: '/v1/zones/z1/applications/app-1', payload: { name: 'Renamed' } })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'app-1', zone_id: 'z1', name: 'Renamed', registration_method: 'managed' })
  })

  it('rejects renaming to a name held by another active managed application', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const res = await app.inject({ method: 'PATCH', url: '/v1/zones/z1/applications/app-1', payload: { name: 'Taken' } })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'application_name_taken' })
  })

  it('rejects an empty patch with no_fields', async () => {
    const { app } = buildApp()

    await app.ready()
    const res = await app.inject({ method: 'PATCH', url: '/v1/zones/z1/applications/app-1', payload: {} })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'no_fields' })
  })

  it('returns 404 when patching a missing application', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [] })
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({ method: 'PATCH', url: '/v1/zones/z1/applications/missing', payload: { name: 'X' } })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'application_not_found' })
  })

  it('rejects a client secret shorter than the minimum length', async () => {
    const { app, db } = buildApp()

    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1/applications/app-1',
      payload: { client_secret: 'cs_short' },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_application' })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('rejects client secret rotation when none is configured', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ client_secret_hash: null }] })

    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1/applications/app-1',
      payload: { client_secret: `cs_${'a'.repeat(43)}` },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'client_secret_not_configured' })
  })

  it('returns 404 before secret rotation when the application is missing', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1/applications/missing',
      payload: { client_secret: `cs_${'a'.repeat(43)}` },
    })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'application_not_found' })
  })
})

describe('POST /v1/zones/:zoneId/applications/:id/rotate-secret', () => {
  it('issues a fresh server-generated client secret', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ id: 'app-1', zone_id: 'z1', name: 'Runner', registration_method: 'managed' }] })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/applications/app-1/rotate-secret', payload: {} })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'app-1', client_secret: expect.stringMatching(/^cs_[A-Za-z0-9_-]+$/) })
    const updateCall = db.query.mock.calls[0]
    expect(String(updateCall[0])).toContain('SET client_secret_hash')
    expect(updateCall[1]).toEqual(['app-1', 'z1', expect.any(String), 'admin:actor-1', false])
  })

  it('returns 404 when rotating a missing application', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/applications/missing/rotate-secret', payload: {} })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'application_not_found' })
  })
})

describe('DELETE /v1/zones/:zoneId/applications/:id', () => {
  function deleteClient(appRowCount: number) {
    return {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('UPDATE applications')) return Promise.resolve({ rowCount: appRowCount })
        return Promise.resolve({ rows: [], rowCount: 0 })
      }),
      release: vi.fn(),
    }
  }

  it('archives an existing application', async () => {
    const { app, db } = buildApp()
    db.connect.mockResolvedValueOnce(deleteClient(1))

    await app.ready()
    const res = await app.inject({ method: 'DELETE', url: '/v1/zones/z1/applications/app-1' })

    expect(res.statusCode).toBe(204)
  })

  it('returns 404 when archiving a missing application', async () => {
    const { app, db } = buildApp()
    db.connect.mockResolvedValueOnce(deleteClient(0))

    await app.ready()
    const res = await app.inject({ method: 'DELETE', url: '/v1/zones/z1/applications/missing' })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'application_not_found' })
  })
})
