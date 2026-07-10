// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Coordinator application factory tests for operational endpoint behavior.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../shared/test-utils/typescript/coordinatorEnv.js'

vi.mock('../../../../../apps/coordinator/src/auth.js', () => ({
  verifyBearer: async () => {},
}))

const { buildApp } = await import('../../../../../apps/coordinator/src/app.js')

describe('buildApp operational endpoints', () => {
  it('keeps health independent of Redis-backed global rate limiting', async () => {
    const redis = { incr: vi.fn(() => Promise.reject(new Error('redis down'))) }
    const app = await buildApp({
      cfg: { requestTimeoutMs: 1000, trustProxy: false, coordinatorRateLimitPerMin: 10 },
      db: {},
      redis,
    } as never)
    const response = await app.inject({ method: 'GET', url: '/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true })
    expect(redis.incr).not.toHaveBeenCalled()
    await app.close()
  })

  it('reuses runtime aggregate stats across metrics and stats requests', async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ status: 'running', n: '2' }] })
        .mockResolvedValueOnce({ rows: [{ status: 'published', n: '3' }] })
        .mockResolvedValueOnce({ rows: [{ n: '4', oldest_seconds: '120' }] }),
    }
    const app = await buildApp({
      cfg: {
        requestTimeoutMs: 1000,
        trustProxy: false,
        coordinatorRateLimitPerMin: 0,
      },
      db,
      redis: {},
    } as never)

    await app.ready()
    const metrics = await app.inject({ method: 'GET', url: '/metrics' })
    const stats = await app.inject({ method: 'GET', url: '/stats' })

    expect(metrics.statusCode).toBe(200)
    expect(metrics.body).toContain('caracal_invocations_total{status="running"} 2')
    expect(stats.statusCode).toBe(200)
    expect(stats.json()).toMatchObject({
      invocations: { running: 2 },
      outbox: { published: 3 },
      idempotency: { rows: 4, oldestSeconds: 120 },
    })
    expect(metrics.body).toContain('caracal_idempotency_receipts 4')
    expect(db.query).toHaveBeenCalledTimes(3)
    await app.close()
  })

  describe('/ready endpoint', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('returns 503 instead of hanging when a dependency check times out', async () => {
      const db = { query: vi.fn(() => new Promise(() => {})) }
      const app = await buildApp({
        cfg: {
          requestTimeoutMs: 1000,
          trustProxy: false,
          coordinatorRateLimitPerMin: 0,
        },
        db,
        redis: { ping: vi.fn(async () => 'PONG') },
      } as never)

      const response = app.inject({ method: 'GET', url: '/ready' })
      await vi.advanceTimersByTimeAsync(5_000)
      const res = await response

      expect(res.statusCode).toBe(503)
      expect(res.json()).toMatchObject({ ok: false, error: 'postgres_unreachable', dependency: 'postgres' })
      await app.close()
    })

    it('reports a fast ok when both dependencies respond, probing them concurrently', async () => {
      vi.useRealTimers()
      const db = { query: vi.fn(async () => ({ rows: [{ '?column?': 1 }] })) }
      const redis = { ping: vi.fn(async () => 'PONG') }
      const app = await buildApp({
        cfg: { requestTimeoutMs: 1000, trustProxy: false, coordinatorRateLimitPerMin: 0 },
        db,
        redis,
      } as never)

      const res = await app.inject({ method: 'GET', url: '/ready' })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ ok: true })
      expect(db.query).toHaveBeenCalledTimes(1)
      expect(redis.ping).toHaveBeenCalledTimes(1)
      await app.close()
    })

    it('returns 503 redis_unreachable when only Redis is unhealthy', async () => {
      const db = { query: vi.fn(async () => ({ rows: [{ '?column?': 1 }] })) }
      const redis = { ping: vi.fn(() => new Promise(() => {})) }
      const app = await buildApp({
        cfg: { requestTimeoutMs: 1000, trustProxy: false, coordinatorRateLimitPerMin: 0 },
        db,
        redis,
      } as never)

      const response = app.inject({ method: 'GET', url: '/ready' })
      await vi.advanceTimersByTimeAsync(5_000)
      const res = await response

      expect(res.statusCode).toBe(503)
      expect(res.json()).toMatchObject({ ok: false, error: 'redis_unreachable', dependency: 'redis' })
      await app.close()
    })
  })
})
