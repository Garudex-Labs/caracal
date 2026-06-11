// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Policies route unit tests: Rego validation, version creation.

import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import type { DB } from '../../../../../apps/api/src/db.js'
import type { RedisClient } from '../../../../../apps/api/src/redis.js'
import '../../../../../apps/api/src/fastify-augmentation.js'
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
  app.decorate('db', db as unknown as DB)
  app.decorate('redis', redis as unknown as RedisClient)
  app.addHook('preHandler', async (req) => {
    req.actor = { id: 'test-actor', name: 'test', scope: 'global', zoneId: null }
  })
  app.register(policiesRoutes, { prefix: '/v1' })
  return { app, db, clientQuery, redis }
}

const validRego = `package caracal.authz
import rego.v1

default result := {"decision": "deny", "evaluation_status": "complete", "determining_policies": [], "diagnostics": []}

result := {"decision": "allow", "evaluation_status": "complete", "determining_policies": [{"policy": "test"}], "diagnostics": []} if {
  "read" in input.context.requested_scopes
}`

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

  it('rejects policy without required authz result rule', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/policies',
      payload: { name: 'p1', content: 'package caracal.authz\ndefault allow = false' },
    })
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body)).toMatchObject({ detail: 'must_define_result_rule' })
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
    const body = JSON.parse(res.body)
    expect(body.id).toBeDefined()
    expect(body.version_id).toBe('pv-1')
    expect(body.version).toMatchObject({ id: 'pv-1' })
  })
})

describe('POST /v1/policies/validate', () => {
  it('returns warnings for accepted but risky policy shape', async () => {
    const { app } = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/policies/validate',
      payload: {
        content: 'package caracal.authz\ndefault result := { "decision": "allow", "evaluation_status": "complete", "determining_policies": [], "diagnostics": [] }',
      },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({
      valid: true,
      schema_version: '2026-05-20',
      input_schema_version: '2026-05-20',
      output_contract: { evaluation_status: ['complete'] },
      warnings: expect.arrayContaining(['default_result_allows_access', 'missing_requested_scope_check']),
    })
  })

  it('returns a preview of the parsed policy', async () => {
    const { app } = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/policies/validate',
      payload: { content: validRego },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.valid).toBe(true)
    expect(body.preview).toMatchObject({
      package: 'caracal.authz',
      rules: ['result'],
      default_result: true,
      decisions: expect.arrayContaining(['allow', 'deny']),
      inputs_referenced: ['input.context.requested_scopes'],
    })
  })

  it('rejects unsupported schema versions', async () => {
    const { app } = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/policies/validate',
      payload: { content: validRego, schema_version: '2099-01-01' },
    })
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_schema_version' })
  })
})

describe('POST /v1/zones/:zoneId/policies/:id/versions', () => {
  it('creates the next policy version under advisory lock', async () => {
    const { app, clientQuery } = buildApp()
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'p-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'pv-2', policy_id: 'p-1', version: 2, content_sha256: 'sha-2', schema_version: '2026-05-20' }] })
      .mockResolvedValueOnce({ rows: [] })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/policies/p-1/versions',
      payload: { content: validRego },
    })

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'pv-2', version_id: 'pv-2', version: 2 })
    expect(clientQuery.mock.calls[1][0]).toContain('pg_advisory_xact_lock')
  })

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

describe('GET /v1/zones/:zoneId/policies', () => {
  it('lists policies for the zone', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ id: 'p-1', name: 'One' }, { id: 'p-2', name: 'Two' }] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/policies' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toHaveLength(2)
  })
})

describe('GET /v1/zones/:zoneId/policies/:id', () => {
  it('returns a policy with its versions', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ id: 'p-1', name: 'One', versions: [{ version: 1 }] }] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/policies/p-1' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'p-1' })
  })

  it('returns 404 for a missing policy', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/policies/missing' })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'policy_not_found' })
  })
})

describe('DELETE /v1/zones/:zoneId/policies/:id', () => {
  it('archives an existing policy', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rowCount: 1 })

    await app.ready()
    const res = await app.inject({ method: 'DELETE', url: '/v1/zones/z1/policies/p-1' })

    expect(res.statusCode).toBe(204)
  })

  it('returns 404 when the policy is missing', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rowCount: 0 })

    await app.ready()
    const res = await app.inject({ method: 'DELETE', url: '/v1/zones/z1/policies/missing' })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'policy_not_found' })
  })
})
