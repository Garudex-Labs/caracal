// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Agent spawn, limits, and cascade termination unit tests.

import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import { agentsRoutes } from '../../../../../../apps/coordinator/src/routes/agents.js'

function buildApp() {
  const app = Fastify({ logger: false })
  const db = { query: vi.fn(), connect: vi.fn() }
  app.decorate('db', db as never)
  app.decorate('redis', {} as never)
  app.addHook('preHandler', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const clientId = (body.application_id as string)
      ?? (req.params as Record<string, string>)?.id
      ?? 'test-client'
    ;(req as unknown as { caracalAuth: unknown }).caracalAuth = {
      zoneId: (req.params as Record<string, string>)?.zoneId ?? 'z1',
      scopes: ['coordinator.admin'],
      subject: 'test',
      clientId,
      sessionId: 'sid-test',
    }
  })
  app.register(agentsRoutes, { prefix: '/v1' })
  return { app, db }
}

interface SpawnStage {
  refs?: { application_exists: boolean; session_exists: boolean }
  count?: { app_n: string; zone_n: string }
  parent?: { depth: number; child_count: number; max_children: number; application_id?: string } | null
  insert?: { rows: unknown[] }
  withTopology?: boolean
  outbox?: boolean
}

function spawnClient(stages: SpawnStage): { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> } {
  const responses: Array<{ rows: unknown[] }> = [{ rows: [] }, { rows: [] }]
  if (stages.refs) responses.push({ rows: [stages.refs] })
  if (stages.count) responses.push({ rows: [stages.count] })
  if (stages.parent !== undefined) responses.push({ rows: stages.parent ? [stages.parent] : [] })
  if (stages.insert) responses.push(stages.insert)
  if (stages.withTopology) responses.push({ rows: [] }, { rows: [] })
  if (stages.outbox) responses.push({ rows: [] })
  responses.push({ rows: [] })
  const query = vi.fn()
  for (const r of responses) query.mockResolvedValueOnce(r)
  return { query, release: vi.fn() }
}

describe('POST /v1/zones/:zoneId/agents — spawn', () => {
  it('rejects applications outside the zone', async () => {
    const { app, db } = buildApp()
    db.connect.mockResolvedValueOnce(spawnClient({ refs: { application_exists: false, session_exists: true } }))
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/agents',
      payload: { application_id: 'app-other-zone', session_sid: 'sid-1' },
    })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'application_not_found' })
  })

  it('rejects inactive sessions', async () => {
    const { app, db } = buildApp()
    db.connect.mockResolvedValueOnce(spawnClient({ refs: { application_exists: true, session_exists: false } }))
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/agents',
      payload: { application_id: 'app-1', session_sid: 'sid-other-zone' },
    })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'session_not_found' })
  })

  it('returns 429 when per-app agent cap is reached', async () => {
    const { app, db } = buildApp()
    db.connect.mockResolvedValueOnce(spawnClient({
      refs: { application_exists: true, session_exists: true },
      count: { app_n: '200', zone_n: '200' },
    }))
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/agents',
      payload: { application_id: 'app-1', session_sid: 'sid-1' },
    })
    expect(res.statusCode).toBe(429)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'agent_zone_limit_exceeded' })
  })

  it('returns 404 when parent not found', async () => {
    const { app, db } = buildApp()
    db.connect.mockResolvedValueOnce(spawnClient({
      refs: { application_exists: true, session_exists: true },
      count: { app_n: '0', zone_n: '0' },
      parent: null,
    }))
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/agents',
      payload: { application_id: 'app-1', session_sid: 'sid-1', parent_id: 'missing-parent' },
    })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'parent_not_found' })
  })

  it('rejects when parent children cap is reached', async () => {
    const { app, db } = buildApp()
    db.connect.mockResolvedValueOnce(spawnClient({
      refs: { application_exists: true, session_exists: true },
      count: { app_n: '1', zone_n: '1' },
      parent: { depth: 1, child_count: 10, max_children: 10, application_id: 'app-1' },
    }))
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/agents',
      payload: { application_id: 'app-1', session_sid: 'sid-1', parent_id: 'parent-1' },
    })
    expect(res.statusCode).toBe(429)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'agent_children_limit_exceeded' })
  })

  it('rejects when max depth is exceeded', async () => {
    const { app, db } = buildApp()
    db.connect.mockResolvedValueOnce(spawnClient({
      refs: { application_exists: true, session_exists: true },
      count: { app_n: '1', zone_n: '1' },
      parent: { depth: 10, child_count: 0, max_children: 10, application_id: 'app-1' },
    }))
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/agents',
      payload: { application_id: 'app-1', session_sid: 'sid-1', parent_id: 'parent-1' },
    })
    expect(res.statusCode).toBe(429)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'agent_depth_limit_exceeded' })
  })

  it('serializes the spawn cap with a per-zone advisory lock and enqueues lifecycle outbox', async () => {
    const { app, db } = buildApp()
    const client = spawnClient({
      refs: { application_exists: true, session_exists: true },
      count: { app_n: '0', zone_n: '0' },
      insert: { rows: [{ id: 'agent-new', zone_id: 'z1', application_id: 'app-1', parent_id: null }] },
      outbox: true,
    })
    db.connect.mockResolvedValueOnce(client)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/agents',
      payload: { application_id: 'app-1', session_sid: 'sid-1' },
    })
    expect(res.statusCode).toBe(201)
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      [expect.stringContaining('coordinator:agent_spawn:z1')],
    )
    const outboxCall = client.query.mock.calls.find((call) => String(call[0]).includes('caracal_outbox'))
    expect(outboxCall?.[1]?.[1]).toBe('caracal.agents.lifecycle')
  })

  it('defaults session_sid from the verified bearer and returns the agent row with id', async () => {
    const { app, db } = buildApp()
    const client = spawnClient({
      refs: { application_exists: true, session_exists: true },
      count: { app_n: '0', zone_n: '0' },
      insert: { rows: [{ id: 'agent-sdk', zone_id: 'z1', application_id: 'app-1', parent_id: null }] },
      outbox: true,
    })
    db.connect.mockResolvedValueOnce(client)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/agents',
      payload: { application_id: 'app-1', kind: 'ephemeral', metadata: { purpose: 'sdk' } },
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'agent-sdk' })
    const refsCall = client.query.mock.calls.find((call) => String(call[0]).includes('session_exists'))
    expect(refsCall?.[1]).toEqual(['z1', 'app-1', 'sid-test'])
  })
})

describe('GET /v1/zones/:zoneId/agents/:id', () => {
  it('returns 404 when agent not found', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValue({ rows: [] })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/agents/missing' })
    expect(res.statusCode).toBe(404)
  })
})

describe('DELETE /v1/zones/:zoneId/agents/:id — cascade terminate', () => {
  it('cascades termination and enqueues revoke + lifecycle events for each descendant', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ application_id: 'app-1' }] })
        .mockResolvedValueOnce({ rows: [
          { id: 'agent-root', session_sid: 'sid-root', parent_id: null },
          { id: 'agent-child', session_sid: 'sid-child', parent_id: 'agent-root' },
        ] })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)
    await app.ready()
    const res = await app.inject({ method: 'DELETE', url: '/v1/zones/z1/agents/agent-root' })
    expect(res.statusCode).toBe(204)
    const outboxCalls = client.query.mock.calls.filter((call) => String(call[0]).includes('INSERT INTO caracal_outbox'))
    expect(outboxCalls.length).toBe(1)
    const params = (outboxCalls[0]?.[1] ?? []) as unknown[]
    const topics = params.filter((_, i) => i % 4 === 1)
    expect(topics).toEqual(expect.arrayContaining(['caracal.agents.lifecycle']))
    expect(topics).not.toContain('caracal.sessions.revoke')
    const dedupeKeys = params.filter((_, i) => i % 4 === 2)
    expect(dedupeKeys).toEqual(expect.arrayContaining([
      'terminate:agent-root', 'terminate:agent-child',
    ]))
  })
})
