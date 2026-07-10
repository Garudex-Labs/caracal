// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Notification sink route unit tests for URL validation, secret handling, and lifecycle.

import { describe, it, expect, vi } from 'vitest'

// Test-only deterministic KEK fixture (32-byte hex). Never use in production.
process.env.SECRET_STORE_KEK = '8f3d9a71c2b44e5f96a103d7be28cc41d5f09ab6731e4c8f2a7db56019ce34af'

const { notificationSinksRoutes, validateSinkUrl } = await import('../../../../../apps/api/src/routes/notification-sinks.js')
const { buildRouteApp } = await import('../../../../shared/test-utils/typescript/fastify.js')

const SINK_ROW = {
  id: 'sink-1',
  zone_id: 'z1',
  name: 'Pied Piper on-call relay',
  url: 'https://hooks.hooli.example/caracal',
  event_types: ['step_up_issued'],
  active: true,
  consecutive_failures: 0,
  last_success_at: null,
  last_failure_at: null,
  last_error: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
}

describe('validateSinkUrl', () => {
  it('accepts https and loopback http, rejects everything else', () => {
    expect(validateSinkUrl('https://hooks.hooli.example/caracal')).toBeNull()
    expect(validateSinkUrl('http://localhost:9099/hook')).toBeNull()
    expect(validateSinkUrl('http://127.0.0.1/hook')).toBeNull()
    expect(validateSinkUrl('http://hooks.hooli.example/caracal')).toContain('https')
    expect(validateSinkUrl('https://user:pass@hooks.hooli.example/')).toContain('credentials')
    expect(validateSinkUrl('not a url')).toContain('not a valid')
    expect(validateSinkUrl('ftp://hooks.hooli.example/')).toContain('https')
    expect(validateSinkUrl('https://169.254.169.254/latest/meta-data')).toContain('restricted')
    expect(validateSinkUrl('https://10.0.0.1/hook')).toContain('restricted')
  })
})

describe('POST /v1/zones/:zoneId/notification-sinks', () => {
  it('creates a sink and returns the signing secret exactly once', async () => {
    const { app, db } = buildRouteApp(notificationSinksRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ 1: 1 }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [SINK_ROW] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/notification-sinks',
      payload: { name: 'Pied Piper on-call relay', url: 'https://hooks.hooli.example/caracal', event_types: ['step_up_issued'] },
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.secret).toMatch(/^nsk_[0-9a-f]{48}$/)
    expect(body).not.toHaveProperty('secret_ct')
    const insert = db.query.mock.calls[2]
    expect(String(insert[0])).toContain('COALESCE(MAX(chain_seq), 0)')
    expect((insert[1] as unknown[])[5]).toEqual(['step_up_issued'])
    expect(Buffer.isBuffer((insert[1] as unknown[])[4])).toBe(true)
  })

  it('defaults to every approval event type in canonical order', async () => {
    const { app, db } = buildRouteApp(notificationSinksRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ 1: 1 }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [SINK_ROW] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/notification-sinks',
      payload: { name: 'relay', url: 'https://hooks.hooli.example/caracal' },
    })

    expect(res.statusCode).toBe(201)
    expect((db.query.mock.calls[2][1] as unknown[])[5]).toEqual(['step_up_issued', 'step_up_decided', 'step_up_consumed'])
  })

  it('rejects non-loopback plain-http endpoints', async () => {
    const { app, db } = buildRouteApp(notificationSinksRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ 1: 1 }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/notification-sinks',
      payload: { name: 'relay', url: 'http://hooks.hooli.example/caracal' },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_sink_url' })
  })

  it('returns 404 for a missing zone and 409 at the sink limit', async () => {
    const { app, db } = buildRouteApp(notificationSinksRoutes)
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const missing = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/notification-sinks',
      payload: { name: 'relay', url: 'https://hooks.hooli.example/caracal' },
    })
    expect(missing.statusCode).toBe(404)

    db.query.mockResolvedValueOnce({ rows: [{ 1: 1 }] }).mockResolvedValueOnce({ rows: [{ count: '20' }] })
    const full = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/notification-sinks',
      payload: { name: 'relay', url: 'https://hooks.hooli.example/caracal' },
    })
    expect(full.statusCode).toBe(409)
    expect(JSON.parse(full.body)).toMatchObject({ error: 'sink_limit_reached' })
  })
})

describe('PATCH /v1/zones/:zoneId/notification-sinks/:id', () => {
  it('updates fields and resets failure state when the endpoint changes', async () => {
    const { app, db } = buildRouteApp(notificationSinksRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ ...SINK_ROW, active: false }] })

    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1/notification-sinks/sink-1',
      payload: { url: 'https://hooks.piedpiper.example/caracal', active: false },
    })

    expect(res.statusCode).toBe(200)
    const update = db.query.mock.calls[0]
    expect(String(update[0])).toContain('CASE WHEN $4 IS NOT NULL THEN 0')
    expect((update[1] as unknown[])[3]).toBe('https://hooks.piedpiper.example/caracal')
    expect((update[1] as unknown[])[5]).toBe(false)
  })

  it('returns 404 when the sink is missing or outside the zone', async () => {
    const { app, db } = buildRouteApp(notificationSinksRoutes)
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1/notification-sinks/sink-1',
      payload: { active: true },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('POST /v1/zones/:zoneId/notification-sinks/:id/rotate-secret', () => {
  it('replaces the sealed secret and reveals the new value once', async () => {
    const { app, db } = buildRouteApp(notificationSinksRoutes)
    db.query.mockResolvedValueOnce({ rows: [SINK_ROW] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/notification-sinks/sink-1/rotate-secret',
      payload: {},
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).secret).toMatch(/^nsk_[0-9a-f]{48}$/)
    expect(Buffer.isBuffer((db.query.mock.calls[0][1] as unknown[])[2])).toBe(true)
  })
})

describe('DELETE /v1/zones/:zoneId/notification-sinks/:id', () => {
  it('deletes and returns 204, or 404 when nothing matched', async () => {
    const { app, db } = buildRouteApp(notificationSinksRoutes)
    db.query.mockResolvedValueOnce({ rowCount: 1, rows: [] })

    await app.ready()
    const ok = await app.inject({ method: 'DELETE', url: '/v1/zones/z1/notification-sinks/sink-1' })
    expect(ok.statusCode).toBe(204)

    db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] })
    const missing = await app.inject({ method: 'DELETE', url: '/v1/zones/z1/notification-sinks/sink-1' })
    expect(missing.statusCode).toBe(404)
  })
})

describe('GET /v1/zones/:zoneId/notification-sinks', () => {
  it('lists sinks without ever exposing secret material', async () => {
    const { app, db } = buildRouteApp(notificationSinksRoutes)
    db.query.mockResolvedValueOnce({ rows: [SINK_ROW] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/notification-sinks' })

    expect(res.statusCode).toBe(200)
    expect(String(db.query.mock.calls[0][0])).not.toContain('secret_ct')
    expect(JSON.parse(res.body).items[0]).not.toHaveProperty('secret_ct')
  })
})

describe('GET /v1/zones/:zoneId/notification-sinks/:id/deliveries', () => {
  it('lists the sink delivery record scoped to the zone', async () => {
    const { app, db } = buildRouteApp(notificationSinksRoutes)
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'd1',
          sink_id: 'sink-1',
          event_id: 'e1',
          event_type: 'step_up_issued',
          attempts: 1,
          delivered_at: '2026-01-01T00:00:01.000Z',
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/notification-sinks/sink-1/deliveries' })

    expect(res.statusCode).toBe(200)
    expect(db.query.mock.calls[0][1]).toEqual(['sink-1', 'z1', 200])
    expect(JSON.parse(res.body).items).toHaveLength(1)
  })
})
