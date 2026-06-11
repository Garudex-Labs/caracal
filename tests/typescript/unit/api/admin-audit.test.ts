// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the admin audit onResponse hook recording mutations.

import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import type { DB } from '../../../../apps/api/src/db.js'
import { registerAdminAuditHook } from '../../../../apps/api/src/admin-audit.js'

interface Captured {
  sql: string
  params?: unknown[]
}

function makeDb(captured: Captured[]): DB {
  const clientQuery = vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
    captured.push({ sql, params })
    if (/SELECT[\s\S]*FROM admin_audit_events/.test(sql)) return Promise.resolve({ rows: [] })
    return Promise.resolve({ rows: [], rowCount: 1 })
  })
  const client = { query: clientQuery, release: vi.fn() }
  return { connect: vi.fn().mockResolvedValue(client) } as unknown as DB
}

function insertCall(captured: Captured[]): Captured | undefined {
  return captured.find((c) => c.sql.includes('INSERT INTO admin_audit_events'))
}

function buildApp(captured: Captured[]) {
  const app = Fastify({ logger: false })
  registerAdminAuditHook(app, { db: makeDb(captured) })
  app.post('/v1/zones/:zoneId/policies/:id', async () => ({ ok: true }))
  app.get('/v1/zones/:zoneId/policies', async () => ({ ok: true }))
  app.post('/health', async () => ({ ok: true }))
  return app
}

describe('admin audit hook', () => {
  it('records POST under /v1 with extracted zone and entity info', async () => {
    const captured: Captured[] = []
    const app = buildApp(captured)
    await app.inject({ method: 'POST', url: '/v1/zones/z1/policies/p1', payload: {} })
    await app.close()
    const ins = insertCall(captured)
    expect(ins).toBeDefined()
    const params = ins!.params!
    expect(params[5]).toBe('POST /v1/zones/z1/policies/p1')
    expect(params[8]).toBe('z1')
    expect(params[9]).toBe('policies')
    expect(params[10]).toBe('p1')
    expect(params[12]).toMatchObject({
      rls_mode: 'control_plane_wildcard',
      rls_zone_guc: '*',
    })
    expect(params[12]).not.toHaveProperty('rls_bypass')
    // content_sha256 and chain_seq present
    expect(typeof params[14]).toBe('string')
    expect(params[17]).toBe(1)
  })

  it('does not record GET requests', async () => {
    const captured: Captured[] = []
    const app = buildApp(captured)
    await app.inject({ method: 'GET', url: '/v1/zones/z1/policies' })
    await app.close()
    expect(captured).toHaveLength(0)
  })

  it('does not record routes outside /v1', async () => {
    const captured: Captured[] = []
    const app = buildApp(captured)
    await app.inject({ method: 'POST', url: '/health', payload: {} })
    await app.close()
    expect(captured).toHaveLength(0)
  })

  it('skips registration entirely when disabled', async () => {
    const captured: Captured[] = []
    const app = Fastify({ logger: false })
    registerAdminAuditHook(app, { db: makeDb(captured), enabled: false })
    app.post('/v1/zones/:zoneId/policies/:id', async () => ({ ok: true }))
    await app.inject({ method: 'POST', url: '/v1/zones/z1/policies/p1', payload: {} })
    await app.close()
    expect(captured).toHaveLength(0)
  })

  it('records the provider oauth callback and strips the query string', async () => {
    const captured: Captured[] = []
    const app = buildApp(captured)
    app.get('/v1/zones/:zoneId/provider-grants/oauth/callback', async () => ({ ok: true }))
    await app.inject({ method: 'GET', url: '/v1/zones/z1/provider-grants/oauth/callback?code=abc&state=secrettoken' })
    await app.close()
    const ins = insertCall(captured)
    expect(ins).toBeDefined()
    const params = ins!.params!
    expect(params[8]).toBe('z1')
    expect(params[5]).toBe('GET /v1/zones/z1/provider-grants/oauth/callback')
    expect(params[7]).toBe('/v1/zones/z1/provider-grants/oauth/callback')
    expect(JSON.stringify(params)).not.toContain('secrettoken')
  })

  it('signs the chain when an hmac key is configured', async () => {
    const captured: Captured[] = []
    const app = Fastify({ logger: false })
    registerAdminAuditHook(app, { db: makeDb(captured), hmacKey: Buffer.alloc(32, 7) })
    app.post('/v1/zones/:zoneId/policies/:id', async () => ({ ok: true }))
    await app.inject({ method: 'POST', url: '/v1/zones/z1/policies/p1', payload: {} })
    await app.close()
    const ins = insertCall(captured)
    expect(ins).toBeDefined()
    // chain_hmac (param 16) is a 64-char hex string when signed
    expect(ins!.params![16]).toMatch(/^[0-9a-f]{64}$/)
  })

  it('swallows insert failures without breaking the response', async () => {
    const app = Fastify({ logger: false })
    const db = { connect: vi.fn().mockRejectedValue(new Error('db down')) } as unknown as DB
    registerAdminAuditHook(app, { db })
    app.post('/v1/zones/:zoneId/policies/:id', async () => ({ ok: true }))
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/policies/p1', payload: {} })
    await app.close()
    expect(res.statusCode).toBe(200)
  })
})
