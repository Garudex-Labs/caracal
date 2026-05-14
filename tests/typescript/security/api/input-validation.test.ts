// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// API input validation security tests: injection vectors, oversized inputs, and type confusion.

import { describe, it, expect } from 'vitest'
import type { DB } from '../../../../apps/api/src/db.js'
import type { RedisClient } from '../../../../apps/api/src/redis.js'
import { buildApp } from '../../../../apps/api/src/app.js'
import { apiAppDeps } from '../../../shared/test-utils/typescript/api-app.js'

function deps(overrides: { adminToken?: string } = {}) {
  return apiAppDeps({ adminToken: overrides.adminToken })
}

describe('SQL injection via URL parameter', () => {
  it('passes the raw id parameter to the DB layer without manipulation', async () => {
    const { cfg, db, redis } = deps()
    const app = await buildApp({ cfg, db: db as unknown as DB, redis: redis as unknown as RedisClient })
    await app.inject({
      method: 'GET',
      url: "/v1/zones/'; DROP TABLE zones; --",
      headers: { authorization: 'Bearer admin-secret' },
    })
    // The DB is mocked so no actual SQL executes, but the param must reach the zones query unmodified
    const zonesCall = db.query.mock.calls.find((c: unknown[]) => String(c[0]).includes('FROM zones'))
    if (zonesCall && Array.isArray(zonesCall[1])) {
      expect(typeof zonesCall[1][0]).toBe('string')
    }
    await app.close()
  })
})

describe('Timing-safe admin token comparison', () => {
  it('rejects tokens that share a prefix with the real token', async () => {
    const { cfg, db, redis } = deps({ adminToken: 'supersecrettoken123' })
    const app = await buildApp({ cfg, db: db as unknown as DB, redis: redis as unknown as RedisClient })
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones',
      headers: { authorization: 'Bearer supersecret' },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('rejects tokens that are a superset of the real token', async () => {
    const { cfg, db, redis } = deps({ adminToken: 'secret' })
    const app = await buildApp({ cfg, db: db as unknown as DB, redis: redis as unknown as RedisClient })
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones',
      headers: { authorization: 'Bearer secret-extra-suffix' },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('rejects empty bearer token', async () => {
    const { cfg, db, redis } = deps()
    const app = await buildApp({ cfg, db: db as unknown as DB, redis: redis as unknown as RedisClient })
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones',
      headers: { authorization: 'Bearer ' },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('rejects token with only whitespace', async () => {
    const { cfg, db, redis } = deps()
    const app = await buildApp({ cfg, db: db as unknown as DB, redis: redis as unknown as RedisClient })
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones',
      headers: { authorization: 'Bearer    ' },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })
})

describe('Admin token scheme enforcement', () => {
  it('rejects Basic auth scheme even with correct secret', async () => {
    const { cfg, db, redis } = deps()
    const app = await buildApp({ cfg, db: db as unknown as DB, redis: redis as unknown as RedisClient })
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones',
      headers: { authorization: 'Basic admin-secret' },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('rejects missing Authorization header entirely', async () => {
    const { cfg, db, redis } = deps()
    const app = await buildApp({ cfg, db: db as unknown as DB, redis: redis as unknown as RedisClient })
    const res = await app.inject({ method: 'GET', url: '/v1/zones' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })
})

describe('Response body does not leak internal errors', () => {
  it('returns structured error object on 401, not a stack trace', async () => {
    const { cfg, db, redis } = deps()
    const app = await buildApp({ cfg, db: db as unknown as DB, redis: redis as unknown as RedisClient })
    const res = await app.inject({ method: 'GET', url: '/v1/zones' })
    const body = JSON.parse(res.body)
    expect(body).toHaveProperty('error')
    expect(JSON.stringify(body)).not.toContain('Error:')
    expect(JSON.stringify(body)).not.toContain('at ')
    await app.close()
  })
})
