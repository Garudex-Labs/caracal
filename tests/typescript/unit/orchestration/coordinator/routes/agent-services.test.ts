// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Agent service route unit tests for registration and zone-scoped heartbeat.

import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import '../../../../../shared/test-utils/typescript/coordinatorEnv.js'
import { agentServicesRoutes } from '../../../../../../apps/coordinator/src/routes/agent-services.js'

function buildApp(scopes = ['coordinator.admin'], clientIdOverride?: string) {
  const app = Fastify({ logger: false })
  const db = { query: vi.fn(), connect: vi.fn() }
  app.decorate('db', db as never)
  app.decorate('redis', {} as never)
  app.addHook('preHandler', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const clientId = clientIdOverride ?? (body.application_id as string) ?? 'test-client'
    ;(req as unknown as { caracalAuth: unknown }).caracalAuth = {
      zoneId: (req.params as Record<string, string>)?.zoneId ?? 'z1',
      scopes,
      subject: 'test',
      clientId,
      sessionId: 'sid-test',
      authorityRecordId: 'authority-fresh',
    }
  })
  app.register(agentServicesRoutes, { prefix: '/v1' })
  return { app, db }
}

describe('POST /v1/zones/:zoneId/agent-services', () => {
  it('rejects service registration without application ownership or delegated scope', async () => {
    const { app, db } = buildApp([], 'other-app')
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/agent-services',
      payload: {
        application_id: 'app-1',
        endpoint_url: 'https://agent.example.test/invoke',
      },
    })

    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'application_ownership_required' })
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('rejects malformed route params before database access', async () => {
    const { app, db } = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones/z!1/agent-services',
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_params' })
    expect(db.query).not.toHaveBeenCalled()
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('registers an agent service', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ exists: 1 }] })
        .mockResolvedValueOnce({ rows: [{ id: 'svc-1', zone_id: 'z1', application_id: 'app-1' }] })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/agent-services',
      payload: {
        application_id: 'app-1',
        endpoint_url: 'https://agent.example.test/invoke',
        protocol_versions: ['2026-03-16'],
      },
    })

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'svc-1', application_id: 'app-1' })
    expect(client.query).toHaveBeenCalledWith('COMMIT')
  })

  it('rejects applications outside the zone', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/agent-services',
      payload: {
        application_id: 'app-other-zone',
        endpoint_url: 'https://agent.example.test/invoke',
      },
    })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'application_not_found' })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('rolls back registration when the insert fails', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ exists: 1 }] })
        .mockRejectedValueOnce(new Error('insert failed')),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/agent-services',
      payload: {
        application_id: 'app-1',
        endpoint_url: 'https://agent.example.test/invoke',
      },
    })

    expect(res.statusCode).toBe(500)
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
    expect(client.release).toHaveBeenCalled()
  })
})

describe('POST /v1/zones/:zoneId/agents/:id/heartbeat', () => {
  it('rejects heartbeats without application ownership or elevated scope', async () => {
    const { app, db } = buildApp([], 'other-app')
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ application_id: 'app-1', status: 'active', lifecycle: 'task', lease_generation: '0' }] })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/agents/agent-1/heartbeat',
      payload: { status: 'healthy', lease_generation: 1 },
    })

    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'application_ownership_required' })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('returns 404 when the Session is inactive in the zone', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/agents/agent-1/heartbeat',
      payload: { status: 'healthy', lease_generation: 1 },
    })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'session_not_found' })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('updates agent and service state in a single transaction', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ application_id: 'app-1', status: 'active', lifecycle: 'service', lease_generation: '1' }] })
        .mockResolvedValueOnce({ rows: [{ exists: 1 }] })
        .mockResolvedValueOnce({
          rows: [{ id: 'agent-1', zone_id: 'z1', application_id: 'app-1', last_active_at: new Date(), lease_generation: '1' }],
        })
        .mockResolvedValueOnce({ rows: [{ id: 'svc-1', zone_id: 'z1', application_id: 'app-1' }] })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/agents/agent-1/heartbeat',
      payload: { service_id: 'svc-1', status: 'healthy', active_invocations: 2, lease_generation: 1 },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({
      agent: { id: 'agent-1' },
      service: { id: 'svc-1' },
      active_invocations: 2,
    })
    expect(client.query).toHaveBeenCalledWith('COMMIT')
  })

  it('rolls back heartbeat updates when the database write fails', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ application_id: 'app-1', status: 'active', lifecycle: 'service', lease_generation: '1' }] })
        .mockResolvedValueOnce({ rows: [{ exists: 1 }] })
        .mockRejectedValueOnce(new Error('update failed')),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/agents/agent-1/heartbeat',
      payload: { status: 'healthy', lease_generation: 1 },
    })

    expect(res.statusCode).toBe(500)
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
    expect(client.release).toHaveBeenCalled()
  })

  it('renews the lease without replacing the Session Authority record', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            {
              application_id: 'app-1',
              subject_authority_record_id: 'authority-stale',
              status: 'active',
              lifecycle: 'service',
              lease_generation: '1',
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ exists: 1 }] })
        .mockResolvedValueOnce({ rows: [{ id: 'agent-1', application_id: 'app-1', lease_generation: '1' }] })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/agents/agent-1/heartbeat',
      payload: { status: 'healthy', lease_generation: 1 },
    })

    expect(res.statusCode).toBe(200)
    const updateCall = client.query.mock.calls.find((call) => String(call[0]).includes('UPDATE sessions'))
    expect(updateCall?.[0]).not.toContain('subject_authority_record_id')
    expect(updateCall?.[1]).toEqual(['agent-1', 'z1', expect.any(Number), 1])
  })
})

describe('GET /v1/zones/:zoneId/agent-services: list', () => {
  it('rejects an invalid query', async () => {
    const { app } = buildApp()
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/agent-services?limit=nope' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_query' })
  })

  it('rejects an unknown cursor', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [] })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/agent-services?cursor=ghost' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_cursor' })
  })

  it('returns services with a next cursor when the page is full', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ x: 1 }] }).mockResolvedValueOnce({ rows: [{ id: 's1' }, { id: 's2' }] })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/agent-services?cursor=s0&limit=2' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ items: [{ id: 's1' }, { id: 's2' }], next_cursor: 's2' })
  })

  it('returns a null cursor for a partial page', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ id: 's1' }] })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/agent-services?limit=5' })
    expect(res.statusCode).toBe(200)
    expect(res.json().next_cursor).toBeNull()
  })
})

describe('POST /v1/zones/:zoneId/agents/:id/heartbeat: lifecycle guards', () => {
  it('returns 409 when the agent is not live', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ application_id: 'app-1', status: 'terminated', lifecycle: 'task', lease_generation: '0' }] })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/agents/agent-1/heartbeat',
      payload: { status: 'healthy', lease_generation: 1 },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'session_not_live' })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('suspends and returns 409 when a service lease has expired', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            {
              application_id: 'app-1',
              status: 'active',
              lifecycle: 'service',
              lease_expired: true,
              lease_generation: '1',
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/agents/agent-1/heartbeat',
      payload: { status: 'healthy', lease_generation: 1 },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'session_lease_expired' })
    expect(client.query).toHaveBeenCalledWith('COMMIT')
  })

  it('rejects heartbeat attachment to a task Session', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ application_id: 'app-1', status: 'active', lifecycle: 'task', lease_generation: '0' }] })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/agents/agent-1/heartbeat',
      payload: { status: 'healthy', lease_generation: 1 },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'session_not_service' })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('returns 404 when the referenced service is missing', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ application_id: 'app-1', status: 'active', lifecycle: 'service', lease_generation: '1' }] })
        .mockResolvedValueOnce({ rows: [{ exists: 1 }] })
        .mockResolvedValueOnce({ rows: [{ id: 'agent-1', application_id: 'app-1', lease_generation: '1' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/agents/agent-1/heartbeat',
      payload: { service_id: 'svc-missing', status: 'healthy', lease_generation: 1 },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'agent_service_not_found' })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })
})

describe('POST /v1/zones/:zoneId/agents/:id/lease: generation fencing', () => {
  it('acquires a new generation and renews the active service lease', async () => {
    const { app, db } = buildApp([], 'app-1')
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{ application_id: 'app-1', status: 'active', lifecycle: 'service', lease_expired: false }],
        })
        .mockResolvedValueOnce({ rows: [{ exists: 1 }] })
        .mockResolvedValueOnce({
          rows: [{ status: 'active', heartbeat_deadline_at: '2026-07-10T20:00:00Z', lease_generation: '2' }],
        })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)
    await app.ready()

    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/agents/agent-1/lease' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'active', lease_generation: 2 })
    expect(client.query).toHaveBeenCalledWith('COMMIT')
  })

  it('rejects lease acquisition while the service Session is suspended', async () => {
    const { app, db } = buildApp([], 'app-1')
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{ application_id: 'app-1', status: 'suspended', lifecycle: 'service', lease_expired: false }],
        })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)
    await app.ready()

    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/agents/agent-1/lease' })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'session_suspended' })
  })

  it('fences a heartbeat from a previous generation', async () => {
    const { app, db } = buildApp([], 'app-1')
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{ application_id: 'app-1', status: 'active', lifecycle: 'service', lease_expired: false, lease_generation: '2' }],
        })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/agents/agent-1/heartbeat',
      payload: { status: 'healthy', lease_generation: 1 },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'session_lease_fenced' })
  })

  it('terminates a service Session whose federated Subject anchor is inactive', async () => {
    const { app, db } = buildApp([], 'app-1')
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            {
              application_id: 'app-1',
              status: 'active',
              lifecycle: 'service',
              lease_expired: false,
              lease_generation: '2',
              subject_anchor_active: false,
            },
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
      url: '/v1/zones/z1/agents/agent-1/heartbeat',
      payload: { status: 'healthy', lease_generation: 2 },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'session_subject_inactive' })
    expect(client.query.mock.calls.some((call) => String(call[0]).includes('WITH RECURSIVE tree'))).toBe(true)
    expect(client.query).toHaveBeenCalledWith('COMMIT')
  })
})
