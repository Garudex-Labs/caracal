// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Delegation route unit tests for graph guardrails.

import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import '../../../../../shared/test-utils/typescript/coordinatorEnv.js'
import { delegationsRoutes } from '../../../../../../apps/coordinator/src/routes/delegations.js'

function buildApp() {
  const app = Fastify({ logger: false })
  const db = {
    query: vi.fn(),
    connect: vi.fn(),
  }
  app.decorate('db', db as never)
  app.decorate('redis', { xadd: vi.fn() } as never)
  app.addHook('preHandler', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const clientId = (body.issuer_application_id as string)
      ?? (body.application_id as string)
      ?? 'test-client'
    ;(req as unknown as { caracalAuth: unknown }).caracalAuth = {
      zoneId: (req.params as Record<string, string>)?.zoneId ?? 'z1',
      scopes: ['coordinator.admin'],
      subject: 'test',
      clientId,
      sessionId: 'sid-test',
    }
  })
  app.register(delegationsRoutes, { prefix: '/v1' })
  return { app, db }
}

const delegationBody = {
  source_session_id: 'src-1',
  target_session_id: 'dst-1',
  issuer_application_id: 'issuer-1',
  receiver_application_id: 'receiver-1',
  scopes: ['read'],
  constraints_json: {},
  expires_at: '2027-03-16T00:00:00.000Z',
}

describe('POST /v1/zones/:zoneId/delegations', () => {
  it('rejects expired delegation edges', async () => {
    const { app, db } = buildApp()

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/delegations',
      payload: { ...delegationBody, expires_at: '2026-01-01T00:00:00.000Z' },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'delegation_expired' })
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('rejects self delegation', async () => {
    const { app } = buildApp()

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/delegations',
      payload: { ...delegationBody, target_session_id: delegationBody.source_session_id },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'self_delegation_denied' })
  })

  it('rejects unknown delegation constraints before opening a transaction', async () => {
    const { app, db } = buildApp()

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/delegations',
      payload: { ...delegationBody, constraints: { arbitrary: true } },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_delegation_constraint' })
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('rejects delegation max_hops above supported graph depth', async () => {
    const { app, db } = buildApp()

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/delegations',
      payload: { ...delegationBody, constraints: { max_hops: 11 } },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_max_hops' })
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('rejects conflicting max_depth and max_hops constraints', async () => {
    const { app, db } = buildApp()

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/delegations',
      payload: { ...delegationBody, constraints: { max_depth: 2, max_hops: 3 } },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_max_hops' })
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('rejects unconstrained cycles', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [
          { id: 'src-1', application_id: 'issuer-1' },
          { id: 'dst-1', application_id: 'receiver-1' },
        ] })
        .mockResolvedValueOnce({ rows: [{ exists: 1 }] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/delegations',
      payload: delegationBody,
    })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'delegation_cycle_denied' })
  })

  it('rejects application mismatches on graph endpoints', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [
          { id: 'src-1', application_id: 'other-issuer' },
          { id: 'dst-1', application_id: 'receiver-1' },
        ] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/delegations',
      payload: delegationBody,
    })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'delegation_application_mismatch' })
  })

  it('rejects resource references outside the zone', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [
          { id: 'src-1', application_id: 'issuer-1' },
          { id: 'dst-1', application_id: 'receiver-1' },
        ] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/delegations',
      payload: { ...delegationBody, resource_id: 'res-other-zone' },
    })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'resource_not_found' })
  })

  it('rejects delegation scopes outside the resource scope set', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [
          { id: 'src-1', application_id: 'issuer-1' },
          { id: 'dst-1', application_id: 'receiver-1' },
        ] })
        .mockResolvedValueOnce({ rows: [{ application_id: 'issuer-1', scopes: ['read'] }] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/delegations',
      payload: { ...delegationBody, resource_id: 'res-1', scopes: ['write'] },
    })

    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'delegation_scopes_exceed_resource' })
  })

  it('accepts the SDK wire shape and returns the edge row with id', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [
          { id: 'src-1', application_id: 'issuer-1' },
          { id: 'dst-1', application_id: 'receiver-1' },
        ] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'edge-sdk' }] })
        .mockResolvedValueOnce({ rows: [{ epoch: '1' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/delegations',
      payload: {
        source_session_id: 'src-1',
        target_session_id: 'dst-1',
        issuer_application_id: 'issuer-1',
        receiver_application_id: 'receiver-1',
        scopes: ['read'],
        constraints: { resources: ['calendar'], max_depth: 2 },
        ttl_seconds: 30,
      },
    })

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'edge-sdk' })
    const insertCall = client.query.mock.calls.find((call) => String(call[0]).includes('INSERT INTO delegation_edges'))
    const values = insertCall?.[1] as unknown[]
    expect(values[8]).toMatchObject({ resources: ['calendar'], max_depth: 2, max_hops: 2, ttl_seconds: 30 })
  })
})
