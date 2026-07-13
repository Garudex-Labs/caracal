// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Mint rate limit route unit tests for defaults, overrides, and the ceiling guard.

import { describe, it, expect } from 'vitest'
import { mintRateLimitRoutes } from '../../../../../apps/api/src/routes/mint-rate-limit.js'
import { buildRouteApp } from '../../../../shared/test-utils/typescript/fastify.js'

describe('GET /v1/mint-rate-limit', () => {
  it('returns the deployment ceiling when no override is stored', async () => {
    const { app, db } = buildRouteApp(mintRateLimitRoutes)
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/mint-rate-limit' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      limit_per_minute: 1000,
      max_per_minute: 1000,
      updated_by: null,
      updated_at: null,
    })
  })

  it('returns the stored override clamped to the ceiling', async () => {
    const { app, db } = buildRouteApp(mintRateLimitRoutes)
    db.query.mockResolvedValueOnce({
      rows: [{ limit_per_minute: 250, updated_by: 'Monica Hall', updated_at: '2026-05-05T00:00:00.000Z' }],
    })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/mint-rate-limit' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      limit_per_minute: 250,
      max_per_minute: 1000,
      updated_by: 'Monica Hall',
      updated_at: '2026-05-05T00:00:00.000Z',
    })
  })
})

describe('PUT /v1/mint-rate-limit', () => {
  it('stores a working limit within the ceiling', async () => {
    const { app, db } = buildRouteApp(mintRateLimitRoutes)
    db.query.mockResolvedValueOnce({
      rows: [{ limit_per_minute: 500, updated_by: 'admin:test-admin', updated_at: '2026-05-05T00:00:00.000Z' }],
    })

    await app.ready()
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/mint-rate-limit',
      payload: { limit_per_minute: 500 },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      limit_per_minute: 500,
      max_per_minute: 1000,
      updated_by: 'admin:test-admin',
      updated_at: '2026-05-05T00:00:00.000Z',
    })
    expect(db.query.mock.calls[0][1]).toEqual([500, 'admin:test-admin'])
  })

  it('rejects a working limit above the ceiling', async () => {
    const { app, db } = buildRouteApp(mintRateLimitRoutes)

    await app.ready()
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/mint-rate-limit',
      payload: { limit_per_minute: 5000 },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: 'rate_limit_above_ceiling', max_per_minute: 1000 })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('rejects zero, negative, and non-integer values', async () => {
    const { app, db } = buildRouteApp(mintRateLimitRoutes)

    await app.ready()
    for (const limit_per_minute of [0, -5, 1.5, 'many']) {
      const res = await app.inject({
        method: 'PUT',
        url: '/v1/mint-rate-limit',
        payload: { limit_per_minute },
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body)).toEqual({ error: 'invalid_body' })
    }
    expect(db.query).not.toHaveBeenCalled()
  })
})
