// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Invocation route unit tests for idempotent creation and cancellation state.

import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import '../../../../../shared/test-utils/typescript/coordinatorEnv.js'
import { invocationsRoutes } from '../../../../../../apps/coordinator/src/routes/invocations.js'
import { requestDigest } from '../../../../../../apps/coordinator/src/idempotency.js'

function buildApp(scopes = ['coordinator.admin'], clientId = 'app-1') {
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
      scopes,
      subject: 'test',
      clientId,
      sessionId: 'sid-test',
    }
  })
  app.register(invocationsRoutes, { prefix: '/v1' })
  return { app, db }
}

describe('POST /v1/zones/:zoneId/invocations', () => {
  it('returns 404 when the target service is missing', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/invocations',
      payload: { service_id: 'svc-missing', idempotency_key: 'idem-1', method: 'run' },
    })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'agent_service_not_found' })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('returns 403 when the caller cannot invoke from the source application', async () => {
    const { app, db } = buildApp([], 'other-app')
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ application_id: 'app-1' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/invocations',
      payload: { service_id: 'svc-1', idempotency_key: 'idem-1', method: 'run' },
    })

    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'invoker_ownership_required' })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('creates a pending invocation and enqueues an outbox event', async () => {
    const { app, db } = buildApp()
    const calls: Array<[string, unknown[] | undefined]> = []
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        calls.push([sql, values])
        if (sql.includes('FROM agent_services')) return { rows: [{ application_id: 'app-1' }] }
        if (sql.includes('SELECT request_digest')) return { rows: [] }
        if (sql.includes('INSERT INTO agent_invocations')) {
          return { rows: [{ id: 'inv-1', zone_id: 'z1', service_id: 'svc-1', status: 'pending' }] }
        }
        return { rows: [], rowCount: 0 }
      }),
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
    const outboxCall = calls.find((call) => call[0].includes('caracal_outbox'))
    expect(outboxCall?.[1]?.[1]).toBe('caracal.invocations.lifecycle')
    expect(outboxCall?.[1]?.[2]).toContain('invocation.created:')
    const receiptCall = calls.find((call) => call[0].includes('INSERT INTO coordinator_idempotency_receipts'))
    expect(receiptCall).toBeDefined()
    expect(receiptCall?.[1]?.[4]).toBeInstanceOf(Buffer)
    expect(receiptCall?.[1]).not.toContain('idem-1')
  })

  it('replays an existing invocation receipt before charging the rate limit', async () => {
    const { app, db } = buildApp()
    const existing = { id: 'inv-existing', status: 'running' }
    const digest = requestDigest({
      principal: { client_id: 'app-1', subject: 'test' },
      service_id: 'svc-1',
      source_session_id: null,
      target_session_id: null,
      method: 'run',
      params: {},
      metadata: {},
      timeout_ms: 30000,
      retry_policy: { max_attempts: 3, backoff_ms: 1000 },
    })
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM agent_services')) return { rows: [{ application_id: 'app-1' }] }
        if (sql.includes('SELECT request_digest')) {
          return { rows: [{ request_digest: digest, response_status: 201, response_json: existing, resource_id: 'inv-existing' }] }
        }
        return { rows: [], rowCount: 0 }
      }),
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

    expect(res.statusCode).toBe(201)
    expect(res.headers['idempotency-replayed']).toBe('true')
    expect(JSON.parse(res.body)).toMatchObject({ id: 'inv-existing', status: 'running' })
  })

  it('rejects an invocation key reused with changed parameters', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM agent_services')) return { rows: [{ application_id: 'app-1' }] }
        if (sql.includes('SELECT request_digest')) {
          return { rows: [{ request_digest: Buffer.alloc(32, 3), response_status: 201, response_json: {}, resource_id: 'inv-1' }] }
        }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/invocations',
      payload: { service_id: 'svc-1', idempotency_key: 'idem-1', method: 'run', params: { changed: true } },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: 'idempotency_key_conflict' })
  })

  it('rejects invocation sessions outside the zone', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi
        .fn()
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
    expect(JSON.parse(res.body)).toMatchObject({ error: 'session_not_found' })
  })
})

describe('PATCH /v1/zones/:zoneId/invocations/:id/cancel', () => {
  it('returns 404 when the invocation to cancel is unknown', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)
    await app.ready()
    const res = await app.inject({ method: 'PATCH', url: '/v1/zones/z1/invocations/missing/cancel' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'invocation_not_found' })
  })

  it('returns 403 when the caller cannot cancel the invocation', async () => {
    const { app, db } = buildApp([], 'other-app')
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ application_id: 'app-1' }] })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)
    await app.ready()
    const res = await app.inject({ method: 'PATCH', url: '/v1/zones/z1/invocations/inv-1/cancel' })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'invoker_ownership_required' })
  })

  it('returns 409 when the invocation cannot be canceled', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ application_id: 'app-1' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)
    await app.ready()
    const res = await app.inject({ method: 'PATCH', url: '/v1/zones/z1/invocations/inv-1/cancel' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'invocation_not_cancelable' })
  })

  it('records cancellation and emits an invocation event', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi
        .fn()
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
        zoneId: 'z1',
        scopes: ['coordinator.admin'],
        subject: 'test',
        clientId: 'app-1',
      }
    })
    app.register(invocationsRoutes, { prefix: '/v1' })
    db.connect.mockResolvedValueOnce({
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM agent_services')) return { rows: [{ application_id: 'app-1' }] }
        if (sql.includes('SELECT request_digest')) return { rows: [] }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    })
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
      query: vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValue({ rows: [] }),
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
      query: vi
        .fn()
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

  it('returns 403 when the caller cannot start the invocation', async () => {
    const { app, db } = buildApp([], 'other-app')
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ application_id: 'app-1' }] })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)
    await app.ready()
    const res = await app.inject({ method: 'PATCH', url: '/v1/zones/z1/invocations/inv-1/start' })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'invoker_ownership_required' })
  })

  it('marks the invocation running and commits', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi
        .fn()
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
      method: 'PATCH',
      url: '/v1/zones/z1/invocations/inv-1/complete',
      payload: { status: 'bogus' },
    })
    expect(res.statusCode).toBe(500)
  })

  it('returns 409 when the invocation is not completable', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ application_id: 'app-1' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)
    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1/invocations/inv-1/complete',
      payload: { status: 'succeeded' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'invocation_not_completable' })
  })

  it('returns 404 when the invocation to complete is unknown', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)
    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1/invocations/missing/complete',
      payload: { status: 'succeeded' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'invocation_not_found' })
  })

  it('returns 403 when the caller cannot complete the invocation', async () => {
    const { app, db } = buildApp([], 'other-app')
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ application_id: 'app-1' }] })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)
    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1/invocations/inv-1/complete',
      payload: { status: 'succeeded' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'invoker_ownership_required' })
  })

  it('completes a running invocation', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi
        .fn()
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
      method: 'PATCH',
      url: '/v1/zones/z1/invocations/inv-1/complete',
      payload: { status: 'succeeded', metadata: { ok: true } },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: 'inv-1', status: 'succeeded' })
    expect(client.query).toHaveBeenCalledWith('COMMIT')
  })
})
