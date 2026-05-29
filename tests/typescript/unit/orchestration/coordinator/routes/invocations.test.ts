// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Invocation route unit tests for idempotent creation and cancellation state.

import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import '../../../../../shared/test-utils/typescript/coordinatorEnv.js'
import { invocationsRoutes } from '../../../../../../apps/coordinator/src/routes/invocations.js'

function buildApp() {
  const app = Fastify({ logger: false })
  const db = {
    query: vi.fn(),
    connect: vi.fn(),
  }
  app.decorate('db', db as never)
  app.decorate('redis', { xadd: vi.fn(), incr: vi.fn(async () => 1), expire: vi.fn() } as never)
  app.addHook('preHandler', async (req) => {
    ;(req as unknown as { caracalAuth: unknown }).caracalAuth = {
      zoneId: (req.params as Record<string, string>)?.zoneId ?? 'z1',
      scopes: ['coordinator.admin'],
      subject: 'test',
      clientId: 'app-1',
      sessionId: 'sid-test',
    }
  })
  app.register(invocationsRoutes, { prefix: '/v1' })
  return { app, db }
}

describe('POST /v1/zones/:zoneId/invocations', () => {
  it('creates a pending invocation and enqueues an outbox event', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'svc-1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'inv-1', zone_id: 'z1', service_id: 'svc-1', status: 'pending' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/invocations',
      payload: {
        service_id: 'svc-1',
        idempotency_key: 'idem-1',
        method: 'run',
        params: { task: 'summarize' },
      },
    })

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'inv-1', status: 'pending' })
    const outboxCall = client.query.mock.calls.find((call) => String(call[0]).includes('caracal_outbox'))
    expect(outboxCall?.[1]?.[1]).toBe('caracal.invocations.lifecycle')
    expect(outboxCall?.[1]?.[2]).toContain('invocation.created:')
  })

  it('returns an existing invocation for the same idempotency key', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'svc-1' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'inv-existing', status: 'running' }] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/invocations',
      payload: {
        service_id: 'svc-1',
        idempotency_key: 'idem-1',
        method: 'run',
      },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'inv-existing', status: 'running' })
  })

  it('rejects invocation sessions outside the zone', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'svc-1' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/invocations',
      payload: {
        service_id: 'svc-1',
        source_session_id: 'agent-other-zone',
        idempotency_key: 'idem-1',
        method: 'run',
      },
    })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'agent_session_not_found' })
  })
})

describe('PATCH /v1/zones/:zoneId/invocations/:id/cancel', () => {
  it('records cancellation and emits an invocation event', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ application_id: 'app-1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'inv-1', status: 'cancel_requested' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1/invocations/inv-1/cancel',
      payload: { reason: 'user_cancelled' },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'inv-1', status: 'cancel_requested' })
    const outboxCall = client.query.mock.calls.find((call) => String(call[0]).includes('caracal_outbox'))
    expect(outboxCall?.[1]?.[1]).toBe('caracal.invocations.lifecycle')
    expect(outboxCall?.[1]?.[2]).toContain('invocation.cancel_requested:')
  })
})

describe('rate limiting', () => {
  it('returns 429 when invocation mutation rate limit is exceeded', async () => {
    const app = Fastify({ logger: false })
    const db = { query: vi.fn(), connect: vi.fn() }
    app.decorate('db', db as never)
    app.decorate('redis', {
      xadd: vi.fn(),
      incr: vi.fn(async () => 10_000),
      expire: vi.fn(),
    } as never)
    app.addHook('preHandler', async (req) => {
      ;(req as unknown as { caracalAuth: unknown }).caracalAuth = {
        zoneId: 'z1', scopes: ['coordinator.admin'], subject: 'test', clientId: 'app-1',
      }
    })
    app.register(invocationsRoutes, { prefix: '/v1' })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/invocations',
      payload: { service_id: 'svc-1', idempotency_key: 'k', method: 'run' },
    })
    expect(res.statusCode).toBe(429)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'rate_limited' })
  })
})
describe('GET /v1/zones/:zoneId/invocations/:id', () => {
  it('returns 404 when the invocation is unknown', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [] })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/invocations/missing' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'invocation_not_found' })
  })

  it('returns the invocation row', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ id: 'inv-1', status: 'pending' }] })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/invocations/inv-1' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: 'inv-1', status: 'pending' })
  })
})

describe('PATCH /v1/zones/:zoneId/invocations/:id/start', () => {
  it('returns 404 when the invocation is unknown', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)
    await app.ready()
    const res = await app.inject({ method: 'PATCH', url: '/v1/zones/z1/invocations/missing/start' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'invocation_not_found' })
  })

  it('returns 409 when the invocation is not startable', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ application_id: 'app-1' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)
    await app.ready()
    const res = await app.inject({ method: 'PATCH', url: '/v1/zones/z1/invocations/inv-1/start' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'invocation_not_startable' })
  })

  it('marks the invocation running and commits', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ application_id: 'app-1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'inv-1', service_id: 'svc-1', status: 'running' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)
    await app.ready()
    const res = await app.inject({ method: 'PATCH', url: '/v1/zones/z1/invocations/inv-1/start' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: 'inv-1', status: 'running' })
    expect(client.query).toHaveBeenCalledWith('COMMIT')
  })
})

describe('PATCH /v1/zones/:zoneId/invocations/:id/complete', () => {
  it('rejects an invalid status', async () => {
    const { app } = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'PATCH', url: '/v1/zones/z1/invocations/inv-1/complete',
      payload: { status: 'bogus' },
    })
    expect(res.statusCode).toBe(500)
  })

  it('returns 409 when the invocation is not completable', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ application_id: 'app-1' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)
    await app.ready()
    const res = await app.inject({
      method: 'PATCH', url: '/v1/zones/z1/invocations/inv-1/complete',
      payload: { status: 'succeeded' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'invocation_not_completable' })
  })

  it('completes a running invocation', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ application_id: 'app-1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'inv-1', service_id: 'svc-1', status: 'succeeded' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)
    await app.ready()
    const res = await app.inject({
      method: 'PATCH', url: '/v1/zones/z1/invocations/inv-1/complete',
      payload: { status: 'succeeded', metadata: { ok: true } },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: 'inv-1', status: 'succeeded' })
    expect(client.query).toHaveBeenCalledWith('COMMIT')
  })
})
