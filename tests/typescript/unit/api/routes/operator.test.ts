// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Operator Control API route unit tests: conversation ledger lifecycle and append-only turns.

import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import type { DB } from '../../../../../apps/api/src/db.js'
import type { RedisClient } from '../../../../../apps/api/src/redis.js'
import '../../../../../apps/api/src/fastify-augmentation.js'
import { operatorRoutes } from '../../../../../apps/api/src/routes/operator.js'

function buildApp(
  enabled = true,
  authorityOpts: {
    allowedCapabilities?: string[]
    systemZones?: string[]
    aiProviders?: { id: string; baseUrl: string; model: string; apiKey?: string; timeoutMs: number; contextWindow: number }[]
    fetchImpl?: typeof fetch
  } = {},
) {
  const app = Fastify({ logger: false })
  const clientQuery = vi.fn()
  const release = vi.fn()
  const db = {
    query: vi.fn(),
    connect: vi.fn().mockResolvedValue({ query: clientQuery, release }),
  }
  const redis = { incr: vi.fn(), expire: vi.fn(), set: vi.fn() }
  app.decorate('db', db as unknown as DB)
  app.decorate('redis', redis as unknown as RedisClient)
  app.addHook('preHandler', async (req) => {
    ;(req as unknown as { actor: unknown }).actor = {
      id: 'actor-1',
      name: 'operator',
      scope: 'zone',
      zoneId: 'z1',
    }
  })
  app.register(operatorRoutes, {
    prefix: '/v1',
    enabled,
    allowedCapabilities: authorityOpts.allowedCapabilities ?? null,
    systemZones: authorityOpts.systemZones ?? null,
    aiProviders: authorityOpts.aiProviders,
    fetchImpl: authorityOpts.fetchImpl,
  })
  return { app, db, clientQuery }
}

const conversationRow = {
  id: 'conv-1',
  zone_id: 'z1',
  title: 'Connect GitHub',
  status: 'active',
  created_by: 'actor-1',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  last_activity_at: '2026-01-01T00:00:00Z',
  archived_at: null,
}

describe('operator enablement gating', () => {
  it('reports enabled status and serves functional routes when enabled', async () => {
    const { app } = buildApp(true)
    await app.ready()
    const status = await app.inject({ method: 'GET', url: '/v1/operator/status' })
    expect(status.statusCode).toBe(200)
    const body = JSON.parse(status.body)
    expect(body).toMatchObject({ enabled: true, principal: 'system:caracal-operator' })
    // The least-privilege grant exposes only executable mutating capabilities by default.
    expect(body.allowed_capabilities).toEqual(['createZone', 'grantAccess', 'registerApplication', 'rotateApplicationSecret'])
    const caps = await app.inject({ method: 'GET', url: '/v1/operator/capabilities' })
    expect(caps.statusCode).toBe(200)
  })

  it('always serves a disabled status but registers no functional routes when disabled', async () => {
    const { app, db } = buildApp(false)
    await app.ready()
    const status = await app.inject({ method: 'GET', url: '/v1/operator/status' })
    expect(status.statusCode).toBe(200)
    expect(JSON.parse(status.body)).toEqual({ enabled: false })

    const caps = await app.inject({ method: 'GET', url: '/v1/operator/capabilities' })
    expect(caps.statusCode).toBe(404)
    const list = await app.inject({ method: 'GET', url: '/v1/zones/z1/operator-conversations' })
    expect(list.statusCode).toBe(404)
    // A disabled Operator touches no state.
    expect(db.query).not.toHaveBeenCalled()
  })
})

describe('POST /v1/zones/:zoneId/operator-conversations', () => {
  it('returns 404 when the zone does not exist', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [] })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations',
      payload: { title: 'Connect GitHub' },
    })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'zone_not_found' })
  })

  it('creates a conversation owned by the calling actor', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    db.query.mockResolvedValueOnce({ rows: [conversationRow] })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations',
      payload: { title: 'Connect GitHub' },
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'conv-1', status: 'active', created_by: 'actor-1' })
    const insert = db.query.mock.calls[1]
    expect(insert[0]).toContain('INSERT INTO operator_conversations')
    expect(insert[1]).toEqual([expect.any(String), 'z1', 'Connect GitHub', 'actor-1'])
  })

  it('rejects an empty title', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations',
      payload: { title: '' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_conversation' })
  })
})

describe('GET /v1/zones/:zoneId/operator-conversations', () => {
  it('lists active conversations for the zone', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [conversationRow] })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/operator-conversations' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toHaveLength(1)
    expect(db.query.mock.calls[0][0]).toContain('archived_at IS NULL')
  })

  it('filters by an escaped search term when q is given', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [conversationRow] })
    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones/z1/operator-conversations?q=' + encodeURIComponent('50%_off'),
    })
    expect(res.statusCode).toBe(200)
    const [sql, values] = db.query.mock.calls[0]
    expect(sql).toContain('title ILIKE')
    expect(sql).toContain("ESCAPE '\\'")
    // LIKE metacharacters in the term are neutralized so they match literally.
    expect(values).toContain('50\\%\\_off')
  })

  it('rejects an over-long search term', async () => {
    const { app } = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones/z1/operator-conversations?q=' + 'x'.repeat(201),
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_query' })
  })

  it('lists archived conversations when status=archived', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ ...conversationRow, status: 'archived' }] })
    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones/z1/operator-conversations?status=archived',
    })
    expect(res.statusCode).toBe(200)
    expect(db.query.mock.calls[0][0]).toContain('archived_at IS NOT NULL')
  })

  it('lists every conversation when status=all', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [conversationRow] })
    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones/z1/operator-conversations?status=all',
    })
    expect(res.statusCode).toBe(200)
    const sql = db.query.mock.calls[0][0]
    expect(sql).not.toContain('archived_at IS NULL')
    expect(sql).not.toContain('archived_at IS NOT NULL')
  })

  it('rejects an unknown status', async () => {
    const { app } = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones/z1/operator-conversations?status=bogus',
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_query' })
  })
})

describe('GET /v1/zones/:zoneId/operator-conversations/:id', () => {
  it('returns 404 when the conversation is absent', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [] })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/operator-conversations/conv-x' })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'conversation_not_found' })
  })
})

describe('PATCH /v1/zones/:zoneId/operator-conversations/:id', () => {
  it('rejects an empty patch', async () => {
    const { app } = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1/operator-conversations/conv-1',
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'no_fields' })
  })

  it('archives a conversation', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ ...conversationRow, status: 'archived', archived_at: '2026-01-02T00:00:00Z' }] })
    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1/operator-conversations/conv-1',
      payload: { status: 'archived' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ status: 'archived' })
    expect(db.query.mock.calls[0][1]).toEqual(['conv-1', 'z1', null, 'archived'])
  })
})

describe('DELETE /v1/zones/:zoneId/operator-conversations/:id', () => {
  it('removes the conversation and its turns', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rowCount: 1, rows: [] })
    await app.ready()
    const res = await app.inject({ method: 'DELETE', url: '/v1/zones/z1/operator-conversations/conv-1' })
    expect(res.statusCode).toBe(204)
    const [sql, values] = db.query.mock.calls[0]
    expect(sql).toContain('DELETE FROM operator_conversations')
    expect(values).toEqual(['conv-1', 'z1'])
  })

  it('returns 404 when the conversation is absent', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] })
    await app.ready()
    const res = await app.inject({ method: 'DELETE', url: '/v1/zones/z1/operator-conversations/conv-x' })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'conversation_not_found' })
  })
})

describe('POST /v1/zones/:zoneId/operator-conversations/:id/turns', () => {
  const turnRow = {
    id: 'turn-1',
    conversation_id: 'conv-1',
    seq: 1,
    role: 'user',
    kind: 'message',
    content: { text: 'Connect GitHub' },
    actor_id: 'actor-1',
    created_at: '2026-01-01T00:00:01Z',
  }

  it('appends a turn with an allocated sequence', async () => {
    const { app, clientQuery } = buildApp()
    clientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ next_seq: 1, status: 'active' }] }) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE next_seq
      .mockResolvedValueOnce({ rows: [turnRow] }) // INSERT turn
      .mockResolvedValueOnce(undefined) // COMMIT
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/turns',
      payload: { role: 'user', kind: 'message', content: { text: 'Connect GitHub' } },
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'turn-1', seq: 1, kind: 'message' })
    const insert = clientQuery.mock.calls[3]
    expect(insert[0]).toContain('INSERT INTO operator_turns')
    expect(insert[1][3]).toBe(1) // seq
    expect(insert[1][6]).toBe(JSON.stringify({ text: 'Connect GitHub' })) // content serialized to jsonb
  })

  it('is idempotent for a repeated client_token', async () => {
    const { app, clientQuery } = buildApp()
    clientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ next_seq: 2, status: 'active' }] }) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce({ rows: [turnRow] }) // SELECT existing by client_token
      .mockResolvedValueOnce(undefined) // COMMIT
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/turns',
      payload: { role: 'user', kind: 'message', content: { text: 'Connect GitHub' }, client_token: 'tok-1' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'turn-1' })
    // No INSERT issued on the idempotent replay.
    expect(clientQuery.mock.calls.some((c) => String(c[0]).includes('INSERT INTO operator_turns'))).toBe(false)
  })

  it('returns 409 when the conversation is archived', async () => {
    const { app, clientQuery } = buildApp()
    clientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ next_seq: 1, status: 'archived' }] }) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce(undefined) // ROLLBACK
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/turns',
      payload: { role: 'user', kind: 'message', content: { text: 'hi' } },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'conversation_archived' })
  })

  it('returns 404 when the conversation is absent', async () => {
    const { app, clientQuery } = buildApp()
    clientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce(undefined) // ROLLBACK
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-x/turns',
      payload: { role: 'user', kind: 'message', content: { text: 'hi' } },
    })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'conversation_not_found' })
  })

  it('rejects an unknown turn kind', async () => {
    const { app } = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/turns',
      payload: { role: 'user', kind: 'shout', content: { text: 'hi' } },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_turn' })
  })

  it('rejects content that does not match the turn kind', async () => {
    const { app } = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/turns',
      payload: { role: 'user', kind: 'message', content: { wrong: true } },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_turn_content' })
  })

  it('refuses governed kinds on the narrative append endpoint', async () => {
    const { app } = buildApp()
    await app.ready()
    for (const kind of ['plan', 'approval', 'rejection', 'execution']) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/zones/z1/operator-conversations/conv-1/turns',
        payload: { role: 'operator', kind, content: {} },
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_turn' })
    }
  })
})

describe('GET /v1/zones/:zoneId/operator-conversations/:id/turns', () => {
  it('returns turns in ascending sequence order', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'turn-1',
          conversation_id: 'conv-1',
          seq: 1,
          role: 'user',
          kind: 'message',
          content: {},
          actor_id: 'actor-1',
          created_at: '2026-01-01T00:00:01Z',
        },
      ],
    })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/operator-conversations/conv-1/turns' })
    expect(res.statusCode).toBe(200)
    expect(db.query.mock.calls[0][0]).toContain('ORDER BY seq ASC')
    expect(db.query.mock.calls[0][1]).toEqual(['conv-1', 'z1', 0, 200])
  })

  it('rejects an invalid after_seq', async () => {
    const { app } = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones/z1/operator-conversations/conv-1/turns?after_seq=-1',
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_query' })
  })
})

describe('GET /v1/operator/capabilities', () => {
  it('returns the catalog descriptors', async () => {
    const { app } = buildApp()
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/operator/capabilities' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(Array.isArray(body.capabilities)).toBe(true)
    expect(body.capabilities.length).toBeGreaterThan(0)
    expect(body.capabilities[0]).toHaveProperty('mutating')
    expect(body.capabilities[0]).not.toHaveProperty('args')
  })
})

describe('POST /v1/zones/:zoneId/operator-conversations/:id/plan/validate', () => {
  it('returns 404 when the conversation is absent', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [] })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-x/plan/validate',
      payload: { summary: 'x', steps: [{ id: 's1', capability: 'listZones', args: {} }] },
    })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'conversation_not_found' })
  })

  it('rejects a structurally invalid plan', async () => {
    const { app } = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/validate',
      payload: { summary: 'x', steps: [] },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_plan' })
  })

  it('validates a plan against the catalog without persisting anything', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ status: 'active' }] })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/validate',
      payload: {
        summary: 'Connect GitHub and grant read',
        steps: [
          { id: 's1', capability: 'connectProvider', args: { name: 'GitHub', kind: 'oauth2_authorization_code' } },
          { id: 's2', capability: 'badCap', args: {} },
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(false)
    expect(body.mutating).toBe(true)
    expect(body.steps.map((s: { id: string }) => s.id)).toEqual(['s1'])
    expect(body.diagnostics).toEqual([{ step_id: 's2', code: 'unknown_capability', message: expect.any(String) }])
  })
})

describe('POST /v1/zones/:zoneId/operator-conversations/:id/plan/preview', () => {
  it('returns 404 when the conversation is absent', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [] })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-x/plan/preview',
      payload: { summary: 'x', steps: [{ id: 's1', capability: 'listZones', args: {} }] },
    })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'conversation_not_found' })
  })

  it('previews effects against live state without persisting', async () => {
    const { app, db } = buildApp()
    db.query
      .mockResolvedValueOnce({ rows: [{ status: 'active' }] }) // conversation exists
      .mockResolvedValueOnce({ rows: [] }) // provider name free
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/preview',
      payload: {
        summary: 'Connect GitHub',
        steps: [{ id: 's1', capability: 'connectProvider', args: { name: 'GitHub', kind: 'oauth2_authorization_code' } }],
      },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.steps[0]).toMatchObject({ id: 's1', effect: 'create' })
    // Only the existence check and a single read-only lookup ran; no INSERT/UPDATE.
    expect(db.connect).not.toHaveBeenCalled()
    expect(db.query).toHaveBeenCalledTimes(2)
  })
})

describe('POST /v1/zones/:zoneId/operator-conversations/:id/plan', () => {
  const goodPlan = {
    summary: 'Connect GitHub',
    steps: [{ id: 's1', capability: 'connectProvider', args: { name: 'GitHub', kind: 'oauth2_authorization_code' } }],
  }

  it('rejects a plan that fails catalog validation and persists nothing', async () => {
    const { app, db } = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan',
      payload: { summary: 'bad', steps: [{ id: 's1', capability: 'nope', args: {} }] },
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body)
    expect(body.error).toBe('plan_validation_failed')
    expect(body.validation.diagnostics[0]).toMatchObject({ code: 'unknown_capability' })
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('persists a catalog-normalized plan turn', async () => {
    const { app, clientQuery } = buildApp()
    const planRow = {
      id: 'turn-2',
      conversation_id: 'conv-1',
      seq: 2,
      role: 'operator',
      kind: 'plan',
      content: {
        summary: 'Connect GitHub',
        steps: [{ id: 's1', capability: 'connectProvider', summary: 'Connect a provider', mutating: true }],
      },
      actor_id: 'actor-1',
      created_at: '2026-01-01T00:00:02Z',
    }
    clientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 2 }] }) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE next_seq
      .mockResolvedValueOnce({ rows: [planRow] }) // INSERT turn
      .mockResolvedValueOnce(undefined) // COMMIT
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan',
      payload: goodPlan,
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.turn).toMatchObject({ kind: 'plan', seq: 2 })
    expect(body.validation).toMatchObject({ ok: true, mutating: true })
    // The persisted content carries the resolved title and authoritative mutating flag.
    const insert = clientQuery.mock.calls[3]
    const persisted = JSON.parse(insert[1][6])
    expect(persisted.steps[0]).toMatchObject({ id: 's1', capability: 'connectProvider', mutating: true })
  })

  it('returns 404 when the conversation is absent', async () => {
    const { app, clientQuery } = buildApp()
    clientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce(undefined) // ROLLBACK
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-x/plan',
      payload: goodPlan,
    })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'conversation_not_found' })
  })
})

describe('POST /v1/zones/:zoneId/operator-conversations/:id/plan/decision', () => {
  it('records an approval that references a real, undecided plan', async () => {
    const { app, clientQuery } = buildApp()
    const approvalRow = {
      id: 'turn-3',
      conversation_id: 'conv-1',
      seq: 3,
      role: 'user',
      kind: 'approval',
      content: { plan_seq: 2 },
      actor_id: 'actor-1',
      created_at: '2026-01-01T00:00:03Z',
    }
    clientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 3 }] }) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // plan turn exists
      .mockResolvedValueOnce({ rows: [] }) // not already decided
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE next_seq
      .mockResolvedValueOnce({ rows: [approvalRow] }) // INSERT turn
      .mockResolvedValueOnce(undefined) // COMMIT
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/decision',
      payload: { plan_seq: 2, decision: 'approved' },
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ kind: 'approval', content: { plan_seq: 2 } })
  })

  it('rejects a decision for a plan_seq that is not a plan turn', async () => {
    const { app, clientQuery } = buildApp()
    clientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 3 }] }) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce({ rows: [] }) // plan turn missing
      .mockResolvedValueOnce(undefined) // ROLLBACK
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/decision',
      payload: { plan_seq: 9, decision: 'approved' },
    })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'plan_not_found' })
  })

  it('refuses a second decision on an already-decided plan', async () => {
    const { app, clientQuery } = buildApp()
    clientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 4 }] }) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // plan turn exists
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // already decided
      .mockResolvedValueOnce(undefined) // ROLLBACK
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/decision',
      payload: { plan_seq: 2, decision: 'rejected', reason: 'too broad' },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'plan_already_decided' })
  })

  it('rejects an invalid decision body', async () => {
    const { app } = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/decision',
      payload: { plan_seq: 2, decision: 'maybe' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_decision' })
  })
})

describe('POST /v1/zones/:zoneId/operator-conversations/:id/plan/execute', () => {
  const planContent = {
    summary: 'Stand up production',
    steps: [{ id: 's1', capability: 'createZone', summary: 'Create a zone', mutating: true, args: { name: 'Prod' } }],
  }

  it('rejects an invalid body', async () => {
    const { app } = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/execute',
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_execute' })
  })

  it('refuses to execute a plan that was never approved', async () => {
    const { app, clientQuery } = buildApp()
    clientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 5 }] }) // conv FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ content: planContent }] }) // plan content
      .mockResolvedValueOnce({ rows: [] }) // no decision
      .mockResolvedValueOnce(undefined) // ROLLBACK
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/execute',
      payload: { plan_seq: 2 },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'plan_not_approved' })
  })

  it('refuses to execute an already-executed plan', async () => {
    const { app, clientQuery } = buildApp()
    clientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 6 }] }) // conv
      .mockResolvedValueOnce({ rows: [{ content: planContent }] }) // plan
      .mockResolvedValueOnce({ rows: [{ kind: 'approval' }] }) // decision approved
      .mockResolvedValueOnce({ rows: [{ one: 1 }] }) // execution already exists
      .mockResolvedValueOnce(undefined) // ROLLBACK
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/execute',
      payload: { plan_seq: 2 },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'plan_already_executed' })
  })

  it('refuses an approved plan the Operator is not authorized to execute', async () => {
    const { app, clientQuery } = buildApp()
    const grantPlan = {
      summary: 'Connect',
      steps: [
        {
          id: 's1',
          capability: 'connectProvider',
          summary: 'Connect a provider',
          mutating: true,
          args: { name: 'GitHub', kind: 'oauth2_authorization_code' },
        },
      ],
    }
    clientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 5 }] }) // conv
      .mockResolvedValueOnce({ rows: [{ content: grantPlan }] }) // plan
      .mockResolvedValueOnce({ rows: [{ kind: 'approval' }] }) // approved
      .mockResolvedValueOnce({ rows: [] }) // not executed
      .mockResolvedValueOnce(undefined) // ROLLBACK
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/execute',
      payload: { plan_seq: 2 },
    })
    // Authority is the primary boundary: connectProvider is outside the least-privilege
    // grant, so it is forbidden before executability is even considered.
    expect(res.statusCode).toBe(403)
    const body = JSON.parse(res.body)
    expect(body.error).toBe('capability_forbidden')
    expect(body.principal).toBe('system:caracal-operator')
    expect(body.steps[0]).toMatchObject({ step_id: 's1', capability: 'connectProvider', code: 'capability_forbidden' })
  })

  it('executes an approved createZone plan and records an execution turn', async () => {
    const { app, clientQuery } = buildApp()
    const executionTurn = {
      id: 'turn-x',
      conversation_id: 'conv-1',
      seq: 5,
      role: 'operator',
      kind: 'execution',
      content: { plan_seq: 2, step_id: 's1', status: 'succeeded', detail: 'Created zone “Prod”.' },
      actor_id: 'actor-1',
      created_at: '2026-01-01T00:00:05Z',
    }
    clientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 5 }] }) // conv FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ content: planContent }] }) // plan content
      .mockResolvedValueOnce({ rows: [{ kind: 'approval' }] }) // approved
      .mockResolvedValueOnce({ rows: [] }) // not executed
      .mockResolvedValueOnce({ rows: [] }) // preview: zone name free
      .mockResolvedValueOnce({ rows: [] }) // createZoneRecord slug free
      .mockResolvedValueOnce({ rows: [{ id: 'z-new', name: 'Prod', slug: 'prod' }] }) // INSERT zone
      .mockResolvedValueOnce({ rowCount: 1 }) // writeTurnLocked UPDATE next_seq
      .mockResolvedValueOnce({ rows: [executionTurn] }) // INSERT execution turn
      .mockResolvedValueOnce({ rows: [] }) // admin audit: advisory lock
      .mockResolvedValueOnce({ rows: [] }) // admin audit: chain head
      .mockResolvedValueOnce({ rows: [] }) // admin audit: INSERT admin_audit_events
      .mockResolvedValueOnce(undefined) // COMMIT
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/execute',
      payload: { plan_seq: 2 },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body).toMatchObject({ ok: true, plan_seq: 2, executed_by: 'system:caracal-operator' })
    expect(body.executed).toHaveLength(1)
    expect(body.executed[0]).toMatchObject({ kind: 'execution' })
    // The persisted execution turn detail is the ledger-safe summary and records the
    // reserved Operator principal that applied the change.
    const insertExec = clientQuery.mock.calls[9]
    expect(insertExec[1][6]).toContain('succeeded')
    expect(insertExec[1][6]).toContain('system:caracal-operator')
    // The change is also recorded in Caracal's own admin audit log, per entity, through
    // the same primitive every manual mutation uses: the new zone is the entity, the
    // human is the authorizing actor, and the Operator principal is carried in the payload.
    const auditInsert = clientQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO admin_audit_events'))
    expect(auditInsert).toBeDefined()
    const auditParams = auditInsert![1] as unknown[]
    expect(auditParams[2]).toBe('actor-1') // actor_id: the human approver
    expect(auditParams[5]).toBe('operator.execute:createZone') // action
    expect(auditParams[9]).toBe('zones') // entity_type
    expect(auditParams[10]).toBe('z-new') // entity_id: the created zone
    expect(JSON.stringify(auditParams[12])).toContain('system:caracal-operator') // payload executed_by
  })

  it('refuses to execute a create plan whose target already exists, applying nothing', async () => {
    const { app, clientQuery } = buildApp()
    clientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 5 }] }) // conv FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ content: planContent }] }) // plan content
      .mockResolvedValueOnce({ rows: [{ kind: 'approval' }] }) // approved
      .mockResolvedValueOnce({ rows: [] }) // not executed
      .mockResolvedValueOnce({ rows: [{ one: 1 }] }) // preview: zone name now TAKEN -> exists
      .mockResolvedValueOnce(undefined) // ROLLBACK
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/execute',
      payload: { plan_seq: 2 },
    })
    expect(res.statusCode).toBe(409)
    const body = JSON.parse(res.body)
    expect(body.error).toBe('plan_already_satisfied')
    expect(body.steps[0]).toMatchObject({ step_id: 's1', capability: 'createZone' })
    // Nothing was written: the only statements were the lookups, the preview, and the rollback.
    const wroteZone = clientQuery.mock.calls.some((c) => String(c[0]).includes('INSERT INTO zones'))
    expect(wroteZone).toBe(false)
  })

  it('rolls back and records an error turn when a step fails', async () => {
    const { app, clientQuery } = buildApp()
    const errorTurn = {
      id: 'turn-e',
      conversation_id: 'conv-1',
      seq: 5,
      role: 'system',
      kind: 'error',
      content: { message: 'Step s1 (createZone) failed: insert exploded' },
      actor_id: 'actor-1',
      created_at: '2026-01-01T00:00:05Z',
    }
    clientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 5 }] }) // conv
      .mockResolvedValueOnce({ rows: [{ content: planContent }] }) // plan
      .mockResolvedValueOnce({ rows: [{ kind: 'approval' }] }) // approved
      .mockResolvedValueOnce({ rows: [] }) // not executed
      .mockResolvedValueOnce({ rows: [] }) // preview: zone name free
      .mockResolvedValueOnce({ rows: [] }) // createZoneRecord slug free
      .mockRejectedValueOnce(new Error('insert exploded')) // INSERT zone throws
      .mockResolvedValueOnce(undefined) // ROLLBACK (tx1)
      // second transaction records the error turn
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 5 }] }) // conv FOR UPDATE
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE next_seq
      .mockResolvedValueOnce({ rows: [errorTurn] }) // INSERT error turn
      .mockResolvedValueOnce(undefined) // COMMIT
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/execute',
      payload: { plan_seq: 2 },
    })
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'execution_failed', step_id: 's1' })
    // An error turn was written describing the failed step.
    const insertError = clientQuery.mock.calls.find(
      (c) => String(c[0]).includes('INSERT INTO operator_turns') && String(c[1]?.[5]) === 'error',
    )
    expect(insertError).toBeDefined()
  })
})

describe('GET /v1/zones/:zoneId/operator-conversations/:id/context', () => {
  it('returns 404 when the conversation is absent', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [] })
    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones/z1/operator-conversations/conv-x/context',
    })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'conversation_not_found' })
  })

  it('derives working memory: pending plan, recent message, no error', async () => {
    const { app, db } = buildApp()
    db.query
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 4 }] }) // conversation
      .mockResolvedValueOnce({ rows: [{ seq: 2 }] }) // latest plan seq
      .mockResolvedValueOnce({
        rows: [
          {
            seq: 2,
            role: 'operator',
            kind: 'plan',
            content: {
              summary: 'Connect GitHub',
              steps: [{ id: 's1', capability: 'connectProvider', summary: 'Bind GitHub', mutating: true }],
            },
          },
        ],
      }) // plan slice
      .mockResolvedValueOnce({ rows: [] }) // error rows
      .mockResolvedValueOnce({
        rows: [{ seq: 1, role: 'user', kind: 'message', content: { text: 'Connect GitHub' } }],
      }) // message rows
      .mockResolvedValueOnce({ rows: [] }) // facts: decision-turn history
    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones/z1/operator-conversations/conv-1/context',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body).toMatchObject({
      conversation_id: 'conv-1',
      status: 'active',
      turn_count: 3,
      pending_approval: true,
      last_error: null,
    })
    expect(body.facts).toMatchObject({ decided_plans: [], rejected_capabilities: [], applied_change_count: 0 })
    expect(body.latest_plan).toMatchObject({ seq: 2, decision: 'pending', summary: 'Connect GitHub' })
    expect(body.latest_plan.progress).toMatchObject({ total: 1, pending: 1, succeeded: 0, failed: 0 })
    expect(body.recent_messages).toEqual([{ seq: 1, role: 'user', text: 'Connect GitHub' }])
  })

  it('reflects approval and execution progress in the derived plan', async () => {
    const { app, db } = buildApp()
    db.query
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 6 }] }) // conversation
      .mockResolvedValueOnce({ rows: [{ seq: 2 }] }) // latest plan seq
      .mockResolvedValueOnce({
        rows: [
          {
            seq: 2,
            role: 'operator',
            kind: 'plan',
            content: {
              summary: 'Connect GitHub',
              steps: [{ id: 's1', capability: 'connectProvider', summary: 'Bind GitHub', mutating: true }],
            },
          },
          { seq: 3, role: 'user', kind: 'approval', content: { plan_seq: 2 } },
          { seq: 4, role: 'operator', kind: 'execution', content: { plan_seq: 2, step_id: 's1', status: 'succeeded' } },
        ],
      }) // plan slice
      .mockResolvedValueOnce({ rows: [] }) // error rows
      .mockResolvedValueOnce({ rows: [] }) // message rows
      .mockResolvedValueOnce({
        rows: [
          {
            seq: 2,
            role: 'operator',
            kind: 'plan',
            content: { summary: 'Connect GitHub', steps: [{ id: 's1', capability: 'connectProvider' }] },
          },
          { seq: 3, role: 'user', kind: 'approval', content: { plan_seq: 2 } },
          { seq: 4, role: 'operator', kind: 'execution', content: { plan_seq: 2, step_id: 's1', status: 'succeeded' } },
        ],
      }) // facts: decision-turn history
    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones/z1/operator-conversations/conv-1/context',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.pending_approval).toBe(false)
    expect(body.latest_plan).toMatchObject({ decision: 'approved', decision_seq: 3 })
    expect(body.latest_plan.progress).toMatchObject({ total: 1, succeeded: 1, pending: 0 })
    expect(body.latest_plan.steps[0]).toMatchObject({ id: 's1', status: 'succeeded' })
    // The decided, executed plan is compressed into the session facts.
    expect(body.facts.decided_plans[0]).toMatchObject({ seq: 2, decision: 'approved', executed: true, steps_succeeded: 1 })
    expect(body.facts.applied_change_count).toBe(1)
  })
})

describe('operator authority and zone isolation', () => {
  it('refuses to open a session in a system zone', async () => {
    const { app, db } = buildApp(true, { systemZones: ['z1'] })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations',
      payload: { title: 'should be blocked' },
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'zone_forbidden' })
    // Isolation is enforced before any state access.
    expect(db.query).not.toHaveBeenCalled()
  })

  it('refuses to execute in a system zone before any work', async () => {
    const { app, db } = buildApp(true, { systemZones: ['z1'] })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/execute',
      payload: { plan_seq: 2 },
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'zone_forbidden' })
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('exposes a widened grant when configured', async () => {
    const { app } = buildApp(true, { allowedCapabilities: ['createZone'] })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/operator/status' })
    expect(JSON.parse(res.body).allowed_capabilities).toEqual(['createZone'])
  })
})

describe('operator AI gateway routes', () => {
  function chatResponse(content: string) {
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const provider = {
    id: 'primary',
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-x',
    apiKey: 'sk-secret',
    timeoutMs: 1000,
    contextWindow: 0,
  }

  it('reports a disabled AI tier with no providers', async () => {
    const { app } = buildApp(true)
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/operator/ai/status' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ enabled: false, providers: [] })
  })

  it('reports configured providers without leaking keys', async () => {
    const { app } = buildApp(true, { aiProviders: [provider] })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/operator/ai/status' })
    const body = JSON.parse(res.body)
    expect(body.enabled).toBe(true)
    expect(body.providers).toEqual([{ id: 'primary', model: 'gpt-x', available: true, contextWindow: 0 }])
    expect(res.body).not.toContain('sk-secret')
  })

  it('returns 409 ai_unavailable when checking with no provider', async () => {
    const { app } = buildApp(true)
    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/operator/ai/check' })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'ai_unavailable' })
  })

  it('checks connectivity with a real completion through the gateway', async () => {
    const fetchImpl = vi.fn(async () => chatResponse('OK')) as unknown as typeof fetch
    const { app } = buildApp(true, { aiProviders: [provider], fetchImpl })
    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/operator/ai/check' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body).toMatchObject({ ok: true, provider: 'primary', model: 'gpt-x' })
    expect(typeof body.latency_ms).toBe('number')
  })

  it('returns 502 ai_unreachable when every provider fails', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    const { app } = buildApp(true, { aiProviders: [provider], fetchImpl })
    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/operator/ai/check' })
    expect(res.statusCode).toBe(502)
    const body = JSON.parse(res.body)
    expect(body.error).toBe('ai_unreachable')
    expect(body.attempts[0]).toMatchObject({ provider: 'primary' })
    expect(res.body).not.toContain('sk-secret')
  })

  it('does not register AI routes when the operator is disabled', async () => {
    const { app } = buildApp(false, { aiProviders: [provider] })
    await app.ready()
    const status = await app.inject({ method: 'GET', url: '/v1/operator/ai/status' })
    expect(status.statusCode).toBe(404)
  })
})

describe('POST /v1/zones/:zoneId/operator-conversations/:id/message', () => {
  const provider = { id: 'primary', baseUrl: 'https://api.example.com/v1', model: 'gpt-x', apiKey: 'sk', timeoutMs: 1000, contextWindow: 0 }

  // A fetch that returns the given assistant message contents in sequence, so the
  // agents' model calls are scripted without a live backend.
  function fetchReturning(...contents: string[]) {
    const fn = vi.fn()
    for (const content of contents) {
      fn.mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    return fn as unknown as typeof fetch
  }

  it('rejects an empty message', async () => {
    const { app } = buildApp(true, { aiProviders: [provider], fetchImpl: fetchReturning() })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/message',
      payload: { message: '   ' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_message' })
  })

  it('returns 409 ai_unavailable when no provider is configured', async () => {
    const { app } = buildApp(true)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/message',
      payload: { message: 'connect github' },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'ai_unavailable' })
  })

  it('refuses a message in a system zone', async () => {
    const { app } = buildApp(true, { aiProviders: [provider], systemZones: ['z1'] })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/message',
      payload: { message: 'connect github' },
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'zone_forbidden' })
  })

  it('turns a natural-language request into a validated, previewed plan', async () => {
    const plan = {
      summary: 'Connect GitHub',
      steps: [{ id: 's1', capability: 'connectProvider', args: { name: 'GitHub', kind: 'oauth2_authorization_code' } }],
    }
    const fetchImpl = fetchReturning('{"intent":"plan"}', JSON.stringify(plan))
    const { app, clientQuery, db } = buildApp(true, { aiProviders: [provider], fetchImpl })
    // user message turn (BEGIN, FOR UPDATE, UPDATE seq, INSERT, COMMIT)
    clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 1 }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'turn-1', seq: 1, kind: 'message' }] })
      .mockResolvedValueOnce(undefined)
    // loadConversationState reads (plan seq, errors, messages) on fastify.db
    db.query
      .mockResolvedValueOnce({ rows: [] }) // latest plan seq
      .mockResolvedValueOnce({ rows: [] }) // error rows
      .mockResolvedValueOnce({ rows: [{ seq: 1, role: 'user', kind: 'message', content: { text: 'connect github' } }] }) // messages
      .mockResolvedValueOnce({ rows: [] }) // facts: decision-turn history
      .mockResolvedValueOnce({ rows: [] }) // previewPlan: provider name free
    // plan turn persist (BEGIN, FOR UPDATE, UPDATE seq, INSERT, COMMIT)
    clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 2 }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'turn-2', seq: 2, kind: 'plan' }] })
      .mockResolvedValueOnce(undefined)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/message',
      payload: { message: 'connect github' },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body).toMatchObject({ intent: 'plan', ok: true })
    expect(body.turn).toMatchObject({ kind: 'plan' })
    expect(body.validation.ok).toBe(true)
    expect(body.preview.steps[0]).toMatchObject({ effect: 'create' })
  })

  it('records an error turn when the model cannot produce a usable plan', async () => {
    const fetchImpl = fetchReturning('{"intent":"plan"}', 'I cannot help with that.')
    const { app, clientQuery, db } = buildApp(true, { aiProviders: [provider], fetchImpl })
    clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 1 }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'turn-1', seq: 1 }] })
      .mockResolvedValueOnce(undefined)
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    // error turn persist
    clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 2 }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'turn-2', seq: 2, kind: 'error' }] })
      .mockResolvedValueOnce(undefined)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/message',
      payload: { message: 'do something impossible' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body).toMatchObject({ intent: 'plan', ok: false, error: 'no_plan' })
  })

  it('answers an explain intent with a note turn', async () => {
    const fetchImpl = fetchReturning('{"intent":"explain"}', 'The request was denied because the scope is missing.')
    const { app, clientQuery, db } = buildApp(true, { aiProviders: [provider], fetchImpl })
    clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 1 }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'turn-1', seq: 1 }] })
      .mockResolvedValueOnce(undefined)
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 2 }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'turn-2', seq: 2, kind: 'note' }] })
      .mockResolvedValueOnce(undefined)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/message',
      payload: { message: 'why was my agent denied' },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body).toMatchObject({ intent: 'explain', ok: true })
    expect(body.text).toContain('scope is missing')
  })

  it('reports real token usage, model, and context window with the answer', async () => {
    const usageProvider = { ...provider, contextWindow: 128000 }
    function fetchWithUsage(...turns: { content: string; prompt: number; completion: number }[]) {
      const fn = vi.fn()
      for (const turn of turns) {
        fn.mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: turn.content } }],
              usage: { prompt_tokens: turn.prompt, completion_tokens: turn.completion },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        )
      }
      return fn as unknown as typeof fetch
    }
    const fetchImpl = fetchWithUsage(
      { content: '{"intent":"explain"}', prompt: 120, completion: 4 },
      { content: 'Because the scope was missing.', prompt: 400, completion: 60 },
    )
    const { app, clientQuery, db } = buildApp(true, { aiProviders: [usageProvider], fetchImpl })
    clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 1 }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'turn-1', seq: 1 }] })
      .mockResolvedValueOnce(undefined)
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 2 }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'turn-2', seq: 2, kind: 'note' }] })
      .mockResolvedValueOnce(undefined)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/message',
      payload: { message: 'why was my agent denied' },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.model).toBe('gpt-x')
    expect(body.max_tokens).toBe(128000)
    expect(body.usage).toEqual({ input_tokens: 520, output_tokens: 64, total_tokens: 584 })
  })

  it('rejects a message naming an unknown provider', async () => {
    const { app } = buildApp(true, { aiProviders: [provider] })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/message',
      payload: { message: 'connect github', provider: 'nope' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_provider' })
  })

  it('routes the message to the chosen provider and reports it', async () => {
    const first = { ...provider, id: 'first', model: 'model-a' }
    const second = { ...provider, id: 'second', model: 'model-b', contextWindow: 64000 }
    const fetchImpl = fetchReturning('{"intent":"explain"}', 'Routed through model-b.')
    const { app, clientQuery, db } = buildApp(true, {
      aiProviders: [first, second],
      fetchImpl,
    })
    clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 1 }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'turn-1', seq: 1 }] })
      .mockResolvedValueOnce(undefined)
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 2 }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'turn-2', seq: 2, kind: 'note' }] })
      .mockResolvedValueOnce(undefined)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/message',
      payload: { message: 'why was my agent denied', provider: 'second' },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.provider).toBe('second')
    expect(body.model).toBe('model-b')
    expect(body.max_tokens).toBe(64000)
  })

  it('returns 502 ai_unreachable when the model call fails', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    const { app, clientQuery, db } = buildApp(true, { aiProviders: [provider], fetchImpl })
    clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 1 }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'turn-1', seq: 1 }] })
      .mockResolvedValueOnce(undefined)
    // loadConversationState reads before the agents run.
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/message',
      payload: { message: 'connect github' },
    })
    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'ai_unreachable' })
  })
})
