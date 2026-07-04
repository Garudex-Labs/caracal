// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the DB-backed admin auth plugin and bootstrap token seeder.

import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import Fastify from 'fastify'
import type { DB } from '../../../../apps/api/src/db.js'
import {
  adminAuthPlugin,
  isDerivedConsoleActor,
  lookupAdminToken,
  seedBootstrapAdminToken,
  seedConsoleReadToken,
  seedConsoleWriteToken,
  seedConsoleApproveToken,
} from '../../../../apps/api/src/auth.js'
import { deriveConsoleReadToken, deriveConsoleWriteToken } from '../../../../packages/core/ts/src/consoleToken.js'
import { signAccountAssertion } from '../../../../packages/core/ts/src/accountAssertion.js'

function digest(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}

const ARGON_HASHES: Record<string, string> = {
  secret: '$argon2id$v=19$m=4096,t=1,p=1$MTIzNDU2Nzg5MGFiY2RlZg$W6k8qCR7eTkTJ6g5/G2Jb7MibAPjTACFTH1xk7NZA64',
  s: '$argon2id$v=19$m=4096,t=1,p=1$YWJjZGVmMTIzNDU2Nzg5MA$93o7HKq1OcFl+uiR0uD+EpMXGZb1VsESPGkov+IS3YI',
  tok: '$argon2id$v=19$m=4096,t=1,p=1$ZmVkY2JhMDk4NzY1NDMyMQ$ioWX1ZIslL5a3NcjDsfGDAhw5wlYJMVMOhfHohTn3Ew',
}

function makeDb(
  opts: {
    token?: string
    tokenHash?: string | null
    scope?: 'global' | 'zone'
    zoneId?: string | null
    capability?: 'read' | 'write' | 'approve'
    createdBy?: string
    zoneReserved?: boolean
    zoneOwner?: string | null
  } = {},
) {
  const tokenDigest = opts.token ? digest(opts.token) : null
  const query = vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
    if (sql.includes('FROM zones') && sql.includes('name, slug')) {
      // The zone exists in the mock when it is reserved or has an owner, so the access guards can
      // read its metadata; otherwise it is an unknown/unowned zone (no row).
      const exists = opts.zoneReserved || opts.zoneOwner !== undefined
      return Promise.resolve({
        rows: exists
          ? [
              {
                name: opts.zoneReserved ? 'caracal.sys/system' : 'Tenant Zone',
                slug: opts.zoneReserved ? 'caracal-sys-internal' : 'tenant-zone',
                owner_account_id: opts.zoneOwner ?? null,
              },
            ]
          : [],
      })
    }
    if (sql.includes('FROM admin_tokens') && Array.isArray(params)) {
      const cand = params[0]
      if (Buffer.isBuffer(cand) && tokenDigest && cand.equals(tokenDigest)) {
        return Promise.resolve({
          rows: [
            {
              id: 't1',
              name: 'test',
              scope: opts.scope ?? 'global',
              capability: opts.capability ?? 'write',
              zone_id: opts.zoneId ?? null,
              created_by: opts.createdBy ?? 'env-bootstrap',
              token_sha256: tokenDigest,
              token_hash: opts.tokenHash ?? (opts.token ? ARGON_HASHES[opts.token] : null),
              revoked_at: null,
            },
          ],
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
  redis?: {
    incr: (k: string) => Promise<number>
    expire: (k: string, s: number) => Promise<number>
    set: (k: string, v: string, ...args: unknown[]) => Promise<'OK' | null>
  },
  options: {
    authFailLimitPerMin?: number
    lastUsedDebounceSec?: number
    verifyCacheTtlMs?: number
    accountAssertionKey?: string | null
  } = {},
) {
  const app = Fastify({ logger: false })
  await app.register(adminAuthPlugin, {
    db,
    redis: redis as never,
    authFailLimitPerMin: options.authFailLimitPerMin,
    lastUsedDebounceSec: options.lastUsedDebounceSec,
    verifyCacheTtlMs: options.verifyCacheTtlMs,
    accountAssertionKey: options.accountAssertionKey,
  })
  app.get('/v1/zones', async (req) => ({ ok: true, actor: req.actor, account: req.account }))
  app.get('/v1/zones/:zoneId/things', async (req) => ({ ok: true, params: req.params }))
  app.get('/v1/zones/:zoneId/provider-grants/oauth/callback', async () => ({ ok: true }))
  app.post('/v1/zones', async () => ({ ok: true }))
  app.delete('/v1/zones/:zoneId', async () => ({ ok: true }))
  app.post('/v1/policies/validate', async () => ({ ok: true }))
  app.post('/v1/zones/:zoneId/step-up-challenges/:id/approve', async () => ({ ok: true }))
  app.post('/v1/zones/:zoneId/step-up-challenges/:id/reject', async () => ({ ok: true }))
  return app
}

function countTokenSelects(db: ReturnType<typeof makeDb>): number {
  const query = db.query as unknown as { mock: { calls: unknown[][] } }
  return query.mock.calls.filter((call) => typeof call[0] === 'string' && (call[0] as string).includes('FROM admin_tokens')).length
}

describe('lookupAdminToken', () => {
  it('returns null for unknown token', async () => {
    const db = makeDb()
    expect(await lookupAdminToken(db, 'nope')).toBeNull()
  })
  it('returns actor for matching token', async () => {
    const db = makeDb({ token: 'secret', scope: 'zone', zoneId: 'z1', createdBy: 'env-derived-write' })
    const actor = await lookupAdminToken(db, 'secret')
    expect(actor).toMatchObject({ scope: 'zone', zoneId: 'z1', createdBy: 'env-derived-write' })
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

  it('allows OAuth provider callbacks without an admin bearer', async () => {
    const app = await buildPluginApp(makeDb({ token: 'secret' }))
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/provider-grants/oauth/callback?state=s&code=c' })
    expect(res.statusCode).toBe(200)
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

  it('lets a read-capability token read', async () => {
    const app = await buildPluginApp(makeDb({ token: 'secret', capability: 'read' }))
    const res = await app.inject({ method: 'GET', url: '/v1/zones', headers: { authorization: 'Bearer secret' } })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('denies every mutating method to a read-capability token', async () => {
    for (const probe of [
      { method: 'POST' as const, url: '/v1/zones' },
      { method: 'DELETE' as const, url: '/v1/zones/z1' },
    ]) {
      const app = await buildPluginApp(makeDb({ token: 'secret', capability: 'read' }))
      const res = await app.inject({ ...probe, headers: { authorization: 'Bearer secret' } })
      expect(res.statusCode, `${probe.method} ${probe.url}`).toBe(403)
      expect(res.json()).toEqual({ error: 'admin_token_read_only' })
      await app.close()
    }
  })

  it('allows the read-but-POST policy validation path for a read-capability token', async () => {
    const app = await buildPluginApp(makeDb({ token: 'secret', capability: 'read' }))
    const res = await app.inject({ method: 'POST', url: '/v1/policies/validate', headers: { authorization: 'Bearer secret' } })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('lets a write-capability token mutate', async () => {
    const app = await buildPluginApp(makeDb({ token: 'secret', capability: 'write' }))
    const res = await app.inject({ method: 'POST', url: '/v1/zones', headers: { authorization: 'Bearer secret' } })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('lets an approve-capability token read and decide holds', async () => {
    const app = await buildPluginApp(makeDb({ token: 'secret', capability: 'approve' }))
    for (const probe of [
      { method: 'GET' as const, url: '/v1/zones' },
      { method: 'POST' as const, url: '/v1/zones/z1/step-up-challenges/c1/approve' },
      { method: 'POST' as const, url: '/v1/zones/z1/step-up-challenges/c1/reject' },
    ]) {
      const res = await app.inject({ ...probe, headers: { authorization: 'Bearer secret' } })
      expect(res.statusCode, `${probe.method} ${probe.url}`).toBe(200)
    }
    await app.close()
  })

  it('denies an approve-capability token every other mutation', async () => {
    for (const probe of [
      { method: 'POST' as const, url: '/v1/zones' },
      { method: 'DELETE' as const, url: '/v1/zones/z1' },
    ]) {
      const app = await buildPluginApp(makeDb({ token: 'secret', capability: 'approve' }))
      const res = await app.inject({ ...probe, headers: { authorization: 'Bearer secret' } })
      expect(res.statusCode, `${probe.method} ${probe.url}`).toBe(403)
      expect(res.json()).toEqual({ error: 'admin_token_approve_only' })
      await app.close()
    }
  })

  it('denies a write-capability token the decision surface: write never implies approve', async () => {
    const app = await buildPluginApp(makeDb({ token: 'secret', capability: 'write', createdBy: 'env-derived-write' }))
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/step-up-challenges/c1/approve', headers: { authorization: 'Bearer secret' } })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'approve_capability_required' })
    await app.close()
  })

  it('denies a read-capability token the decision surface', async () => {
    const app = await buildPluginApp(makeDb({ token: 'secret', capability: 'read' }))
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/step-up-challenges/c1/reject', headers: { authorization: 'Bearer secret' } })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'admin_token_read_only' })
    await app.close()
  })

  it('lets the bootstrap deployment token decide holds as the break-glass credential', async () => {
    const app = await buildPluginApp(makeDb({ token: 'secret', capability: 'write', createdBy: 'env-bootstrap' }))
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/step-up-challenges/c1/approve', headers: { authorization: 'Bearer secret' } })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('denies a non-provisioner actor mutating the reserved system zone', async () => {
    const app = await buildPluginApp(makeDb({ token: 's', createdBy: 'env-derived-write', zoneReserved: true }))
    const res = await app.inject({ method: 'DELETE', url: '/v1/zones/z1', headers: { authorization: 'Bearer s' } })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'system_zone_read_only' })
    await app.close()
  })

  it('lets the internal provisioner mutate the reserved system zone', async () => {
    const app = await buildPluginApp(makeDb({ token: 's', createdBy: 'env-bootstrap', zoneReserved: true }))
    const res = await app.inject({ method: 'DELETE', url: '/v1/zones/z1', headers: { authorization: 'Bearer s' } })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('lets a non-provisioner read the reserved system zone', async () => {
    const app = await buildPluginApp(makeDb({ token: 's', createdBy: 'env-derived-write', zoneReserved: true }))
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/things', headers: { authorization: 'Bearer s' } })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('lets a non-provisioner mutate a tenant zone that is not reserved', async () => {
    const app = await buildPluginApp(makeDb({ token: 's', createdBy: 'env-derived-write', zoneReserved: false }))
    const res = await app.inject({ method: 'DELETE', url: '/v1/zones/z1', headers: { authorization: 'Bearer s' } })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('caches a successful verification so the static token is not re-verified per request', async () => {
    const db = makeDb({ token: 'secret' })
    const app = await buildPluginApp(db)
    const headers = { authorization: 'Bearer secret' }
    const first = await app.inject({ method: 'GET', url: '/v1/zones', headers })
    const second = await app.inject({ method: 'GET', url: '/v1/zones', headers })
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    // The argon2 verification and its admin_tokens SELECT run once; the second request
    // is served from the short-lived verification cache.
    expect(countTokenSelects(db)).toBe(1)
    await app.close()
  })

  it('does not cache failed verifications', async () => {
    const db = makeDb({ token: 'secret' })
    const app = await buildPluginApp(db)
    const headers = { authorization: 'Bearer wrong' }
    await app.inject({ method: 'GET', url: '/v1/zones', headers })
    await app.inject({ method: 'GET', url: '/v1/zones', headers })
    // Every failed attempt pays the full lookup so brute force stays rate-limited.
    expect(countTokenSelects(db)).toBe(2)
    await app.close()
  })

  it('re-verifies every request when the cache is disabled', async () => {
    const db = makeDb({ token: 'secret' })
    const app = await buildPluginApp(db, undefined, { verifyCacheTtlMs: 0 })
    const headers = { authorization: 'Bearer secret' }
    await app.inject({ method: 'GET', url: '/v1/zones', headers })
    await app.inject({ method: 'GET', url: '/v1/zones', headers })
    expect(countTokenSelects(db)).toBe(2)
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
    const updates = (db.query as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).startsWith('UPDATE admin_tokens'),
    )
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
      query: vi.fn().mockResolvedValueOnce({ rows: [{ id: 'existing', token_hash: ARGON_HASHES.tok }] }),
    } as unknown as DB
    await seedBootstrapAdminToken(db, { envToken: 'tok', log: () => {} })
    expect(db.query).toHaveBeenCalledTimes(2)
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining("created_by = 'env-bootstrap'"), expect.any(Array))
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

describe('deriveConsoleReadToken', () => {
  it('is deterministic for a given admin token and in the cat_ format', () => {
    const a = deriveConsoleReadToken('cat_admin_secret')
    const b = deriveConsoleReadToken('cat_admin_secret')
    expect(a).toBe(b)
    expect(a).toMatch(/^cat_[A-Za-z0-9_-]+$/)
  })

  it('differs for a different admin token and is never equal to it', () => {
    const a = deriveConsoleReadToken('cat_admin_one')
    const b = deriveConsoleReadToken('cat_admin_two')
    expect(a).not.toBe(b)
    expect(a).not.toBe('cat_admin_one')
  })
})

describe('deriveConsoleWriteToken', () => {
  it('is deterministic, in the cat_ format, and distinct from the read token of the same admin token', () => {
    const w = deriveConsoleWriteToken('cat_admin_secret')
    expect(w).toBe(deriveConsoleWriteToken('cat_admin_secret'))
    expect(w).toMatch(/^cat_[A-Za-z0-9_-]+$/)
    // Distinct domain separation: read and write tokens of the same admin token never collide.
    expect(w).not.toBe(deriveConsoleReadToken('cat_admin_secret'))
    expect(w).not.toBe('cat_admin_secret')
  })
})

describe('seedConsoleReadToken', () => {
  it('does nothing when env token is not set', async () => {
    const db = { query: vi.fn() } as unknown as DB
    await seedConsoleReadToken(db, { envToken: null, log: () => {} })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('inserts a global read-capability row for the derived token when absent', async () => {
    const inserts: { sql: string; params?: unknown[] }[] = []
    const db = {
      query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
        inserts.push({ sql, params })
        if (sql.includes('SELECT token_hash')) return Promise.resolve({ rows: [] })
        return Promise.resolve({ rows: [], rowCount: 1 })
      }),
    } as unknown as DB
    await seedConsoleReadToken(db, { envToken: 'tok', log: () => {} })
    const insert = inserts.find((q) => q.sql.startsWith('INSERT INTO admin_tokens'))
    expect(insert).toBeDefined()
    // Provisioned as a global, read-capability token under its own reserved creator. Params:
    // [id, name, digest, hash, capability, createdBy].
    expect(insert!.sql).toContain("'global', $5")
    expect(insert!.params![1]).toBe('console-read-only')
    expect(insert!.params![4]).toBe('read')
    expect(insert!.params![5]).toBe('env-derived')
    // Stale derived tokens are revoked, scoped to this token's own creator.
    const revoke = inserts.find((q) => q.sql.includes('created_by = $1') && q.sql.includes('revoked_at = now()'))
    expect(revoke).toBeDefined()
    expect(revoke!.params![0]).toBe('env-derived')
  })

  it('is idempotent: no insert when the derived token row already exists with a verifier', async () => {
    const seen: string[] = []
    const db = {
      query: vi.fn().mockImplementation((sql: string) => {
        seen.push(sql)
        if (sql.includes('SELECT token_hash')) return Promise.resolve({ rows: [{ token_hash: ARGON_HASHES.tok }] })
        return Promise.resolve({ rows: [], rowCount: 1 })
      }),
    } as unknown as DB
    await seedConsoleReadToken(db, { envToken: 'tok', log: () => {} })
    expect(seen.some((s) => s.startsWith('INSERT INTO admin_tokens'))).toBe(false)
    // Still reconciles stale derived tokens on every run.
    expect(seen.some((s) => s.includes('created_by = $1') && s.includes('revoked_at = now()'))).toBe(true)
  })
})

describe('seedConsoleWriteToken', () => {
  it('does nothing when env token is not set', async () => {
    const db = { query: vi.fn() } as unknown as DB
    await seedConsoleWriteToken(db, { envToken: null, log: () => {} })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('inserts a global write-capability row under a creator distinct from the read token', async () => {
    const inserts: { sql: string; params?: unknown[] }[] = []
    const db = {
      query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
        inserts.push({ sql, params })
        if (sql.includes('SELECT token_hash')) return Promise.resolve({ rows: [] })
        return Promise.resolve({ rows: [], rowCount: 1 })
      }),
    } as unknown as DB
    await seedConsoleWriteToken(db, { envToken: 'tok', log: () => {} })
    const insert = inserts.find((q) => q.sql.startsWith('INSERT INTO admin_tokens'))
    expect(insert).toBeDefined()
    expect(insert!.params![1]).toBe('console-write')
    expect(insert!.params![4]).toBe('write')
    // A distinct creator so the write seeder's stale-revoke never revokes the read token.
    expect(insert!.params![5]).toBe('env-derived-write')
    const revoke = inserts.find((q) => q.sql.includes('created_by = $1') && q.sql.includes('revoked_at = now()'))
    expect(revoke!.params![0]).toBe('env-derived-write')
  })
})

describe('seedConsoleApproveToken', () => {
  it('does nothing when env token is not set', async () => {
    const db = { query: vi.fn() } as unknown as DB
    await seedConsoleApproveToken(db, { envToken: null, log: () => {} })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('inserts a global approve-capability row under its own creator', async () => {
    const inserts: { sql: string; params?: unknown[] }[] = []
    const db = {
      query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
        inserts.push({ sql, params })
        if (sql.includes('SELECT token_hash')) return Promise.resolve({ rows: [] })
        return Promise.resolve({ rows: [], rowCount: 1 })
      }),
    } as unknown as DB
    await seedConsoleApproveToken(db, { envToken: 'tok', log: () => {} })
    const insert = inserts.find((q) => q.sql.startsWith('INSERT INTO admin_tokens'))
    expect(insert).toBeDefined()
    expect(insert!.params![1]).toBe('console-approve')
    expect(insert!.params![4]).toBe('approve')
    // A distinct creator so the approve seeder's stale-revoke never revokes the other derived tokens.
    expect(insert!.params![5]).toBe('env-derived-approve')
    const revoke = inserts.find((q) => q.sql.includes('created_by = $1') && q.sql.includes('revoked_at = now()'))
    expect(revoke!.params![0]).toBe('env-derived-approve')
  })
})

describe('isDerivedConsoleActor', () => {
  const actor = (createdBy: string) => ({
    id: 't1',
    name: 'n',
    scope: 'global' as const,
    capability: 'write' as const,
    zoneId: null,
    createdBy,
  })

  it('recognises both derived Console creators', () => {
    expect(isDerivedConsoleActor(actor('env-derived'))).toBe(true)
    expect(isDerivedConsoleActor(actor('env-derived-write'))).toBe(true)
    expect(isDerivedConsoleActor(actor('env-derived-approve'))).toBe(true)
  })

  it('does not match the bootstrap or operator-minted creators', () => {
    expect(isDerivedConsoleActor(actor('env-bootstrap'))).toBe(false)
    expect(isDerivedConsoleActor(actor('admin:t1'))).toBe(false)
  })
})

describe('account assertion binding', () => {
  function bind(token: string, accountId: string, exp: number): string {
    return signAccountAssertion(token, accountId, exp)
  }

  it('binds req.account from a valid assertion when the key is configured', async () => {
    const app = await buildPluginApp(makeDb({ token: 'secret' }), undefined, { accountAssertionKey: 'secret' })
    const exp = Math.floor(Date.now() / 1000) + 60
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones',
      headers: { authorization: 'Bearer secret', 'x-caracal-account': bind('secret', 'acct-7', exp) },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().account).toEqual({ id: 'acct-7' })
    await app.close()
  })

  it('binds no account when the key is not configured (backward compatible)', async () => {
    const app = await buildPluginApp(makeDb({ token: 'secret' }))
    const exp = Math.floor(Date.now() / 1000) + 60
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones',
      headers: { authorization: 'Bearer secret', 'x-caracal-account': bind('secret', 'acct-7', exp) },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().account).toBeNull()
    await app.close()
  })

  it('binds no account when the assertion is missing', async () => {
    const app = await buildPluginApp(makeDb({ token: 'secret' }), undefined, { accountAssertionKey: 'secret' })
    const res = await app.inject({ method: 'GET', url: '/v1/zones', headers: { authorization: 'Bearer secret' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().account).toBeNull()
    await app.close()
  })

  it('does not bind an account from a forged assertion (wrong key)', async () => {
    const app = await buildPluginApp(makeDb({ token: 'secret' }), undefined, { accountAssertionKey: 'secret' })
    const exp = Math.floor(Date.now() / 1000) + 60
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones',
      headers: { authorization: 'Bearer secret', 'x-caracal-account': bind('attacker-key', 'acct-evil', exp) },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().account).toBeNull()
    await app.close()
  })

  it('does not bind an account from an expired assertion', async () => {
    const app = await buildPluginApp(makeDb({ token: 'secret' }), undefined, { accountAssertionKey: 'secret' })
    const exp = Math.floor(Date.now() / 1000) - 1
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones',
      headers: { authorization: 'Bearer secret', 'x-caracal-account': bind('secret', 'acct-7', exp) },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().account).toBeNull()
    await app.close()
  })
})

describe('per-account zone isolation', () => {
  function withAccount(accountId: string, exp = Math.floor(Date.now() / 1000) + 60): Record<string, string> {
    return { authorization: 'Bearer secret', 'x-caracal-account': signAccountAssertion('secret', accountId, exp) }
  }

  it('allows an account to reach a zone it owns', async () => {
    const app = await buildPluginApp(makeDb({ token: 'secret', zoneOwner: 'acct-a' }), undefined, { accountAssertionKey: 'secret' })
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/things', headers: withAccount('acct-a') })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('forbids an account from reaching a zone owned by another account', async () => {
    const app = await buildPluginApp(makeDb({ token: 'secret', zoneOwner: 'acct-a' }), undefined, { accountAssertionKey: 'secret' })
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/things', headers: withAccount('acct-b') })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'zone_forbidden' })
    await app.close()
  })

  it('forbids mutations on another account-owned zone too', async () => {
    const app = await buildPluginApp(makeDb({ token: 'secret', zoneOwner: 'acct-a' }), undefined, { accountAssertionKey: 'secret' })
    const res = await app.inject({ method: 'DELETE', url: '/v1/zones/z1', headers: withAccount('acct-b') })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'zone_forbidden' })
    await app.close()
  })

  it('fail-closed: forbids an account on an unowned (orphan/admin) zone', async () => {
    const app = await buildPluginApp(makeDb({ token: 'secret', zoneOwner: null }), undefined, { accountAssertionKey: 'secret' })
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/things', headers: withAccount('acct-b') })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'zone_forbidden' })
    await app.close()
  })

  it('allows any account to read the reserved system zone but not mutate it', async () => {
    const read = await buildPluginApp(makeDb({ token: 'secret', zoneReserved: true }), undefined, { accountAssertionKey: 'secret' })
    const ok = await read.inject({ method: 'GET', url: '/v1/zones/z1/things', headers: withAccount('acct-b') })
    expect(ok.statusCode).toBe(200)
    await read.close()
    const write = await buildPluginApp(makeDb({ token: 'secret', createdBy: 'admin:x', zoneReserved: true }), undefined, {
      accountAssertionKey: 'secret',
    })
    const blocked = await write.inject({ method: 'DELETE', url: '/v1/zones/z1', headers: withAccount('acct-b') })
    expect(blocked.statusCode).toBe(403)
    expect(blocked.json()).toEqual({ error: 'system_zone_read_only' })
    await write.close()
  })

  it('does not isolate a direct admin call with no bound account (break-glass preserved)', async () => {
    const app = await buildPluginApp(makeDb({ token: 'secret', zoneOwner: 'acct-a' }), undefined, { accountAssertionKey: 'secret' })
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/things', headers: { authorization: 'Bearer secret' } })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('does not isolate when the assertion key is unconfigured (undeployed)', async () => {
    const app = await buildPluginApp(makeDb({ token: 'secret', zoneOwner: 'acct-a' }))
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/things', headers: withAccount('acct-b') })
    expect(res.statusCode).toBe(200)
    await app.close()
  })
})
