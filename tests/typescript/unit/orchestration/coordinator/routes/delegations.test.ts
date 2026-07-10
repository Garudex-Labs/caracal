// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Delegation route unit tests for graph guardrails.

import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import '../../../../../shared/test-utils/typescript/coordinatorEnv.js'
import { delegationsRoutes } from '../../../../../../apps/coordinator/src/routes/delegations.js'
import { requestDigest } from '../../../../../../apps/coordinator/src/idempotency.js'

function buildApp(scopes = ['coordinator.admin'], clientIdOverride?: string) {
  const app = Fastify({ logger: false })
  const db = {
    query: vi.fn(),
    connect: vi.fn(),
  }
  app.decorate('db', db as never)
  app.decorate('redis', { xadd: vi.fn() } as never)
  app.addHook('preHandler', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const clientId = clientIdOverride ?? (body.issuer_application_id as string) ?? (body.application_id as string) ?? 'test-client'
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
  it('requires an expiry from either the body, constraints, or ttl seconds', async () => {
    const { app, db } = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/delegations',
      payload: { ...delegationBody, expires_at: undefined },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'delegation_expiry_required' })
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('requires issuer ownership before opening a transaction', async () => {
    const { app, db } = buildApp([], 'other-app')
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/delegations',
      payload: { ...delegationBody, resource_id: 'res-1' },
    })

    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'issuer_ownership_required' })
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('allows an issuer to create a cross-application offer without receiver credentials', async () => {
    const { app, db } = buildApp(['coordinator.delegate_from:issuer-1'], 'issuer-1')
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            { id: 'src-1', application_id: 'issuer-1' },
            { id: 'dst-1', application_id: 'receiver-1' },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ id: 'res-1', identifier: 'resource://pipernet', scopes: ['read'] }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ delegation_edge_id: 'edge-offer', status: 'active' }] })
        .mockResolvedValueOnce({ rows: [{ epoch: '1' }] })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/delegations',
      payload: { ...delegationBody, resource_id: 'res-1' },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ delegation_edge_id: 'edge-offer' })
    expect(db.connect).toHaveBeenCalledOnce()
  })

  it('rejects expired Delegations', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            { id: 'src-1', application_id: 'issuer-1' },
            { id: 'dst-1', application_id: 'receiver-1' },
          ],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/delegations',
      payload: { ...delegationBody, expires_at: '2026-01-01T00:00:00.000Z' },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'delegation_expired' })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('replays a durable delegation receipt for a repeated idempotency key', async () => {
    const { app, db } = buildApp()
    const existing = {
      delegation_edge_id: 'edge-replayed',
      zone_id: 'z1',
      source_session_id: 'src-1',
      target_session_id: 'dst-1',
      scopes: ['read'],
      status: 'active',
      expires_at: '2027-03-16T00:00:00.000Z',
    }
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({
          rows: [
            {
              request_digest: requestDigest({
                principal: { client_id: 'issuer-1', subject: 'test' },
                source_session_id: 'src-1',
                target_session_id: 'dst-1',
                issuer_application_id: 'issuer-1',
                receiver_application_id: 'receiver-1',
                parent_edge_id: null,
                resource_id: null,
                scopes: ['read'],
                constraints: { broad_reason: 'resource_null_delegation', policy_approved: true },
                expires_at: '2027-03-16T00:00:00.000Z',
                ttl_seconds: null,
              }),
              response_status: 201,
              response_json: existing,
              resource_id: 'edge-replayed',
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/delegations',
      headers: { 'idempotency-key': 'retry-key-1' },
      payload: delegationBody,
    })

    expect(res.statusCode).toBe(201)
    expect(res.headers['idempotency-replayed']).toBe('true')
    expect(res.json()).toMatchObject({ delegation_edge_id: 'edge-replayed' })
    expect(client.query).toHaveBeenCalledWith('COMMIT')
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

  it('rejects the retired budget constraint before opening a transaction', async () => {
    const { app, db } = buildApp()

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/delegations',
      payload: { ...delegationBody, constraints: { budget: 1 } },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'invalid_delegation_constraint' })
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
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            { id: 'src-1', application_id: 'issuer-1' },
            { id: 'dst-1', application_id: 'receiver-1' },
          ],
        })
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
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            { id: 'src-1', application_id: 'other-issuer' },
            { id: 'dst-1', application_id: 'receiver-1' },
          ],
        })
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

  it('rejects missing active endpoint sessions', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'src-1', application_id: 'issuer-1' }] })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/delegations',
      payload: { ...delegationBody, resource_id: 'res-1' },
    })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'delegation_endpoint_not_found' })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('rejects resource references outside the zone', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            { id: 'src-1', application_id: 'issuer-1' },
            { id: 'dst-1', application_id: 'receiver-1' },
          ],
        })
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
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            { id: 'src-1', application_id: 'issuer-1' },
            { id: 'dst-1', application_id: 'receiver-1' },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ id: 'res-1', identifier: 'calendar', scopes: ['read'] }] })
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

  it('allows scopes drawn from the union of multiple constrained resources', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            { id: 'src-1', application_id: 'issuer-1' },
            { id: 'dst-1', application_id: 'receiver-1' },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            { id: 'res-1', identifier: 'calendar', scopes: ['read'] },
            { id: 'res-2', identifier: 'ledger', scopes: ['write'] },
          ],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'edge-union' }] })
        .mockResolvedValueOnce({ rows: [{ epoch: '1' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/delegations',
      payload: {
        ...delegationBody,
        scopes: ['read', 'write'],
        constraints: { resources: ['calendar', 'ledger'] },
      },
    })

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'edge-union' })
  })

  it('accepts the SDK wire shape and returns the edge row with id', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            { id: 'src-1', application_id: 'issuer-1' },
            { id: 'dst-1', application_id: 'receiver-1' },
          ],
        })
        .mockResolvedValueOnce({
          rows: [{ id: 'res-1', identifier: 'calendar', scopes: ['read', 'write'] }],
        })
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
    expect(String(resourceCall?.[0])).toContain('r.scopes')
    expect(String(resourceCall?.[0])).not.toContain('r.application_id')
    const insertCall = client.query.mock.calls.find((call) => String(call[0]).includes('INSERT INTO delegation_edges'))
    const values = insertCall?.[1] as unknown[]
    expect(values[9]).toMatchObject({ resources: ['calendar'], max_depth: 2, max_hops: 2, ttl_seconds: 30 })
  })

  it('accepts broad delegation for admins and returns warnings plus effective authority', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            { id: 'src-1', application_id: 'issuer-1' },
            { id: 'dst-1', application_id: 'receiver-1' },
          ],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ delegation_edge_id: 'edge-broad', status: 'active' }] })
        .mockResolvedValueOnce({ rows: [{ epoch: '3' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/delegations',
      payload: delegationBody,
    })

    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body).toMatchObject({
      delegation_edge_id: 'edge-broad',
      warnings: ['resource_null_delegation_broadens_resource_matching'],
      effective_authority: {
        broad: true,
        resources: [],
        parent_edges_considered: [],
      },
    })
    expect(body.allow_reason).toContain('broad_delegation_elevated')
  })

  it('rejects child delegation that widens parent authority', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            { id: 'src-1', application_id: 'issuer-1' },
            { id: 'dst-1', application_id: 'receiver-1' },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ id: 'res-2', identifier: 'files', scopes: ['read'] }] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'parent-edge',
              resource_id: null,
              resource_identifier: null,
              scopes: ['read'],
              constraints_json: { resources: ['calendar'], max_hops: 2 },
              expires_at: '2027-03-16T00:00:00.000Z',
            },
          ],
        })
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
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            { id: 'src-1', application_id: 'issuer-1' },
            { id: 'dst-1', application_id: 'receiver-1' },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ id: 'res-1', identifier: 'calendar', scopes: ['read'] }] })
        .mockResolvedValueOnce({
          rows: [
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
          ],
        })
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

  it('rejects an explicit parent edge that is not active for the source session', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            { id: 'src-1', application_id: 'issuer-1' },
            { id: 'dst-1', application_id: 'receiver-1' },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ id: 'res-1', identifier: 'calendar', scopes: ['read'] }] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'parent-edge-a',
              resource_id: 'res-1',
              resource_identifier: 'calendar',
              scopes: ['read'],
              constraints_json: { max_hops: 2 },
              expires_at: '2027-03-16T00:00:00.000Z',
            },
          ],
        })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/delegations',
      payload: {
        ...delegationBody,
        parent_edge_id: 'missing-parent',
        resource_id: 'res-1',
        constraints: { max_hops: 1 },
      },
    })

    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'parent_delegation_not_active' })
  })

  it('records the selected parent edge for downstream delegation', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            { id: 'src-1', application_id: 'issuer-1' },
            { id: 'dst-1', application_id: 'receiver-1' },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ id: 'res-1', identifier: 'calendar', scopes: ['read'] }] })
        .mockResolvedValueOnce({
          rows: [
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
          ],
        })
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
  it('returns revocation blast radius for an active Delegation', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'edge-1',
          source_session_id: 'session-1',
          target_session_id: 'session-2',
          depth: 1,
          subject_authority_record_id: 'record-2',
        },
        {
          id: 'edge-2',
          source_session_id: 'session-2',
          target_session_id: 'session-3',
          depth: 2,
          subject_authority_record_id: 'record-3',
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
      affected_sessions: ['session-2', 'session-3'],
      affected_authority_records: ['record-2', 'record-3'],
      affected_edges: [
        { id: 'edge-1', source_session_id: 'session-1', target_session_id: 'session-2', depth: 1 },
        { id: 'edge-2', source_session_id: 'session-2', target_session_id: 'session-3', depth: 2 },
      ],
    })
  })

  it('returns 404 when the target edge has no active impact rows', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones/z1/delegations/missing/impact',
    })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'delegation_not_found' })
  })

  it('rejects recursive impact reads from runtime application credentials', async () => {
    const { app, db } = buildApp(['coordinator.read'], 'issuer-1')

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/delegations/edge-1/impact' })

    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'coordinator_admin_required' })
    expect(db.query).not.toHaveBeenCalled()
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
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('receiver_application_id = $4'), ['z1', 'sess-1', 2, null])
  })

  it('limits runtime inbound reads to Delegations involving the caller application', async () => {
    const { app, db } = buildApp(['coordinator.read'], 'receiver-1')
    db.query.mockResolvedValueOnce({ rows: [{ exists: true }] }).mockResolvedValueOnce({ rows: [{ id: 'e1' }] })
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/delegations/inbound/sess-1' })

    expect(res.statusCode).toBe(200)
    expect(db.query).toHaveBeenNthCalledWith(1, expect.stringContaining('application_id = $3'), ['sess-1', 'z1', 'receiver-1'])
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('receiver_application_id = $4'), ['z1', 'sess-1', 100, 'receiver-1'])
  })

  it('does not list Delegations for another application Session', async () => {
    const { app, db } = buildApp(['coordinator.read'], 'receiver-1')
    db.query.mockResolvedValueOnce({ rows: [] })
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/delegations/inbound/sess-other' })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'session_not_found' })
    expect(db.query).toHaveBeenCalledOnce()
  })

  it('rejects an invalid query', async () => {
    const { app } = buildApp()
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/delegations/outbound/sess-1?limit=bad' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_query' })
  })

  it('validates an exact opaque inbound edge for its receiver Session', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ id: 'edge-101', status: 'active' }] })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/delegations/inbound/sess-1/edge-101' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: 'edge-101', status: 'active' })
  })

  it('binds exact inbound validation to the receiver application', async () => {
    const { app, db } = buildApp(['coordinator.read'], 'receiver-1')
    db.query.mockResolvedValueOnce({ rows: [] })
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/delegations/inbound/sess-1/edge-101' })

    expect(res.statusCode).toBe(404)
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('receiver_application_id = $4'), [
      'edge-101',
      'z1',
      'sess-1',
      'receiver-1',
    ])
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
    db.query.mockResolvedValueOnce({ rows: [{ x: 1 }] }).mockResolvedValueOnce({ rows: [{ id: 'e1' }] })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/delegations/active?cursor=e0&limit=1' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ items: [{ id: 'e1' }], next_cursor: 'e1' })
  })

  it('limits runtime active reads to Delegations involving the caller application', async () => {
    const { app, db } = buildApp(['coordinator.read'], 'app-1')
    db.query.mockResolvedValueOnce({ rows: [{ id: 'e1' }] })
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/delegations/active' })

    expect(res.statusCode).toBe(200)
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('issuer_application_id = $3 OR receiver_application_id = $3'), [
      'z1',
      100,
      'app-1',
    ])
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

  it('rejects recursive traversal from runtime application credentials', async () => {
    const { app, db } = buildApp(['coordinator.read'], 'issuer-1')

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/delegations/e1/traverse' })

    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'coordinator_admin_required' })
    expect(db.query).not.toHaveBeenCalled()
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
          id: 'p1',
          scopes: ['read', 'write'],
          resource_id: 'res-1',
          resource_identifier: 'urn:a',
          constraints_json: { max_hops: 3, ttl_seconds: 600, resources: ['urn:x'] },
          expires_at: '2027-01-01T00:00:00.000Z',
        },
        {
          id: 'p2',
          scopes: ['read'],
          resource_id: null,
          resource_identifier: null,
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

  it('does not expose effective authority for another application Session', async () => {
    const { app, db } = buildApp(['coordinator.read'], 'app-1')
    db.query.mockResolvedValueOnce({ rows: [] })
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/agents/sess-other/effective-authority' })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'session_not_found' })
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('application_id = $3'), ['sess-other', 'z1', 'app-1'])
    expect(db.query).toHaveBeenCalledOnce()
  })
})

describe('PATCH /v1/zones/:zoneId/delegations/:id/revoke', () => {
  it('returns 404 when the edge is unknown', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi
        .fn()
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
      query: vi
        .fn()
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

  it('revokes downstream edges, terminates affected agents, and deduplicates subject revocations', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ issuer_application_id: 'issuer-1' }] })
        .mockResolvedValueOnce({
          rows: [
            { id: 'edge-1', target_session_id: 'agent-2' },
            { id: 'edge-2', target_session_id: 'agent-3' },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            { id: 'agent-2', subject_authority_record_id: 'sid-shared', parent_id: null },
            { id: 'agent-3', subject_authority_record_id: 'sid-shared', parent_id: 'agent-2' },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            { id: 'agent-2', subject_authority_record_id: 'sid-shared', parent_id: null },
            { id: 'agent-3', subject_authority_record_id: 'sid-shared', parent_id: 'agent-2' },
          ],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ epoch: '5' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)
    await app.ready()

    const res = await app.inject({ method: 'PATCH', url: '/v1/zones/z1/delegations/edge-1/revoke' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      revoked_edges: 2,
      affected_sessions: 1,
      terminated_sessions: 2,
    })
    expect(client.query).toHaveBeenCalledWith('COMMIT')
    const outboxCalls = client.query.mock.calls.filter((call) => String(call[0]).includes('INSERT INTO caracal_outbox'))
    expect(outboxCalls.length).toBe(3)
  })
})
