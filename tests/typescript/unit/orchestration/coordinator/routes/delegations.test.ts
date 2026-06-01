// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Delegation route unit tests for graph guardrails.

import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import '../../../../../shared/test-utils/typescript/coordinatorEnv.js'
import { delegationsRoutes } from '../../../../../../apps/coordinator/src/routes/delegations.js'

function buildApp(scopes = ['coordinator.admin']) {
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
      scopes,
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

  it('requires elevated permission for broad resource-null delegation', async () => {
    const { app, db } = buildApp(['coordinator.delegate_from:issuer-1', 'coordinator.delegate_to:receiver-1'])

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/delegations',
      payload: delegationBody,
    })

    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'broad_delegation_permission_required' })
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
        .mockResolvedValueOnce({ rows: [] })
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
        .mockResolvedValueOnce({ rows: [
          { id: 'res-1', identifier: 'calendar', application_id: 'issuer-1', scopes: ['read', 'write'] },
        ] })
        .mockResolvedValueOnce({ rows: [] })
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
    const resourceCall = client.query.mock.calls.find((call) => String(call[0]).includes('FROM resources r'))
    expect(String(resourceCall?.[0])).toContain('gateway_resource_bindings b')
    expect(String(resourceCall?.[0])).not.toContain('r.application_id')
    const insertCall = client.query.mock.calls.find((call) => String(call[0]).includes('INSERT INTO delegation_edges'))
    const values = insertCall?.[1] as unknown[]
    expect(values[9]).toMatchObject({ resources: ['calendar'], max_depth: 2, max_hops: 2, ttl_seconds: 30 })
  })

  it('rejects child delegation that widens parent authority', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [
          { id: 'src-1', application_id: 'issuer-1' },
          { id: 'dst-1', application_id: 'receiver-1' },
        ] })
        .mockResolvedValueOnce({ rows: [
          { id: 'res-2', identifier: 'files', application_id: 'issuer-1', scopes: ['read'] },
        ] })
        .mockResolvedValueOnce({ rows: [
          {
            id: 'parent-edge',
            resource_id: null,
            resource_identifier: null,
            scopes: ['read'],
            constraints_json: { resources: ['calendar'], max_hops: 2 },
            expires_at: '2027-03-16T00:00:00.000Z',
          },
        ] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/delegations',
      payload: {
        ...delegationBody,
        constraints: { resources: ['files'], max_hops: 1 },
      },
    })

    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'delegation_exceeds_parent_authority' })
  })

  it('rejects ambiguous downstream delegation when multiple parent edges could authorize it', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [
          { id: 'src-1', application_id: 'issuer-1' },
          { id: 'dst-1', application_id: 'receiver-1' },
        ] })
        .mockResolvedValueOnce({ rows: [
          { id: 'res-1', identifier: 'calendar', application_id: 'issuer-1', scopes: ['read'] },
        ] })
        .mockResolvedValueOnce({ rows: [
          {
            id: 'parent-edge-a',
            resource_id: 'res-1',
            resource_identifier: 'calendar',
            scopes: ['read'],
            constraints_json: { max_hops: 2 },
            expires_at: '2027-03-16T00:00:00.000Z',
          },
          {
            id: 'parent-edge-b',
            resource_id: 'res-1',
            resource_identifier: 'calendar',
            scopes: ['read'],
            constraints_json: { max_hops: 2 },
            expires_at: '2027-03-16T00:00:00.000Z',
          },
        ] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/delegations',
      payload: {
        ...delegationBody,
        resource_id: 'res-1',
        constraints: { max_hops: 1 },
      },
    })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'parent_delegation_ambiguous' })
  })

  it('records the selected parent edge for downstream delegation', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [
          { id: 'src-1', application_id: 'issuer-1' },
          { id: 'dst-1', application_id: 'receiver-1' },
        ] })
        .mockResolvedValueOnce({ rows: [
          { id: 'res-1', identifier: 'calendar', application_id: 'issuer-1', scopes: ['read'] },
        ] })
        .mockResolvedValueOnce({ rows: [
          {
            id: 'parent-edge-a',
            resource_id: 'res-1',
            resource_identifier: 'calendar',
            scopes: ['read'],
            constraints_json: { max_hops: 2 },
            expires_at: '2027-03-16T00:00:00.000Z',
          },
          {
            id: 'parent-edge-b',
            resource_id: 'res-1',
            resource_identifier: 'calendar',
            scopes: ['read'],
            constraints_json: { max_hops: 2 },
            expires_at: '2027-03-16T00:00:00.000Z',
          },
        ] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'edge-child', parent_edge_id: 'parent-edge-b' }] })
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
        ...delegationBody,
        parent_edge_id: 'parent-edge-b',
        resource_id: 'res-1',
        constraints: { max_hops: 1 },
      },
    })

    expect(res.statusCode).toBe(201)
    const insertCall = client.query.mock.calls.find((call) => String(call[0]).includes('INSERT INTO delegation_edges'))
    const values = insertCall?.[1] as unknown[]
    expect(values[6]).toBe('parent-edge-b')
  })
})

describe('GET /v1/zones/:zoneId/delegations/:id/impact', () => {
  it('returns revocation blast radius for an active delegation edge', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'edge-1',
          source_session_id: 'agent-1',
          target_session_id: 'agent-2',
          depth: 1,
          subject_session_id: 'sid-2',
        },
        {
          id: 'edge-2',
          source_session_id: 'agent-2',
          target_session_id: 'agent-3',
          depth: 2,
          subject_session_id: 'sid-3',
        },
      ],
    })

    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones/z1/delegations/edge-1/impact',
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({
      edge_id: 'edge-1',
      affected_agents: ['agent-2', 'agent-3'],
      affected_subject_sessions: ['sid-2', 'sid-3'],
      affected_edges: [
        { id: 'edge-1', source_session_id: 'agent-1', target_session_id: 'agent-2', depth: 1 },
        { id: 'edge-2', source_session_id: 'agent-2', target_session_id: 'agent-3', depth: 2 },
      ],
    })
  })
})

describe('GET /v1/zones/:zoneId/delegations/inbound|outbound/:sessionId', () => {
  it('lists inbound edges with a next cursor', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ id: 'e1' }, { id: 'e2' }] })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/delegations/inbound/sess-1?limit=2' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ items: [{ id: 'e1' }, { id: 'e2' }], next_cursor: 'e2' })
  })

  it('rejects an invalid query', async () => {
    const { app } = buildApp()
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/delegations/outbound/sess-1?limit=bad' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_query' })
  })

  it('rejects an unknown cursor', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [] })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/delegations/outbound/sess-1?cursor=ghost' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_cursor' })
  })
})

describe('GET /v1/zones/:zoneId/delegations/active', () => {
  it('rejects an invalid query', async () => {
    const { app } = buildApp()
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/delegations/active?limit=nope' })
    expect(res.statusCode).toBe(400)
  })

  it('rejects an unknown cursor', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [] })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/delegations/active?cursor=ghost' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_cursor' })
  })

  it('returns active edges after validating the cursor', async () => {
    const { app, db } = buildApp()
    db.query
      .mockResolvedValueOnce({ rows: [{ x: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'e1' }] })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/delegations/active?cursor=e0&limit=1' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ items: [{ id: 'e1' }], next_cursor: 'e1' })
  })
})

describe('GET /v1/zones/:zoneId/delegations/:id/traverse', () => {
  it('returns the reachable edges', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ id: 'e1', depth: 1 }] })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/delegations/e1/traverse' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([{ id: 'e1', depth: 1 }])
  })
})

describe('GET /v1/zones/:zoneId/agents/:sessionId/effective-authority', () => {
  it('returns an empty authority when there are no parents', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [] })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/agents/sess-1/effective-authority' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      agent_session_id: 'sess-1',
      inbound_edges: [],
      effective_scopes: [],
      effective_resources: [],
      effective_max_hops: 0,
      effective_ttl_seconds: null,
      earliest_expires_at: null,
    })
  })

  it('intersects scopes and resources across parent delegations', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'p1', scopes: ['read', 'write'], resource_id: 'res-1', resource_identifier: 'urn:a',
          constraints_json: { max_hops: 3, ttl_seconds: 600, resources: ['urn:x'] },
          expires_at: '2027-01-01T00:00:00.000Z',
        },
        {
          id: 'p2', scopes: ['read'], resource_id: null, resource_identifier: null,
          constraints_json: { max_hops: 2, ttl_seconds: 300 },
          expires_at: '2026-06-01T00:00:00.000Z',
        },
      ],
    })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/agents/sess-1/effective-authority' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.inbound_edges).toEqual(['p1', 'p2'])
    expect(body.effective_scopes).toEqual(['read'])
    expect(body.effective_resources).toEqual(['urn:a', 'urn:x'])
    expect(body.effective_resource_ids).toEqual(['res-1'])
    expect(body.effective_resource_constrained).toBe(true)
    expect(body.effective_max_hops).toBe(2)
    expect(body.effective_ttl_seconds).toBe(300)
    expect(body.earliest_expires_at).toBe('2026-06-01T00:00:00.000Z')
  })
})

describe('PATCH /v1/zones/:zoneId/delegations/:id/revoke', () => {
  it('returns 404 when the edge is unknown', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)
    await app.ready()
    const res = await app.inject({ method: 'PATCH', url: '/v1/zones/z1/delegations/missing/revoke' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'delegation_not_found' })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('returns 403 when the caller lacks issuer ownership', async () => {
    const { app, db } = buildApp(['coordinator.read'])
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ issuer_application_id: 'other-app' }] })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)
    await app.ready()
    const res = await app.inject({ method: 'PATCH', url: '/v1/zones/z1/delegations/e1/revoke' })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'issuer_ownership_required' })
  })
})
