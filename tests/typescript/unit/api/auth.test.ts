// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the DB-backed admin auth plugin and bootstrap token seeder.

import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import Fastify from 'fastify'
import type { DB } from '../../../../apps/api/src/db.js'
import { adminAuthPlugin, lookupAdminToken, seedBootstrapAdminToken } from '../../../../apps/api/src/auth.js'

function digest(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}

const ARGON_HASHES: Record<string, string> = {
  secret: '$argon2id$v=19$m=4096,t=1,p=1$MTIzNDU2Nzg5MGFiY2RlZg$W6k8qCR7eTkTJ6g5/G2Jb7MibAPjTACFTH1xk7NZA64',
  s: '$argon2id$v=19$m=4096,t=1,p=1$YWJjZGVmMTIzNDU2Nzg5MA$93o7HKq1OcFl+uiR0uD+EpMXGZb1VsESPGkov+IS3YI',
  tok: '$argon2id$v=19$m=4096,t=1,p=1$ZmVkY2JhMDk4NzY1NDMyMQ$ioWX1ZIslL5a3NcjDsfGDAhw5wlYJMVMOhfHohTn3Ew',
}

function makeDb(opts: { token?: string; tokenHash?: string | null; scope?: 'global' | 'zone'; zoneId?: string | null } = {}) {
  const tokenDigest = opts.token ? digest(opts.token) : null
  const query = vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
    if (sql.includes('FROM admin_tokens') && Array.isArray(params)) {
      const cand = params[0]
      if (Buffer.isBuffer(cand) && tokenDigest && cand.equals(tokenDigest)) {
        return Promise.resolve({
          rows: [{
            id: 't1',
            name: 'test',
            scope: opts.scope ?? 'global',
            zone_id: opts.zoneId ?? null,
            token_sha256: tokenDigest,
            token_hash: opts.tokenHash ?? (opts.token ? ARGON_HASHES[opts.token] : null),
            revoked_at: null,
          }],
        })
      }
      return Promise.resolve({ rows: [] })
    }
    if (sql.startsWith('UPDATE admin_tokens')) return Promise.resolve({ rows: [], rowCount: 1 })
    if (sql.startsWith('INSERT INTO admin_tokens')) return Promise.resolve({ rows: [], rowCount: 1 })
    return Promise.resolve({ rows: [], rowCount: 0 })
  })
  return { query } as unknown as DB
}

async function buildPluginApp(
  db: ReturnType<typeof makeDb>,
  redis?: { incr: (k: string) => Promise<number>; expire: (k: string, s: number) => Promise<number>; set: (k: string, v: string, ...args: unknown[]) => Promise<'OK' | null> },
  options: { authFailLimitPerMin?: number; lastUsedDebounceSec?: number } = {},
) {
  const app = Fastify({ logger: false })
  await app.register(adminAuthPlugin, {
    db,
    redis: redis as never,
    authFailLimitPerMin: options.authFailLimitPerMin,
    lastUsedDebounceSec: options.lastUsedDebounceSec,
  })
  app.get('/v1/zones', async (req) => ({ ok: true, actor: req.actor }))
  app.get('/v1/zones/:zoneId/things', async (req) => ({ ok: true, params: req.params }))
  return app
}

describe('lookupAdminToken', () => {
  it('returns null for unknown token', async () => {
    const db = makeDb()
    expect(await lookupAdminToken(db, 'nope')).toBeNull()
  })
  it('returns actor for matching token', async () => {
    const db = makeDb({ token: 'secret', scope: 'zone', zoneId: 'z1' })
    const actor = await lookupAdminToken(db, 'secret')
    expect(actor).toMatchObject({ scope: 'zone', zoneId: 'z1' })
  })

  it('returns null when the verifier hash does not match', async () => {
    const db = makeDb({ token: 'secret', tokenHash: ARGON_HASHES.s })
    expect(await lookupAdminToken(db, 'secret')).toBeNull()
  })
})

describe('adminAuthPlugin', () => {
  it('rejects requests without bearer header', async () => {
    const app = await buildPluginApp(makeDb({ token: 'secret' }))
    const res = await app.inject({ method: 'GET', url: '/v1/zones' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('rejects oversized bearer tokens before lookup', async () => {
    const db = makeDb({ token: 'secret' })
    const app = await buildPluginApp(db)
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones',
      headers: { authorization: `Bearer ${'x'.repeat(4097)}` },
    })
    expect(res.statusCode).toBe(401)
    expect(db.query).not.toHaveBeenCalled()
    await app.close()
  })

  it('accepts requests with the matching bearer', async () => {
    const app = await buildPluginApp(makeDb({ token: 'secret' }))
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones',
      headers: { authorization: 'Bearer secret' },
    })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('blocks zone-scoped tokens from accessing other zones', async () => {
    const app = await buildPluginApp(makeDb({ token: 's', scope: 'zone', zoneId: 'z1' }))
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones/z2/things',
      headers: { authorization: 'Bearer s' },
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'admin_token_zone_mismatch' })
    await app.close()
  })

  it('rejects malformed zone paths without throwing', async () => {
    const app = await buildPluginApp(makeDb({ token: 's', scope: 'zone', zoneId: 'z1' }))
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones/%E0%A4%A/things',
      headers: { authorization: 'Bearer s' },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('allows zone-scoped tokens for their own zone', async () => {
    const app = await buildPluginApp(makeDb({ token: 's', scope: 'zone', zoneId: 'z1' }))
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones/z1/things',
      headers: { authorization: 'Bearer s' },
    })
    expect(res.statusCode).toBe(200)
    await app.close()
  })
})

describe('admin auth failed-attempt limiter', () => {
  function fakeRedis(initialCount = 0) {
    const counters = new Map<string, number>()
    const sets = new Map<string, string>()
    return {
      counters,
      sets,
      incr: vi.fn(async (k: string) => {
        const next = (counters.get(k) ?? initialCount) + 1
        counters.set(k, next)
        return next
      }),
      expire: vi.fn(async () => 1),
      set: vi.fn(async (k: string, v: string, _ex: string, _sec: number, mode?: string) => {
        if (mode === 'NX' && sets.has(k)) return null
        sets.set(k, v)
        return 'OK' as const
      }),
    }
  }

  it('returns 429 once failure count exceeds limit', async () => {
    const redis = fakeRedis(2)
    const app = await buildPluginApp(makeDb(), redis, { authFailLimitPerMin: 2 })
    const res = await app.inject({ method: 'GET', url: '/v1/zones', headers: { authorization: 'Bearer wrong' } })
    expect(res.statusCode).toBe(429)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'rate_limited' })
    await app.close()
  })

  it('returns 401 (not 429) when below limit', async () => {
    const redis = fakeRedis(0)
    const app = await buildPluginApp(makeDb(), redis, { authFailLimitPerMin: 5 })
    const res = await app.inject({ method: 'GET', url: '/v1/zones', headers: { authorization: 'Bearer wrong' } })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('does not count successful auth as a failure', async () => {
    const redis = fakeRedis(0)
    const app = await buildPluginApp(makeDb({ token: 's' }), redis, { authFailLimitPerMin: 1 })
    const res = await app.inject({ method: 'GET', url: '/v1/zones', headers: { authorization: 'Bearer s' } })
    expect(res.statusCode).toBe(200)
    expect(redis.incr).not.toHaveBeenCalled()
    await app.close()
  })
})

describe('admin auth touchLastUsed debounce', () => {
  it('skips UPDATE when redis NX guard says recently touched', async () => {
    const db = makeDb({ token: 's' })
    const sets = new Map<string, string>()
    const redis = {
      incr: vi.fn(async () => 1),
      expire: vi.fn(async () => 1),
      set: vi.fn(async (k: string) => {
        if (sets.has(k)) return null
        sets.set(k, '1')
        return 'OK' as const
      }),
    }
    const app = await buildPluginApp(db, redis, { lastUsedDebounceSec: 60 })
    await app.inject({ method: 'GET', url: '/v1/zones', headers: { authorization: 'Bearer s' } })
    await app.inject({ method: 'GET', url: '/v1/zones', headers: { authorization: 'Bearer s' } })
    await new Promise((r) => setImmediate(r))
    const updates = (db.query as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => typeof c[0] === 'string' && (c[0] as string).startsWith('UPDATE admin_tokens'))
    expect(updates).toHaveLength(1)
    await app.close()
  })
})

describe('seedBootstrapAdminToken', () => {
  it('does nothing when env token is not set', async () => {
    const db = { query: vi.fn() } as unknown as DB
    await seedBootstrapAdminToken(db, { envToken: null, log: () => {} })
    expect(db.query).not.toHaveBeenCalled()
  })
  it('skips insert when token already present', async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: 'existing', token_hash: ARGON_HASHES.tok }] }),
    } as unknown as DB
    await seedBootstrapAdminToken(db, { envToken: 'tok', log: () => {} })
    expect(db.query).toHaveBeenCalledTimes(2)
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining('created_by = \'env-bootstrap\''), expect.any(Array))
  })
  it('fills missing verifier hash for the bootstrap token', async () => {
    const queries: string[] = []
    const db = {
      query: vi.fn().mockImplementation((sql: string) => {
        queries.push(sql)
        if (sql.includes('SELECT id')) return Promise.resolve({ rows: [{ id: 'existing', token_hash: null }] })
        return Promise.resolve({ rows: [], rowCount: 1 })
      }),
    } as unknown as DB
    await seedBootstrapAdminToken(db, { envToken: 'tok', log: () => {} })
    expect(queries.some((s) => s.startsWith('UPDATE admin_tokens SET token_hash'))).toBe(true)
    expect(queries.some((s) => s.includes('token_sha256 <> $1'))).toBe(true)
  })
  it('inserts when missing', async () => {
    const inserts: string[] = []
    const db = {
      query: vi.fn().mockImplementation((sql: string) => {
        inserts.push(sql)
        if (sql.includes('SELECT id')) return Promise.resolve({ rows: [] })
        return Promise.resolve({ rows: [], rowCount: 1 })
      }),
    } as unknown as DB
    await seedBootstrapAdminToken(db, { envToken: 'tok', log: () => {} })
    expect(inserts.some((s) => s.startsWith('INSERT INTO admin_tokens'))).toBe(true)
    expect(inserts.some((s) => s.includes('token_sha256 <> $1'))).toBe(true)
  })
})
