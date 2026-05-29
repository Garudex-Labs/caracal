// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Agent spawn, limits, and cascade termination unit tests.

import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import '../../../../../shared/test-utils/typescript/coordinatorEnv.js'
import { agentsRoutes } from '../../../../../../apps/coordinator/src/routes/agents.js'

function buildApp() {
  const app = Fastify({ logger: false })
  const db = { query: vi.fn(), connect: vi.fn() }
  app.decorate('db', db as never)
  app.decorate('redis', {} as never)
  app.setErrorHandler((err, _req, reply) => {
    if (err && typeof err === 'object' && 'issues' in err) {
      reply.code(400).send({ error: 'invalid_body' })
      return
    }
    reply.send(err)
  })
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
  refs?: { application_exists: boolean; session_exists: boolean; registration_method?: 'managed' | 'dcr' }
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

describe('POST /v1/zones/:zoneId/agents: spawn', () => {
  it('rejects applications outside the zone', async () => {
    const { app, db } = buildApp()
    db.connect.mockResolvedValueOnce(spawnClient({ refs: { application_exists: false, session_exists: true } }))
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/agents',
      payload: { application_id: 'app-other-zone', subject_session_id: 'sid-1' },
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
      payload: { application_id: 'app-1', subject_session_id: 'sid-other-zone' },
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
      payload: { application_id: 'app-1', subject_session_id: 'sid-1' },
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
      payload: { application_id: 'app-1', subject_session_id: 'sid-1', parent_id: 'missing-parent' },
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
      payload: { application_id: 'app-1', subject_session_id: 'sid-1', parent_id: 'parent-1' },
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
      payload: { application_id: 'app-1', subject_session_id: 'sid-1', parent_id: 'parent-1' },
    })
    expect(res.statusCode).toBe(429)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'agent_depth_limit_exceeded' })
  })

  it('requires DCR applications to spawn ephemeral agent sessions', async () => {
    const { app, db } = buildApp()
    db.connect.mockResolvedValueOnce(spawnClient({
      refs: { application_exists: true, session_exists: true, registration_method: 'dcr' },
    }))
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/agents',
      payload: { application_id: 'app-1', subject_session_id: 'sid-1', kind: 'service' },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'dcr_requires_ephemeral_agent' })
  })

  it('binds each DCR application to only one active agent session', async () => {
    const { app, db } = buildApp()
    db.connect.mockResolvedValueOnce(spawnClient({
      refs: { application_exists: true, session_exists: true, registration_method: 'dcr' },
      count: { app_n: '1', zone_n: '1' },
    }))
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/agents',
      payload: { application_id: 'app-1', subject_session_id: 'sid-1', kind: 'ephemeral' },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'dcr_application_already_bound' })
  })

  it('serializes the spawn cap with a per-zone advisory lock and enqueues lifecycle outbox', async () => {
    const { app, db } = buildApp()
    const client = spawnClient({
      refs: { application_exists: true, session_exists: true },
      count: { app_n: '0', zone_n: '0' },
      insert: { rows: [{ agent_session_id: 'agent-new', zone_id: 'z1', application_id: 'app-1', parent_id: null }] },
      outbox: true,
    })
    db.connect.mockResolvedValueOnce(client)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/agents',
      payload: { application_id: 'app-1', subject_session_id: 'sid-1' },
    })
    expect(res.statusCode).toBe(201)
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      [expect.stringContaining('coordinator:agent_spawn:z1')],
    )
    const outboxCall = client.query.mock.calls.find((call) => String(call[0]).includes('caracal_outbox'))
    expect(outboxCall?.[1]?.[1]).toBe('caracal.agents.lifecycle')
  })

  it('defaults subject_session_id from the verified bearer and returns the agent session id', async () => {
    const { app, db } = buildApp()
    const client = spawnClient({
      refs: { application_exists: true, session_exists: true },
      count: { app_n: '0', zone_n: '0' },
      insert: { rows: [{ agent_session_id: 'agent-sdk', zone_id: 'z1', application_id: 'app-1', parent_id: null }] },
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
    expect(JSON.parse(res.body)).toMatchObject({ agent_session_id: 'agent-sdk' })
    const refsCall = client.query.mock.calls.find((call) => String(call[0]).includes('session_exists'))
    expect(refsCall?.[1]).toEqual(['z1', 'app-1', 'sid-test'])
  })

  it('rejects oversized capability metadata before spawning', async () => {
    const { app, db } = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/agents',
      payload: { application_id: 'app-1', subject_session_id: 'sid-1', capabilities: Array.from({ length: 33 }, (_, i) => `cap${i}`) },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_body' })
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('rejects overlong capability values before spawning', async () => {
    const { app, db } = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/agents',
      payload: { application_id: 'app-1', subject_session_id: 'sid-1', capabilities: ['x'.repeat(65)] },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_body' })
    expect(db.connect).not.toHaveBeenCalled()
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

describe('DELETE /v1/zones/:zoneId/agents/:id: cascade terminate', () => {
  it('cascades termination and enqueues revoke + lifecycle events for each descendant', async () => {
    const { app, db } = buildApp()
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ application_id: 'app-1' }] })
        .mockResolvedValueOnce({ rows: [
          { id: 'agent-root', subject_session_id: 'sid-root', parent_id: null },
          { id: 'agent-child', subject_session_id: 'sid-child', parent_id: 'agent-root' },
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
    expect(topics).toEqual(expect.arrayContaining(['caracal.agents.lifecycle', 'caracal.sessions.revoke']))
    const dedupeKeys = params.filter((_, i) => i % 4 === 2)
    expect(dedupeKeys).toEqual(expect.arrayContaining([
      'terminate:agent-root', 'terminate:agent-child',
      'agent_terminate:agent-root', 'agent_terminate:agent-child',
    ]))
    const payloads = params.filter((_, i) => i % 4 === 3)
    expect(payloads).toEqual(expect.arrayContaining([
      expect.objectContaining({ session_id: 'sid-root', agent_session_id: 'agent-root' }),
      expect.objectContaining({ session_id: 'sid-child', agent_session_id: 'agent-child' }),
    ]))
  })
})

function seqClient(responses: Array<{ rows: unknown[] }>): {
  query: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
} {
  const query = vi.fn()
  for (const r of responses) query.mockResolvedValueOnce(r)
  query.mockResolvedValue({ rows: [] })
  return { query, release: vi.fn() }
}

describe('GET /v1/zones/:zoneId/agents: list', () => {
  it('rejects an invalid query', async () => {
    const { app } = buildApp()
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/agents?limit=abc' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_query' })
  })

  it('rejects an unknown cursor', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [] })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/agents?cursor=ghost' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_cursor' })
  })

  it('returns items with a next cursor when the page is full', async () => {
    const { app, db } = buildApp()
    db.query
      .mockResolvedValueOnce({ rows: [{ x: 1 }] })
      .mockResolvedValueOnce({ rows: [{ agent_session_id: 'a1' }, { agent_session_id: 'a2' }] })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/agents?cursor=a3&limit=2' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      items: [{ agent_session_id: 'a1' }, { agent_session_id: 'a2' }],
      next_cursor: 'a2',
    })
  })

  it('returns a null cursor for a partial page', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ agent_session_id: 'a1' }] })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/agents?limit=5' })
    expect(res.statusCode).toBe(200)
    expect(res.json().next_cursor).toBeNull()
  })
})

describe('GET /v1/zones/:zoneId/agents/:id/children', () => {
  it('returns the child rows', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ agent_session_id: 'child-1' }] })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/agents/parent/children' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([{ agent_session_id: 'child-1' }])
  })
})

describe('PATCH /v1/zones/:zoneId/agents/:id/suspend', () => {
  it('returns 404 when the agent is unknown', async () => {
    const { app, db } = buildApp()
    const client = seqClient([{ rows: [] }, { rows: [] }])
    db.connect.mockResolvedValueOnce(client)
    await app.ready()
    const res = await app.inject({ method: 'PATCH', url: '/v1/zones/z1/agents/missing/suspend' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'agent_not_found' })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('returns 409 when nothing is active to suspend', async () => {
    const { app, db } = buildApp()
    const client = seqClient([
      { rows: [] },
      { rows: [{ application_id: 'app1' }] },
      { rows: [] },
    ])
    db.connect.mockResolvedValueOnce(client)
    await app.ready()
    const res = await app.inject({ method: 'PATCH', url: '/v1/zones/z1/agents/a1/suspend' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'agent_not_found_or_not_active' })
  })

  it('suspends the subtree and commits', async () => {
    const { app, db } = buildApp()
    const client = seqClient([
      { rows: [] },
      { rows: [{ application_id: 'app1' }] },
      { rows: [{ id: 'a1', subject_session_id: 's1', parent_id: null }] },
      { rows: [] },
      { rows: [] },
    ])
    db.connect.mockResolvedValueOnce(client)
    await app.ready()
    const res = await app.inject({ method: 'PATCH', url: '/v1/zones/z1/agents/a1/suspend' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ suspended: 1 })
    expect(client.query).toHaveBeenCalledWith('COMMIT')
  })
})

describe('PATCH /v1/zones/:zoneId/agents/:id/resume', () => {
  it('returns 404 when the agent is unknown', async () => {
    const { app, db } = buildApp()
    const client = seqClient([{ rows: [] }, { rows: [] }])
    db.connect.mockResolvedValueOnce(client)
    await app.ready()
    const res = await app.inject({ method: 'PATCH', url: '/v1/zones/z1/agents/missing/resume' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'agent_not_found' })
  })

  it('returns 409 when nothing is suspended', async () => {
    const { app, db } = buildApp()
    const client = seqClient([
      { rows: [] },
      { rows: [{ application_id: 'app1' }] },
      { rows: [] },
    ])
    db.connect.mockResolvedValueOnce(client)
    await app.ready()
    const res = await app.inject({ method: 'PATCH', url: '/v1/zones/z1/agents/a1/resume' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'agent_not_found_or_not_suspended' })
  })

  it('resumes the subtree and enqueues lifecycle events', async () => {
    const { app, db } = buildApp()
    const client = seqClient([
      { rows: [] },
      { rows: [{ application_id: 'app1' }] },
      { rows: [{ id: 'a1', parent_id: null }] },
      { rows: [] },
      { rows: [] },
    ])
    db.connect.mockResolvedValueOnce(client)
    await app.ready()
    const res = await app.inject({ method: 'PATCH', url: '/v1/zones/z1/agents/a1/resume' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ resumed: 1 })
    expect(client.query).toHaveBeenCalledWith('COMMIT')
  })
})
