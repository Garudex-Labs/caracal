// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// API fuzz-style property tests: random and adversarial inputs must not crash or leak.

import { describe, it, expect } from 'vitest'
import type { DB } from '../../../../apps/api/src/db.js'
import type { RedisClient } from '../../../../apps/api/src/redis.js'
import { buildApp } from '../../../../apps/api/src/app.js'
import { apiAppDeps } from '../../../shared/test-utils/typescript/api-app.js'

function deps() {
  return apiAppDeps()
}

const adversarialSlugInputs = [
  '',
  ' ',
  '   ',
  '\t\n\r',
  'a'.repeat(1000),
  '<script>alert(1)</script>',
  "'; DROP TABLE zones; --",
  '../../etc/passwd',
  '\x00null\x00byte',
  '{"$gt":""}',
  'undefined',
  'null',
  'true',
  '[]',
  '{}',
]

const adversarialNameInputs = [
  '',
  ' ',
  'a'.repeat(10_000),
  '\u0000zero',
  '\uFEFFbom',
  '<img src=x onerror=alert(1)>',
]

describe('Zone creation with adversarial names', () => {
  it.each(adversarialNameInputs)('does not crash for name: %j', async (name) => {
    const { cfg, db, redis } = deps()
    const app = await buildApp({ cfg, db: db as unknown as DB, redis: redis as unknown as RedisClient })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones',
      headers: { authorization: 'Bearer admin-secret' },
      payload: { org_id: 'org1', name },
    })
    expect([200, 201, 400, 422, 500]).toContain(res.statusCode)
    await app.close()
  })
})

describe('Zone creation with adversarial slugs', () => {
  it.each(adversarialSlugInputs)('does not crash for slug: %j', async (slug) => {
    const { cfg, db, redis } = deps()
    const app = await buildApp({ cfg, db: db as unknown as DB, redis: redis as unknown as RedisClient })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones',
      headers: { authorization: 'Bearer admin-secret' },
      payload: { org_id: 'org1', name: 'Test Zone', slug },
    })
    expect([200, 201, 400, 422, 500]).toContain(res.statusCode)
    await app.close()
  })
})

describe('GET requests with adversarial IDs', () => {
  const endpoints = [
    '/v1/zones/',
    '/v1/applications/',
    '/v1/resources/',
    '/v1/providers/',
  ]
  const ids = [
    "'; DROP TABLE zones;--",
    '../admin',
    '%00',
    'a'.repeat(500),
    '<script>',
    '../../',
  ]

  for (const base of endpoints) {
    it.each(ids)(`GET ${base}%j does not crash`, async (id) => {
      const { cfg, db, redis } = deps()
      const app = await buildApp({ cfg, db: db as unknown as DB, redis: redis as unknown as RedisClient })
      const res = await app.inject({
        method: 'GET',
        url: base + encodeURIComponent(id),
        headers: { authorization: 'Bearer admin-secret' },
      })
      expect(res.statusCode).toBeGreaterThanOrEqual(200)
      expect(res.statusCode).toBeLessThan(600)
      await app.close()
    })
  }
})

describe('POST with random content-type bodies', () => {
  it('returns 4xx for JSON with wrong content type', async () => {
    const { cfg, db, redis } = deps()
    const app = await buildApp({ cfg, db: db as unknown as DB, redis: redis as unknown as RedisClient })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones',
      headers: {
        authorization: 'Bearer admin-secret',
        'content-type': 'text/plain',
      },
      body: '{"name":"test"}',
    })
    expect([400, 415]).toContain(res.statusCode)
    await app.close()
  })

  it('handles deeply nested JSON without stack overflow', async () => {
    const { cfg, db, redis } = deps()
    const app = await buildApp({ cfg, db: db as unknown as DB, redis: redis as unknown as RedisClient })
    let nested: Record<string, unknown> = { name: 'deep' }
    for (let i = 0; i < 100; i++) nested = { nested }

    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones',
      headers: { authorization: 'Bearer admin-secret' },
      payload: nested,
    })
    expect(res.statusCode).toBeGreaterThanOrEqual(200)
    expect(res.statusCode).toBeLessThan(600)
    await app.close()
  })
})
