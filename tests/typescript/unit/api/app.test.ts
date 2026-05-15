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
    localBootstrapEnabled: false,
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
    trustProxy: false,
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
    const cfg = makeCfg()
    const app = await buildApp({ cfg, db: makeDb(), redis: makeRedis() })
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/plain/)
    expect(res.body).toContain('caracal_log_emitted_total')
    expect(res.body).toContain('# TYPE caracal_log_emitted_total counter')
    await app.close()
  })
})
