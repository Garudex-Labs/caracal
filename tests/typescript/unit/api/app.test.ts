// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for app-wide hooks: /v1 rate limit and security response headers.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildApp } from '../../../../apps/api/src/app.js'
import type { Config } from '../../../../apps/api/src/config.js'
import type { DB } from '../../../../apps/api/src/db.js'
import type { RedisClient } from '../../../../apps/api/src/redis.js'

function makeCfg(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    databaseUrl: 'postgres://x',
    redisUrl: 'redis://x',
    logLevel: 'silent',
    bootstrapAdminToken: null,
    shutdownGraceMs: 1000,
    workerId: 'test',
    bodyLimitBytes: 1_048_576,
    requestTimeoutMs: 30_000,
    db: { poolMax: 1, statementTimeoutMs: 1000, idleInTxTimeoutMs: 1000, connectionTimeoutMs: 1000, idleTimeoutMs: 1000 },
    outbox: { pollIntervalMs: 100, batchSize: 1, lockDurationSec: 30, maxAttempts: 5, streamMaxLen: 100 },
    readyRateLimitPerMin: 0,
    v1RateLimitPerMin: 0,
    adminAuthFailLimitPerMin: 0,
    lastUsedDebounceSec: 0,
    maxResourcesPerZone: 100_000,
    readyOutboxDeadMax: 0,
    trustProxy: false,
    enableDocs: false,
    stsUrl: 'http://localhost:8080',
    gatewayStsHmacKey: null,
    metricsBearer: null,
    ...overrides,
  }
}

function makeRedis(initialIncr = 0) {
  const counters = new Map<string, number>()
  return {
    incr: vi.fn(async (k: string) => {
      const next = (counters.get(k) ?? initialIncr) + 1
      counters.set(k, next)
      return next
    }),
    expire: vi.fn(async () => 1),
    set: vi.fn(async () => 'OK' as const),
    ping: vi.fn(async () => 'PONG'),
    get: vi.fn(async () => null),
    del: vi.fn(async () => 1),
  } as unknown as RedisClient
}

function makeDb(): DB {
  return {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    connect: vi.fn(),
    end: vi.fn(),
  } as unknown as DB
}

let envBackup: NodeJS.ProcessEnv

beforeEach(() => {
  envBackup = { ...process.env }
})
afterEach(() => {
  process.env = envBackup
})

describe('app v1 rate limit', () => {
  it('returns 429 when per-IP minute counter exceeds limit', async () => {
    const cfg = makeCfg({ v1RateLimitPerMin: 1 })
    const redis = makeRedis(1)
    const app = await buildApp({ cfg, db: makeDb(), redis })
    const res = await app.inject({ method: 'GET', url: '/v1/zones', headers: { authorization: 'Bearer x' } })
    expect(res.statusCode).toBe(429)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'rate_limited' })
    await app.close()
  })

  it('does not rate-limit /health', async () => {
    const cfg = makeCfg({ v1RateLimitPerMin: 1 })
    const redis = makeRedis(99)
    const app = await buildApp({ cfg, db: makeDb(), redis })
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('skips counter entirely when limit is 0', async () => {
    const cfg = makeCfg({ v1RateLimitPerMin: 0 })
    const redis = makeRedis()
    const app = await buildApp({ cfg, db: makeDb(), redis })
    await app.inject({ method: 'GET', url: '/v1/zones', headers: { authorization: 'Bearer x' } })
    expect(redis.incr).not.toHaveBeenCalled()
    await app.close()
  })
})

describe('canonical error shape', () => {
  it('emits error, error_description, and requestId on parse failures', async () => {
    const cfg = makeCfg()
    const app = await buildApp({ cfg, db: makeDb(), redis: makeRedis() })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones',
      headers: { 'content-type': 'application/json' },
      payload: '{ not valid json',
    })
    const body = JSON.parse(res.body)
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(body.error).toBe('internal_error')
    expect(typeof body.error_description).toBe('string')
    expect(body.requestId).toBe(res.headers['x-request-id'])
    await app.close()
  })
})

describe('security response headers', () => {
  it('sets nosniff/no-referrer/no-store on /v1 responses', async () => {
    const cfg = makeCfg()
    const app = await buildApp({ cfg, db: makeDb(), redis: makeRedis() })
    const res = await app.inject({ method: 'GET', url: '/v1/zones', headers: { authorization: 'Bearer x' } })
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    expect(res.headers['cache-control']).toBe('no-store')
    await app.close()
  })

  it('does not add no-store on /health', async () => {
    const cfg = makeCfg()
    const app = await buildApp({ cfg, db: makeDb(), redis: makeRedis() })
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.headers['cache-control']).toBeUndefined()
    await app.close()
  })
})

describe('/metrics endpoint', () => {
  it('returns Prometheus text exposition with observability counters', async () => {
    process.env.CARACAL_MODE = 'dev'
    const cfg = makeCfg()
    const app = await buildApp({ cfg, db: makeDb(), redis: makeRedis() })
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/plain/)
    expect(res.body).toContain('caracal_log_emitted_total')
    expect(res.body).toContain('# TYPE caracal_log_emitted_total counter')
    expect(res.body).toContain('caracal_api_outbox_dead_total')
    await app.close()
  })

  it('refuses unauthenticated metrics in published builds without a configured bearer', async () => {
    process.env.CARACAL_MODE = 'stable'
    const cfg = makeCfg({ metricsBearer: null })
    const app = await buildApp({ cfg, db: makeDb(), redis: makeRedis() })
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('requires a constant-length bearer when metrics auth is configured', async () => {
    const cfg = makeCfg({ metricsBearer: 'metrics-token' })
    const app = await buildApp({ cfg, db: makeDb(), redis: makeRedis() })

    const missing = await app.inject({ method: 'GET', url: '/metrics' })
    const wrongLength = await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer short' } })

    expect(missing.statusCode).toBe(401)
    expect(wrongLength.statusCode).toBe(401)
    await app.close()
  })

  it('renders numeric string and missing outbox health values as metrics', async () => {
    const cfg = makeCfg({ metricsBearer: 'metrics-token' })
    const db = {
      query: vi.fn(async () => ({
        rows: [{
          pending_count: '3',
          dead_count: '0',
          oldest_pending_age_seconds: '12.5',
          oldest_dead_age_seconds: null,
        }],
        rowCount: 1,
      })),
      connect: vi.fn(),
      end: vi.fn(),
    } as unknown as DB
    const app = await buildApp({ cfg, db, redis: makeRedis() })

    const res = await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer metrics-token' } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('caracal_api_outbox_pending_total 3')
    expect(res.body).toContain('caracal_api_outbox_oldest_pending_age_seconds 12.5')
    expect(res.body).toContain('caracal_api_outbox_oldest_dead_age_seconds 0')
    await app.close()
  })
})

describe('/ready endpoint', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('returns 503 instead of hanging when a dependency check times out', async () => {
    const cfg = makeCfg()
    const db = {
      query: vi.fn(() => new Promise(() => {})),
      connect: vi.fn(),
      end: vi.fn(),
    } as unknown as DB
    const app = await buildApp({ cfg, db, redis: makeRedis() })

    const response = app.inject({ method: 'GET', url: '/ready' })
    await vi.advanceTimersByTimeAsync(5_000)
    const res = await response

    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ ok: false, error: 'postgres_unreachable', dependency: 'postgres' })
    await app.close()
  })

  it('returns 503 when abandoned outbox rows exceed the readiness limit', async () => {
    const cfg = makeCfg({ readyOutboxDeadMax: 0 })
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [{
            pending_count: 0,
            dead_count: 1,
            oldest_pending_age_seconds: 0,
            oldest_dead_age_seconds: 30,
          }],
          rowCount: 1,
        }),
      connect: vi.fn(),
      end: vi.fn(),
    } as unknown as DB
    const app = await buildApp({ cfg, db, redis: makeRedis() })

    const res = await app.inject({ method: 'GET', url: '/ready' })

    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ ok: false, error: 'outbox_dead_messages', deadCount: 1, limit: 0 })
    await app.close()
  })

  it('rate-limits readiness checks before touching dependencies', async () => {
    const cfg = makeCfg({ readyRateLimitPerMin: 1 })
    const redis = makeRedis(1)
    const db = makeDb()
    const app = await buildApp({ cfg, db, redis })

    const res = await app.inject({ method: 'GET', url: '/ready' })

    expect(res.statusCode).toBe(429)
    expect(res.json()).toMatchObject({ error: 'rate_limited' })
    expect(db.query).not.toHaveBeenCalled()
    await app.close()
  })

  it('returns draining and redis dependency failures explicitly', async () => {
    const draining = await buildApp({ cfg: makeCfg(), db: makeDb(), redis: makeRedis(), isDraining: () => true })
    const drainingRes = await draining.inject({ method: 'GET', url: '/ready' })
    expect(drainingRes.statusCode).toBe(503)
    expect(drainingRes.json()).toMatchObject({ ok: false, draining: true })
    await draining.close()

    const redis = makeRedis()
    vi.mocked(redis.ping).mockResolvedValueOnce('NOPE')
    const redisApp = await buildApp({ cfg: makeCfg(), db: makeDb(), redis })
    const redisRes = await redisApp.inject({ method: 'GET', url: '/ready' })
    expect(redisRes.statusCode).toBe(503)
    expect(redisRes.json()).toMatchObject({ ok: false, error: 'redis_unreachable', dependency: 'redis' })
    await redisApp.close()
  })

  it('returns outbox dependency failures separately from postgres health', async () => {
    const cfg = makeCfg()
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 })
        .mockRejectedValueOnce(new Error('outbox failed')),
      connect: vi.fn(),
      end: vi.fn(),
    } as unknown as DB
    const app = await buildApp({ cfg, db, redis: makeRedis() })

    const res = await app.inject({ method: 'GET', url: '/ready' })

    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ ok: false, error: 'outbox_unreachable', dependency: 'postgres' })
    await app.close()
  })
})
