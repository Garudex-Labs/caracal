// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Policies route unit tests: Rego validation, version creation.

import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import { policiesRoutes } from '../../../../../apps/api/src/routes/policies.js'

function buildApp() {
  const app = Fastify({ logger: false })
  const clientQuery = vi.fn().mockResolvedValue({ rows: [{ id: 'pv-1', policy_id: 'p-1', version: 1, content_sha256: 'abc', schema_version: '2026-03-16', created_at: new Date() }] })
  const db = {
    query: vi.fn(),
    connect: vi.fn().mockResolvedValue({
      query: clientQuery,
      release: vi.fn(),
    }),
  }
  const redis = { xadd: vi.fn() }
  app.decorate('db', db as any)
  app.decorate('redis', redis as any)
  app.addHook('preHandler', async (req) => {
    req.actor = { id: 'test-actor', name: 'test', scope: 'global', zoneId: null }
  })
  app.register(policiesRoutes, { prefix: '/v1' })
  return { app, db, clientQuery, redis }
}

const validRego = `package caracal.authz\ndefault allow = false`

describe('POST /v1/zones/:zoneId/policies', () => {
  it('rejects missing package declaration', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/policies',
      payload: { name: 'p1', content: 'default allow = false' },
    })
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_rego' })
  })

  it('accepts valid Rego with package declaration', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValue({ rows: [{ '?column?': 1 }] })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/policies',
      payload: { name: 'p1', content: validRego },
    })
    expect(res.statusCode).toBe(201)
  })
})

describe('POST /v1/zones/:zoneId/policies/:id/versions', () => {
  it('rejects Rego without package declaration', async () => {
    const { app } = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/policies/p-1/versions',
      payload: { content: 'allow = true' },
    })
    expect(res.statusCode).toBe(422)
  })

  it('returns 404 when policy not found', async () => {
    const { app, clientQuery } = buildApp()
    clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // advisory lock
      .mockResolvedValueOnce({ rows: [] }) // policy lookup → not found
      .mockResolvedValueOnce({ rows: [] }) // ROLLBACK
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/policies/missing/versions',
      payload: { content: validRego },
    })
    expect(res.statusCode).toBe(404)
  })
})
