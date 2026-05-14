// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the admin audit onResponse hook recording mutations.

import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import type { DB } from '../../../../apps/api/src/db.js'
import { registerAdminAuditHook } from '../../../../apps/api/src/admin-audit.js'

function buildApp(captured: { sql: string; params?: unknown[] }[]) {
  const app = Fastify({ logger: false })
  const db = {
    query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
      captured.push({ sql, params })
      return Promise.resolve({ rows: [], rowCount: 1 })
    }),
  } as unknown as DB
  registerAdminAuditHook(app, { db })
  app.post('/v1/zones/:zoneId/policies/:id', async () => ({ ok: true }))
  app.get('/v1/zones/:zoneId/policies', async () => ({ ok: true }))
  app.post('/health', async () => ({ ok: true }))
  return app
}

describe('admin audit hook', () => {
  it('records POST under /v1 with extracted zone and entity info', async () => {
    const captured: { sql: string; params?: unknown[] }[] = []
    const app = buildApp(captured)
    await app.inject({ method: 'POST', url: '/v1/zones/z1/policies/p1', payload: {} })
    await app.close()
    expect(captured).toHaveLength(1)
    const [, params] = [captured[0].sql, captured[0].params!]
    expect(params[5]).toBe('POST /v1/zones/z1/policies/p1')
    expect(params[8]).toBe('z1')
    expect(params[9]).toBe('policies')
    expect(params[10]).toBe('p1')
  })

  it('does not record GET requests', async () => {
    const captured: { sql: string; params?: unknown[] }[] = []
    const app = buildApp(captured)
    await app.inject({ method: 'GET', url: '/v1/zones/z1/policies' })
    await app.close()
    expect(captured).toHaveLength(0)
  })

  it('does not record routes outside /v1', async () => {
    const captured: { sql: string; params?: unknown[] }[] = []
    const app = buildApp(captured)
    await app.inject({ method: 'POST', url: '/health', payload: {} })
    await app.close()
    expect(captured).toHaveLength(0)
  })
})
