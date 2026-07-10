// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Audit retention route unit tests for defaults, overrides, and the ceiling guard.

import { describe, it, expect } from 'vitest'
import { auditRetentionRoutes } from '../../../../../apps/api/src/routes/audit-retention.js'
import { buildRouteApp } from '../../../../shared/test-utils/typescript/fastify.js'

describe('GET /v1/audit-retention', () => {
  it('returns the deployment ceiling when no override is stored', async () => {
    const { app, db } = buildRouteApp(auditRetentionRoutes)
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/audit-retention' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ retention_days: 365, max_days: 365, updated_by: null, updated_at: null })
  })

  it('returns the stored override clamped to the ceiling', async () => {
    const { app, db } = buildRouteApp(auditRetentionRoutes)
    db.query.mockResolvedValueOnce({
      rows: [{ retention_days: 90, updated_by: 'Monica Hall', updated_at: '2026-05-05T00:00:00.000Z' }],
    })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/audit-retention' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      retention_days: 90,
      max_days: 365,
      updated_by: 'Monica Hall',
      updated_at: '2026-05-05T00:00:00.000Z',
    })
  })
})

describe('PUT /v1/audit-retention', () => {
  it('stores a window within the ceiling', async () => {
    const { app, db } = buildRouteApp(auditRetentionRoutes)
    db.query.mockResolvedValueOnce({
      rows: [{ retention_days: 30, updated_by: 'admin:test-admin', updated_at: '2026-05-05T00:00:00.000Z' }],
    })

    await app.ready()
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/audit-retention',
      payload: { retention_days: 30 },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      retention_days: 30,
      max_days: 365,
      updated_by: 'admin:test-admin',
      updated_at: '2026-05-05T00:00:00.000Z',
    })
    expect(db.query.mock.calls[0][1]).toEqual([30, 'admin:test-admin'])
  })

  it('rejects a window above the ceiling', async () => {
    const { app, db } = buildRouteApp(auditRetentionRoutes)

    await app.ready()
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/audit-retention',
      payload: { retention_days: 400 },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: 'retention_above_limit', max_days: 365 })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('rejects zero, negative, and non-integer values', async () => {
    const { app, db } = buildRouteApp(auditRetentionRoutes)

    await app.ready()
    for (const retention_days of [0, -5, 1.5, 'ninety']) {
      const res = await app.inject({
        method: 'PUT',
        url: '/v1/audit-retention',
        payload: { retention_days },
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body)).toEqual({ error: 'invalid_body' })
    }
    expect(db.query).not.toHaveBeenCalled()
  })
})
