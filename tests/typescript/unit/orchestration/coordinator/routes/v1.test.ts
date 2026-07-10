// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// V1 façade route tests covering begin, end, exchange dispatch and verify shape.

import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import '../../../../../shared/test-utils/typescript/coordinatorEnv.js'
import { v1Routes } from '../../../../../../apps/coordinator/src/routes/v1.js'

function buildApp() {
  const app = Fastify({ logger: false })
  const db = { query: vi.fn(), connect: vi.fn() }
  app.decorate('db', db as never)
  app.decorate('redis', {
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
  } as never)
  app.addHook('preHandler', async (req) => {
    ;(req as unknown as { caracalAuth: unknown }).caracalAuth = {
      zoneId: 'z1',
      scopes: ['coordinator.admin'],
      subject: 'test',
      clientId: 'app-1',
      sessionId: 'sid-test',
    }
  })

  app.post('/zones/:zoneId/agents', async (req, reply) => {
    return reply.code(201).send({ agent_session_id: 'sess-spawned', application_id: 'app-1' })
  })
  app.delete('/zones/:zoneId/agents/:id', async (_req, reply) => reply.code(204).send())
  app.post('/zones/:zoneId/delegations', async (req, reply) => {
    return reply.code(201).send({ delegation_edge_id: 'edge-1', body: req.body })
  })
  app.patch('/zones/:zoneId/delegations/:id/revoke', async (_req, reply) => {
    return reply.code(200).send({ revoked: 1 })
  })

  app.register(v1Routes)
  return app
}

function buildFacadeWithRoutes(routes: {
  deleteAgent?: Parameters<ReturnType<typeof Fastify>['delete']>[1]
  revokeDelegation?: Parameters<ReturnType<typeof Fastify>['patch']>[1]
}) {
  const app = Fastify({ logger: false })
  app.decorate('db', {} as never)
  app.decorate('redis', {
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
  } as never)
  app.addHook('preHandler', async (req) => {
    ;(req as unknown as { caracalAuth: unknown }).caracalAuth = {
      zoneId: 'z1',
      scopes: ['coordinator.admin'],
      subject: 'test',
      clientId: 'app-1',
      sessionId: 'sid-test',
    }
  })
  app.delete('/zones/:zoneId/agents/:id', routes.deleteAgent ?? (async (_req, reply) => reply.code(204).send()))
  app.patch('/zones/:zoneId/delegations/:id/revoke', routes.revokeDelegation ?? (async (_req, reply) => reply.code(204).send()))
  app.register(v1Routes)
  return app
}

describe('POST /v1/begin', () => {
  it('dispatches to the underlying spawn route', async () => {
    const app = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/begin',
      payload: { zone_id: 'z1', application_id: 'app-1', subject_session_id: 'sess-1' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ agent_session_id: 'sess-spawned' })
  })
})

describe('POST /v1/end', () => {
  it('dispatches to the underlying terminate route', async () => {
    const app = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/end',
      payload: { zone_id: 'z1', agent_session_id: 'sess-1' },
    })
    expect(res.statusCode).toBe(204)
  })

  it('forwards non-empty errors from the underlying terminate route', async () => {
    const app = buildFacadeWithRoutes({
      deleteAgent: async (_req, reply) => reply.code(404).send({ error: 'session_not_found' }),
    })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/end',
      payload: { zone_id: 'z1', agent_session_id: 'missing', reason: 'operator requested' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'session_not_found' })
  })
})

describe('POST /v1/exchange', () => {
  it('dispatches to the underlying delegation route', async () => {
    const app = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/exchange',
      payload: {
        zone_id: 'z1',
        source_session_id: 's1',
        target_session_id: 's2',
        issuer_application_id: 'app-1',
        receiver_application_id: 'app-2',
        scopes: ['read'],
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.delegation_edge_id).toBe('edge-1')
    expect(body.body.zone_id).toBeUndefined()
    expect(body.body.source_session_id).toBe('s1')
  })
})

describe('POST /v1/spawn-child', () => {
  it('dispatches to spawn with the named parent session field', async () => {
    const app = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/spawn-child',
      payload: {
        zone_id: 'z1',
        application_id: 'app-1',
        subject_session_id: 'sess-1',
        parent_agent_session_id: 'parent-1',
      },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ agent_session_id: 'sess-spawned' })
  })
})

describe('POST /v1/delegate-to-existing-agent', () => {
  it('maps clear delegation names to the edge route', async () => {
    const app = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/delegate-to-existing-agent',
      payload: {
        zone_id: 'z1',
        from_agent_session_id: 'source-1',
        to_agent_session_id: 'target-1',
        issuer_application_id: 'app-1',
        receiver_application_id: 'app-2',
        scopes: ['read'],
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.body.source_session_id).toBe('source-1')
    expect(body.body.target_session_id).toBe('target-1')
  })
})

describe('POST /v1/revoke-delegation', () => {
  it('dispatches to delegation revoke', async () => {
    const app = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/revoke-delegation',
      payload: { zone_id: 'z1', delegation_edge_id: 'edge-1' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ revoked: 1 })
  })

  it('forwards empty 204 revoke responses without parsing a body', async () => {
    const app = buildFacadeWithRoutes({
      revokeDelegation: async (_req, reply) => reply.code(204).send(),
    })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/revoke-delegation',
      payload: { zone_id: 'z1', delegation_edge_id: 'edge-1' },
    })
    expect(res.statusCode).toBe(204)
    expect(res.body).toBe('')
  })
})

describe('POST /v1/verify', () => {
  it('rate-limits verification separately from the v1 façade limit', async () => {
    const app = Fastify({ logger: false })
    app.decorate('db', {} as never)
    app.decorate('redis', {
      incr: vi.fn().mockResolvedValue(10_000),
      expire: vi.fn().mockResolvedValue(1),
    } as never)
    app.addHook('preHandler', async (req) => {
      ;(req as unknown as { caracalAuth: unknown }).caracalAuth = {
        zoneId: 'z1',
        scopes: ['coordinator.admin'],
        subject: 'test',
        clientId: 'app-1',
        sessionId: 'sid-test',
      }
    })
    app.register(v1Routes)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/verify',
      payload: { token: 'not-a-jwt' },
    })
    expect(res.statusCode).toBe(429)
    expect(res.json()).toEqual({ valid: false, error: 'rate_limited' })
  })

  it('rejects when no token provided', async () => {
    const app = buildApp()
    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/verify', payload: { zone_id: 'z1' } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ valid: false, error: 'missing_token' })
  })

  it('returns 401 with structured error when token is malformed', async () => {
    const app = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/verify',
      payload: { token: 'not-a-jwt', zone_id: 'z1' },
    })
    expect(res.statusCode).toBe(401)
    const body = res.json()
    expect(body).toEqual({ valid: false, error: 'token_invalid' })
    expect(body).not.toHaveProperty('message')
  })
})

describe('rate limiting', () => {
  it('returns 429 on /v1/begin when v1 rate limit is exceeded', async () => {
    const app = Fastify({ logger: false })
    app.decorate('db', {} as never)
    app.decorate('redis', {
      incr: vi.fn().mockResolvedValue(10_000),
      expire: vi.fn().mockResolvedValue(1),
    } as never)
    app.addHook('preHandler', async (req) => {
      ;(req as unknown as { caracalAuth: unknown }).caracalAuth = {
        zoneId: 'z1',
        scopes: ['coordinator.admin'],
        subject: 'test',
        clientId: 'app-1',
        sessionId: 'sid-test',
      }
    })
    app.register(v1Routes)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/begin',
      payload: { zone_id: 'z1', application_id: 'app-1', subject_session_id: 'sess-1' },
    })
    expect(res.statusCode).toBe(429)
    expect(res.json()).toMatchObject({ error: 'rate_limited' })
  })
})
