// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the DB-backed admin auth plugin and bootstrap token seeder.

import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import Fastify from 'fastify'
import { adminAuthPlugin, lookupAdminToken, seedBootstrapAdminToken } from '../../../../apps/api/src/auth.js'

function digest(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}

function makeDb(opts: { token?: string; scope?: 'global' | 'zone'; zoneId?: string | null } = {}) {
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
  return { query } as never
}

async function buildPluginApp(db: ReturnType<typeof makeDb>) {
  const app = Fastify({ logger: false })
  await app.register(adminAuthPlugin, { db })
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

describe('seedBootstrapAdminToken', () => {
  it('does nothing when env token is not set', async () => {
    const db = { query: vi.fn() } as never
    await seedBootstrapAdminToken(db, { envToken: null, log: () => {} })
    expect(db.query).not.toHaveBeenCalled()
  })
  it('skips insert when token already present', async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: 'existing' }] }),
    } as never
    await seedBootstrapAdminToken(db, { envToken: 'tok', log: () => {} })
    expect(db.query).toHaveBeenCalledTimes(1)
  })
  it('inserts when missing', async () => {
    const inserts: string[] = []
    const db = {
      query: vi.fn().mockImplementation((sql: string) => {
        inserts.push(sql)
        if (sql.includes('SELECT id FROM admin_tokens')) return Promise.resolve({ rows: [] })
        return Promise.resolve({ rows: [], rowCount: 1 })
      }),
    } as never
    await seedBootstrapAdminToken(db, { envToken: 'tok', log: () => {} })
    expect(inserts.some((s) => s.startsWith('INSERT INTO admin_tokens'))).toBe(true)
  })
})
