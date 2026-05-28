// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Zone CRUD route unit tests using Fastify inject with mocked DB and Redis.

import { describe, it, expect } from 'vitest'
import { zonesRoutes } from '../../../../../apps/api/src/routes/zones.js'
import { buildRouteApp } from '../../../../shared/test-utils/typescript/fastify.js'
import { vi } from 'vitest'

function txClient(rows: unknown[][]) {
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
      return { rows: rows.shift() ?? [] }
    }),
    release: vi.fn(),
  }
  return client
}

function failingTxClient(code: string) {
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] }
      if (sql.includes('SELECT dcr_enabled FROM zones')) return { rows: [{ dcr_enabled: false }] }
      if (sql.includes('SELECT id FROM applications')) return { rows: [{ id: 'app-1' }] }
      if (sql.includes('UPDATE zones SET')) return { rows: [{ id: 'z1', name: 'Zone', slug: 'zone', dcr_enabled: false }] }
      const err = new Error('permission denied')
      ;(err as unknown as { code: string }).code = code
      throw err
    }),
    release: vi.fn(),
  }
  return client
}

describe('GET /v1/zones/:id', () => {
  it('returns 404 when zone not found', async () => {
    const { app, db } = buildRouteApp(zonesRoutes)
    db.query.mockResolvedValue({ rows: [] })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/missing-id' })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'zone_not_found' })
  })

  it('returns zone when found', async () => {
    const { app, db } = buildRouteApp(zonesRoutes)
    const zone = { id: 'z1', slug: 'test-zone', dcr_enabled: false }
    db.query.mockResolvedValue({ rows: [zone] })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'z1' })
  })
})

describe('GET /v1/zones/:id/dcr-status', () => {
  it('returns the live DCR application count', async () => {
    const { app, db } = buildRouteApp(zonesRoutes)
    db.query.mockResolvedValue({ rows: [{ id: 'z1', dcr_enabled: false, live_dcr_applications: 3 }] })
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/dcr-status' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'z1', live_dcr_applications: 3 })
  })
})

describe('POST /v1/zones', () => {
  it('rejects invalid slug', async () => {
    const { app, db } = buildRouteApp(zonesRoutes)
    db.query.mockResolvedValue({ rows: [] })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones',
      payload: { name: 'Test Zone', slug: 'INVALID SLUG' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('creates zone and returns 201', async () => {
    const { app, db } = buildRouteApp(zonesRoutes)
    const created = { id: 'z2', name: 'My Zone', slug: 'my-zone', dcr_enabled: false }
    db.query.mockResolvedValue({ rows: [created] })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones',
      payload: { name: 'My Zone', slug: 'my-zone' },
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'z2', slug: 'my-zone' })
  })

  it('rejects unsupported zone configuration fields', async () => {
    const { app, db } = buildRouteApp(zonesRoutes)
    db.query.mockResolvedValue({ rows: [] })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones',
      payload: { name: 'My Zone', login_flow: 'magic' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_zone' })
  })
})

describe('PATCH /v1/zones/:id', () => {
  it('returns 400 when no fields supplied', async () => {
    const { app, db } = buildRouteApp(zonesRoutes)
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
    const { app, db } = buildRouteApp(zonesRoutes)
    db.query.mockResolvedValue({ rows: [] })
    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/missing',
      payload: { slug: 'new-slug' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('requires a shutdown choice when disabling DCR with live applications', async () => {
    const { app, db } = buildRouteApp(zonesRoutes)
    const client = txClient([
      [{ dcr_enabled: true }],
      [{ id: 'app-1' }, { id: 'app-2' }],
    ])
    db.connect.mockResolvedValue(client)
    await app.ready()

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1',
      payload: { dcr_enabled: false },
    })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'dcr_shutdown_required', live_dcr_applications: 2 })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('keeps live DCR applications when disabling registration with keep_live', async () => {
    const { app, db } = buildRouteApp(zonesRoutes)
    const zone = { id: 'z1', name: 'Zone', slug: 'zone', dcr_enabled: false }
    const client = txClient([
      [{ dcr_enabled: true }],
      [{ id: 'app-1' }],
      [zone],
      [],
    ])
    db.connect.mockResolvedValue(client)
    await app.ready()

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1',
      payload: { dcr_enabled: false, dcr_shutdown: 'keep_live' },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'z1', dcr_enabled: false })
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE zones SET'), expect.any(Array))
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE applications'), expect.any(Array))
  })

  it('archives live DCR applications and revokes related runtime state', async () => {
    const { app, db } = buildRouteApp(zonesRoutes)
    const zone = { id: 'z1', name: 'Zone', slug: 'zone', dcr_enabled: false }
    const client = txClient([
      [{ dcr_enabled: true }],
      [{ id: 'app-1' }],
      [zone],
      [{ id: 'app-1' }],
      [{ id: 'sid-1' }],
      [{ id: 'agent-1', subject_session_id: 'sid-agent', parent_id: null }],
      [{ id: 'edge-1' }],
      [], [], [],
      [],
    ])
    db.connect.mockResolvedValue(client)
    await app.ready()

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1',
      payload: { dcr_enabled: false, dcr_shutdown: 'revoke_live' },
    })

    expect(res.statusCode).toBe(200)
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE applications'), ['z1', ['app-1']])
    const archiveCall = client.query.mock.calls.find((call) => String(call[0]).includes('UPDATE applications'))
    expect(String(archiveCall?.[0])).not.toContain('updated_at')
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE sessions'), ['z1', ['app-1']])
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE agent_sessions'), ['z1', ['app-1']])
    const outboxCalls = client.query.mock.calls.filter((call) => String(call[0]).includes('INSERT INTO event_outbox'))
    expect(outboxCalls).toHaveLength(4)
  })

  it('revokes live DCR applications even when registration is already disabled', async () => {
    const { app, db } = buildRouteApp(zonesRoutes)
    const zone = { id: 'z1', name: 'Zone', slug: 'zone', dcr_enabled: false }
    const client = txClient([
      [{ dcr_enabled: false }],
      [{ id: 'app-1' }],
      [zone],
      [{ id: 'app-1' }],
      [],
      [],
      [],
      [],
    ])
    db.connect.mockResolvedValue(client)
    await app.ready()

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1',
      payload: { dcr_enabled: false, dcr_shutdown: 'revoke_live' },
    })

    expect(res.statusCode).toBe(200)
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE applications'), ['z1', ['app-1']])
  })

  it('returns an actionable error when DCR shutdown runtime grants are missing', async () => {
    const { app, db } = buildRouteApp(zonesRoutes)
    const client = failingTxClient('42501')
    db.connect.mockResolvedValue(client)
    await app.ready()

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1',
      payload: { dcr_enabled: false, dcr_shutdown: 'revoke_live' },
    })

    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body)).toMatchObject({
      error: 'dcr_shutdown_unavailable',
      message: 'DCR shutdown cannot revoke runtime state until database migrations are applied',
    })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })
})

describe('DELETE /v1/zones/:id', () => {
  it('returns 204 when row was archived', async () => {
    const { app, db } = buildRouteApp(zonesRoutes)
    db.query.mockResolvedValue({ rowCount: 1, rows: [] })
    await app.ready()
    const res = await app.inject({ method: 'DELETE', url: '/v1/zones/z1' })
    expect(res.statusCode).toBe(204)
  })

  it('returns 404 when zone is missing', async () => {
    const { app, db } = buildRouteApp(zonesRoutes)
    db.query.mockResolvedValue({ rowCount: 0, rows: [] })
    await app.ready()
    const res = await app.inject({ method: 'DELETE', url: '/v1/zones/missing' })
    expect(res.statusCode).toBe(404)
  })
})
