// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// V1 façade route tests covering begin, end, exchange dispatch and verify shape.

import { describe, it, expect, vi, beforeAll } from 'vitest'
import Fastify from 'fastify'
import { v1Routes } from '../../../../../../apps/coordinator/src/routes/v1.js'

beforeAll(() => {
  process.env.ISSUER_URL ??= 'http://issuer.test'
  process.env.STS_URL ??= 'http://sts.test'
  process.env.AGENT_COORDINATOR_SCOPE ??= 'coordinator.use'
  process.env.DATABASE_URL ??= 'postgres://x'
  process.env.REDIS_URL ??= 'redis://x'
})

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
      zoneId: 'z1', scopes: ['coordinator.admin'],
      subject: 'test', clientId: 'app-1', sessionId: 'sid-test',
    }
  })

  app.post('/zones/:zoneId/agents', async (req, reply) => {
    return reply.code(201).send({ id: 'sess-spawned', application_id: 'app-1' })
  })
  app.delete('/zones/:zoneId/agents/:id', async (_req, reply) => reply.code(204).send())
  app.post('/zones/:zoneId/delegations', async (req, reply) => {
    return reply.code(201).send({ id: 'edge-1', body: req.body })
  })

  app.register(v1Routes)
  return app
}

describe('POST /v1/begin', () => {
  it('dispatches to the underlying spawn route', async () => {
    const app = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'POST', url: '/v1/begin',
      payload: { zone_id: 'z1', application_id: 'app-1', session_sid: 'sess-1' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ id: 'sess-spawned' })
  })
})

describe('POST /v1/end', () => {
  it('dispatches to the underlying terminate route', async () => {
    const app = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'POST', url: '/v1/end',
      payload: { zone_id: 'z1', session_id: 'sess-1' },
    })
    expect(res.statusCode).toBe(204)
  })
})

describe('POST /v1/exchange', () => {
  it('dispatches to the underlying delegation route', async () => {
    const app = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'POST', url: '/v1/exchange',
      payload: {
        zone_id: 'z1',
        source_session_id: 's1', target_session_id: 's2',
        issuer_application_id: 'app-1', receiver_application_id: 'app-2',
        scopes: ['read'],
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.id).toBe('edge-1')
    expect(body.body.zone_id).toBeUndefined()
    expect(body.body.source_session_id).toBe('s1')
  })
})

describe('POST /v1/verify', () => {
  it('rejects when no token provided', async () => {
    const app = buildApp()
    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/verify', payload: {} })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ valid: false, error: 'missing_token' })
  })

  it('returns 401 with structured error when token is malformed', async () => {
    const app = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'POST', url: '/v1/verify',
      payload: { token: 'not-a-jwt' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ valid: false })
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
        zoneId: 'z1', scopes: ['coordinator.admin'],
        subject: 'test', clientId: 'app-1', sessionId: 'sid-test',
      }
    })
    app.register(v1Routes)
    await app.ready()
    const res = await app.inject({
      method: 'POST', url: '/v1/begin',
      payload: { zone_id: 'z1', application_id: 'app-1', session_sid: 'sess-1' },
    })
    expect(res.statusCode).toBe(429)
    expect(res.json()).toMatchObject({ error: 'rate_limited' })
  })
})
