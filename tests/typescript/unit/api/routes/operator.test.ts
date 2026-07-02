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
import { buildAutopilotPolicy } from '../../../../../apps/api/src/operator-autopilot.js'
import type { OperatorAiManager } from '../../../../../apps/api/src/operator-ai-manager.js'

function buildApp(
  enabled = true,
  authorityOpts: {
    allowedCapabilities?: string[]
    systemZones?: string[]
    aiProviders?: { id: string; baseUrl: string; model: string; apiKey?: string; timeoutMs: number; contextWindow: number }[]
    aiManager?: OperatorAiManager | null
    controlIdentity?: { applicationId: string; clientSecret: string; zoneId: string }
    controlEndpoints?: { stsUrl: string; audience: string; controlUrl: string; controlEnabled: boolean }
    fetchImpl?: typeof fetch
    autopilotPolicy?: ReturnType<typeof buildAutopilotPolicy>
    aiGovernance?: { maxOutputTokens: number; maxCallsPerTurn: number }
  } = {},
) {
  const app = Fastify({ logger: false })
  const clientQuery = vi.fn()
  const release = vi.fn()
  const db = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    connect: vi.fn().mockResolvedValue({ query: clientQuery, release }),
  }
  const redis = {
    incr: vi.fn(),
    expire: vi.fn(),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    eval: vi.fn().mockResolvedValue(1),
  }
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
    loadAiProviders: () => authorityOpts.aiProviders ?? [],
    aiManager: authorityOpts.aiManager ?? null,
    resolveControlIdentity: () => authorityOpts.controlIdentity ?? null,
    controlEndpoints: authorityOpts.controlEndpoints ?? null,
    fetchImpl: authorityOpts.fetchImpl,
    autopilotPolicy: authorityOpts.autopilotPolicy,
    aiGovernance: authorityOpts.aiGovernance,
  })
  return { app, db, clientQuery, redis }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// A control-plane fetch double: answers the STS token mint and the control invoke by URL,
// returning the queued invoke results in order. Drives governed execution without a live
// control plane. invokeError, when set, makes the next invoke fail like a control denial.
function controlFetch(invokeResults: unknown[], invokeError?: { status: number; body: unknown }): ReturnType<typeof vi.fn> {
  let next = 0
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/oauth/2/token')) return jsonResponse({ access_token: 'control-token' })
    if (url.endsWith('/v1/control/invoke')) {
      if (invokeError) return jsonResponse(invokeError.body, invokeError.status)
      return jsonResponse({ result: invokeResults[next++] })
    }
    throw new Error(`unexpected fetch ${url}`)
  })
}

// The internal control identity and endpoints that make governed execution available for
// zone z1: the identity is bound to z1, so the control token executes in z1.
const governedControl = {
  controlIdentity: { applicationId: 'caracal-sys-operator', clientSecret: 'cs_sealed', zoneId: 'z1' },
  controlEndpoints: { stsUrl: 'http://sts.test', audience: 'caracal-control', controlUrl: 'http://api.test', controlEnabled: true },
}

const conversationRow = {
  id: 'conv-1',
  zone_id: 'z1',
  title: 'Connect GitHub',
  status: 'active',
  mode: 'agent',
  autopilot: false,
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
    // The least-privilege grant exposes only governed-executable mutating capabilities by default.
    expect(body.allowed_capabilities).toEqual([
      'activatePolicySet',
      'connectProvider',
      'createPolicy',
      'createPolicySet',
      'defineResource',
      'deleteApplication',
      'deletePolicy',
      'deleteProvider',
      'deleteResource',
      'grantAccess',
      'registerApplication',
      'revokeGrant',
      'rotateApplicationSecret',
      'versionPolicy',
      'versionPolicySet',
    ])
    const caps = await app.inject({ method: 'GET', url: '/v1/operator/capabilities' })
    expect(caps.statusCode).toBe(200)
  })

  it('reports governed execution as unconfigured when no control identity is supplied', async () => {
    const { app } = buildApp(true)
    await app.ready()
    const status = await app.inject({ method: 'GET', url: '/v1/operator/status' })
    expect(JSON.parse(status.body).governed_execution).toEqual({ configured: false })
  })

  it('surfaces the reserved system zone id by slug even when governed execution is unconfigured', async () => {
    const { app, db } = buildApp(true)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'zone-sys-1' }] })
    await app.ready()
    const status = await app.inject({ method: 'GET', url: '/v1/operator/status' })
    const body = JSON.parse(status.body)
    expect(body.system_zone_id).toBe('zone-sys-1')
    expect(body.governed_execution).toEqual({ configured: false })
  })

  it('reports governed execution configured with its zone, never the secret, when a control identity is supplied', async () => {
    const { app } = buildApp(true, {
      controlIdentity: { applicationId: 'caracal-sys-operator', clientSecret: 'cs_sealed', zoneId: 'zone-sys' },
    })
    await app.ready()
    const status = await app.inject({ method: 'GET', url: '/v1/operator/status' })
    expect(JSON.parse(status.body).governed_execution).toEqual({ configured: true, zone_id: 'zone-sys' })
    // The credential must never reach the status surface.
    expect(status.body).not.toContain('cs_sealed')
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
    // The number is drawn from the durable per-zone counter so it is never reused after a delete.
    expect(insert[0]).toContain('operator_conversation_counters')
    expect(insert[1]).toEqual([expect.any(String), 'z1', 'Connect GitHub', 'agent', false, 'actor-1'])
  })

  it('creates a conversation in ask mode when requested', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    db.query.mockResolvedValueOnce({ rows: [{ ...conversationRow, mode: 'ask' }] })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations',
      payload: { title: 'Audit access', mode: 'ask' },
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ mode: 'ask' })
    const insert = db.query.mock.calls[1]
    expect(insert[1]).toEqual([expect.any(String), 'z1', 'Audit access', 'ask', false, 'actor-1'])
  })

  it('creates a conversation with autopilot engaged when requested', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    db.query.mockResolvedValueOnce({ rows: [{ ...conversationRow, autopilot: true }] })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations',
      payload: { title: 'Automate', mode: 'agent', autopilot: true },
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ autopilot: true })
    const insert = db.query.mock.calls[1]
    expect(insert[1]).toEqual([expect.any(String), 'z1', 'Automate', 'agent', true, 'actor-1'])
  })

  it('rejects an unknown mode', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations',
      payload: { title: 'x', mode: 'root' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_conversation' })
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
    expect(db.query.mock.calls[0][1]).toEqual(['conv-1', 'z1', null, 'archived', null, null])
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

  it('refuses to persist a plan in an ask-mode conversation', async () => {
    // Defense in depth: even a directly posted, catalog-valid plan is refused in ask mode, so a
    // plan can never enter an ask conversation's ledger regardless of how it was produced.
    const { app, clientQuery } = buildApp()
    clientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active', mode: 'ask', next_seq: 2 }] }) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce(undefined) // ROLLBACK
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan',
      payload: goodPlan,
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'mode_forbidden' })
    // No INSERT was issued: the refusal happens before the plan turn is written.
    expect(clientQuery.mock.calls.some((c) => String(c[0]).includes('INSERT INTO operator_turns'))).toBe(false)
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

  it('accepts a stringified plan_seq so a JSON bigint seq never silently fails the decision', async () => {
    // operator_turns.seq is a bigint the driver serializes as a string, so the console sends the
    // plan's seq straight back as a string. The decision body coerces it; without that the
    // approval and reject controls fail with a 400 the user never sees.
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
      payload: { plan_seq: '2', decision: 'approved' },
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

  it('refuses a decision in an ask-mode conversation', async () => {
    // An approval is the gate that lets a change apply, so the decision endpoint is refused in
    // ask mode before any plan or decision is even looked up.
    const { app, clientQuery } = buildApp()
    clientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active', mode: 'ask', next_seq: 3 }] }) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce(undefined) // ROLLBACK
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/decision',
      payload: { plan_seq: 2, decision: 'approved' },
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'mode_forbidden' })
    // The plan lookup never runs: the refusal precedes any decision write.
    expect(clientQuery.mock.calls.some((c) => String(c[0]).includes('INSERT INTO operator_turns'))).toBe(false)
  })
})

describe('POST /v1/zones/:zoneId/operator-conversations/:id/plan/execute', () => {
  const grantPlan = {
    summary: 'Grant access',
    steps: [
      {
        id: 's1',
        capability: 'grantAccess',
        mutating: true,
        args: { application_id: 'app-1', user_id: 'user-1', resource_id: 'res-1', scopes: ['invoices.read'] },
      },
    ],
  }

  it('rejects an invalid body', async () => {
    const { app } = buildApp(true, governedControl)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/execute',
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_execute' })
  })

  it('refuses to execute when governed execution is not configured', async () => {
    const { app, db } = buildApp(true)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/execute',
      payload: { plan_seq: 2 },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'governed_execution_unconfigured' })
    // No identity means no governed authority, so the Operator touches no state at all.
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('coerces a stringified plan_seq past body validation so apply never silently 400s', async () => {
    // The console sends the plan's bigint seq back as a string. The execute body coerces it, so a
    // string reaches the governed-execution check (409 here) rather than failing as an invalid body.
    const { app } = buildApp(true)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/execute',
      payload: { plan_seq: '2' },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'governed_execution_unconfigured' })
  })

  it('governs a tenant zone its control identity is not bound to via the zone-scope header', async () => {
    // The Operator governs every zone it operates in. Its control identity is provisioned in the
    // reserved system zone, so a conversation in a tenant zone executes through a control client
    // that stamps the zone-scope header naming that zone, and the control plane applies the
    // mutation there.
    const fetchMock = controlFetch([{ id: 'grant-xyz' }])
    const { app, clientQuery } = buildApp(true, {
      controlIdentity: { applicationId: 'caracal-sys-operator', clientSecret: 'cs_sealed', zoneId: 'zone-sys' },
      controlEndpoints: governedControl.controlEndpoints,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    const executionTurn = {
      id: 'turn-x',
      conversation_id: 'conv-1',
      seq: 5,
      role: 'operator',
      kind: 'execution',
      content: { plan_seq: 2, step_id: 's1', status: 'succeeded' },
      actor_id: 'actor-1',
      created_at: '2026-01-01T00:00:05Z',
    }
    clientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active' }] }) // conv status
      .mockResolvedValueOnce({ rows: [{ content: grantPlan }] }) // plan content
      .mockResolvedValueOnce({ rows: [{ kind: 'approval' }] }) // approved
      .mockResolvedValueOnce({ rows: [] }) // not executed
      .mockResolvedValueOnce({ rows: [{ one: 1 }] }) // preview: application lives
      .mockResolvedValueOnce({ rows: [{ one: 1 }] }) // preview: resource lives
      .mockResolvedValueOnce(undefined) // COMMIT
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 5 }] }) // conv FOR UPDATE
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE next_seq
      .mockResolvedValueOnce({ rows: [executionTurn] }) // INSERT execution turn
      .mockResolvedValueOnce(undefined) // COMMIT
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/execute',
      payload: { plan_seq: 2 },
    })
    expect(res.statusCode).toBe(201)
    // The governed invoke stamps the conversation's zone so the control plane applies the
    // mutation in z1 rather than the Operator's home system zone.
    const invokeCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/v1/control/invoke'))
    expect(invokeCall).toBeDefined()
    expect((invokeCall![1] as RequestInit).headers).toMatchObject({ 'x-caracal-zone-scope': 'z1' })
  })

  it('refuses a concurrent execution of the same plan', async () => {
    const { app, db, redis } = buildApp(true, governedControl)
    redis.set.mockResolvedValueOnce(null) // lock already held
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/execute',
      payload: { plan_seq: 2 },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'plan_already_executed' })
    // The lock guards the work: nothing runs when it is not acquired.
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('refuses to execute a plan that was never approved', async () => {
    const { app, clientQuery } = buildApp(true, governedControl)
    clientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active' }] }) // conv status
      .mockResolvedValueOnce({ rows: [{ content: grantPlan }] }) // plan content
      .mockResolvedValueOnce({ rows: [] }) // no decision
      .mockResolvedValueOnce(undefined) // COMMIT
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/execute',
      payload: { plan_seq: 2 },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'plan_not_approved' })
  })

  it('refuses to execute in an ask-mode conversation', async () => {
    // The apply step is refused in ask mode before the plan or its approval is even resolved, so
    // an ask conversation has no reachable path to apply a change even if one were approved.
    const { app, clientQuery } = buildApp(true, governedControl)
    clientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active', mode: 'ask' }] }) // conv status + mode
      .mockResolvedValueOnce(undefined) // COMMIT
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/execute',
      payload: { plan_seq: 2 },
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'mode_forbidden' })
    // The plan content is never read: the refusal precedes plan resolution and any control call.
    expect(clientQuery.mock.calls.some((c) => String(c[0]).includes('FROM operator_turns'))).toBe(false)
  })

  it('refuses to execute an already-executed plan', async () => {
    const { app, clientQuery } = buildApp(true, governedControl)
    clientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active' }] }) // conv status
      .mockResolvedValueOnce({ rows: [{ content: grantPlan }] }) // plan
      .mockResolvedValueOnce({ rows: [{ kind: 'approval' }] }) // approved
      .mockResolvedValueOnce({ rows: [{ step_id: 's1', status: 'succeeded' }] }) // every step already applied
      .mockResolvedValueOnce(undefined) // COMMIT
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/execute',
      payload: { plan_seq: 2 },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'plan_already_executed' })
  })

  it('refuses to retry a plan that recorded a failed step', async () => {
    // A failed execution turn means a non-idempotent mutation may have half-applied. The plan
    // is never retriable even though an earlier step succeeded, so it is refused before any call.
    const { app, clientQuery } = buildApp(true, governedControl)
    clientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active' }] }) // conv status
      .mockResolvedValueOnce({ rows: [{ content: grantPlan }] }) // plan
      .mockResolvedValueOnce({ rows: [{ kind: 'approval' }] }) // approved
      .mockResolvedValueOnce({
        rows: [
          { step_id: 's1', status: 'succeeded' },
          { step_id: 's2', status: 'failed' },
        ],
      }) // a prior step failed
      .mockResolvedValueOnce(undefined) // COMMIT
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/execute',
      payload: { plan_seq: 2 },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'plan_already_executed' })
  })

  it('resumes a partially-applied plan from its first unapplied step', async () => {
    // A two-step plan whose first step already succeeded and which stopped on a definitive,
    // nothing-applied failure is resumable: re-execute applies only the remaining grant step
    // through the control plane and never re-applies the already-created application.
    const resumePlan = {
      summary: 'Set up billing',
      steps: [
        { id: 's1', capability: 'registerApplication', mutating: true, args: { name: 'Billing' } },
        {
          id: 's2',
          capability: 'grantAccess',
          mutating: true,
          args: { application_id: 'app-1', user_id: 'user-1', resource_id: 'res-1', scopes: ['invoices.read'] },
        },
      ],
    }
    const fetchMock = controlFetch([{ id: 'grant-xyz' }])
    const { app, clientQuery } = buildApp(true, { ...governedControl, fetchImpl: fetchMock as unknown as typeof fetch })
    const executionTurn = {
      id: 'turn-x',
      conversation_id: 'conv-1',
      seq: 7,
      role: 'operator',
      kind: 'execution',
      content: { plan_seq: 2, step_id: 's2', status: 'succeeded' },
      actor_id: 'actor-1',
      created_at: '2026-01-01T00:00:07Z',
    }
    clientQuery
      // pre-flight
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active' }] }) // conv status
      .mockResolvedValueOnce({ rows: [{ content: resumePlan }] }) // plan content
      .mockResolvedValueOnce({ rows: [{ kind: 'approval' }] }) // approved
      .mockResolvedValueOnce({ rows: [{ step_id: 's1', status: 'succeeded' }] }) // s1 already applied
      .mockResolvedValueOnce({ rows: [{ one: 1 }] }) // preview: application lives (s2)
      .mockResolvedValueOnce({ rows: [{ one: 1 }] }) // preview: resource lives (s2)
      .mockResolvedValueOnce(undefined) // COMMIT
      // recording
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 7 }] }) // conv FOR UPDATE
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE next_seq
      .mockResolvedValueOnce({ rows: [executionTurn] }) // INSERT execution turn (s2)
      .mockResolvedValueOnce(undefined) // INSERT operator_zone_memory
      .mockResolvedValueOnce(undefined) // COMMIT
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/execute',
      payload: { plan_seq: 2 },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.executed).toHaveLength(1)
    // Only the remaining grant step reached the control plane; the already-applied application
    // create was never re-invoked.
    const invokeCommands = fetchMock.mock.calls
      .filter((c) => String(c[0]).endsWith('/v1/control/invoke'))
      .map((c) => JSON.parse(String((c[1] as RequestInit).body)).command)
    expect(invokeCommands).toContain('grant')
    expect(invokeCommands).not.toContain('app')
  })

  it('refuses an approved plan the Operator is not authorized to execute', async () => {
    const { app, clientQuery } = buildApp(true, governedControl)
    const forbiddenPlan = {
      summary: 'Create a zone',
      steps: [{ id: 's1', capability: 'createZone', mutating: true, args: { name: 'Hooli Staging' } }],
    }
    clientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active' }] }) // conv status
      .mockResolvedValueOnce({ rows: [{ content: forbiddenPlan }] }) // plan
      .mockResolvedValueOnce({ rows: [{ kind: 'approval' }] }) // approved
      .mockResolvedValueOnce({ rows: [] }) // not executed
      .mockResolvedValueOnce(undefined) // COMMIT
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/execute',
      payload: { plan_seq: 2 },
    })
    // Authority is the primary boundary: createZone is a platform operation outside the
    // least-privilege grant, so it is forbidden before executability is even considered.
    expect(res.statusCode).toBe(403)
    const body = JSON.parse(res.body)
    expect(body.error).toBe('capability_forbidden')
    expect(body.principal).toBe('system:caracal-operator')
    expect(body.steps[0]).toMatchObject({ step_id: 's1', capability: 'createZone', code: 'capability_forbidden' })
  })

  it('refuses an authorized step that maps to no governed control command', async () => {
    const { app, clientQuery } = buildApp(true, governedControl)
    // explainAccess is read-only (always authorized) but has no governed control command,
    // so it is refused as not executable rather than applied by any other means.
    const explainPlan = { summary: 'Explain', steps: [{ id: 's1', capability: 'explainAccess', mutating: false, args: {} }] }
    clientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active' }] }) // conv status
      .mockResolvedValueOnce({ rows: [{ content: explainPlan }] }) // plan
      .mockResolvedValueOnce({ rows: [{ kind: 'approval' }] }) // approved
      .mockResolvedValueOnce({ rows: [] }) // not executed
      .mockResolvedValueOnce(undefined) // COMMIT
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/execute',
      payload: { plan_seq: 2 },
    })
    expect(res.statusCode).toBe(422)
    const body = JSON.parse(res.body)
    expect(body.error).toBe('capability_not_executable')
    expect(body.steps[0]).toMatchObject({ step_id: 's1', capability: 'explainAccess' })
  })

  it('executes an approved grant plan through the control plane and records an execution turn', async () => {
    const fetchMock = controlFetch([{ id: 'grant-xyz' }])
    const { app, clientQuery, redis } = buildApp(true, { ...governedControl, fetchImpl: fetchMock as unknown as typeof fetch })
    const executionTurn = {
      id: 'turn-x',
      conversation_id: 'conv-1',
      seq: 5,
      role: 'operator',
      kind: 'execution',
      content: { plan_seq: 2, step_id: 's1', status: 'succeeded', detail: 'Granted invoices.read to application app-1 on resource res-1.' },
      actor_id: 'actor-1',
      created_at: '2026-01-01T00:00:05Z',
    }
    clientQuery
      // pre-flight (read-only) transaction
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active' }] }) // conv status
      .mockResolvedValueOnce({ rows: [{ content: grantPlan }] }) // plan content
      .mockResolvedValueOnce({ rows: [{ kind: 'approval' }] }) // approved
      .mockResolvedValueOnce({ rows: [] }) // not executed
      .mockResolvedValueOnce({ rows: [{ one: 1 }] }) // preview: application lives
      .mockResolvedValueOnce({ rows: [{ one: 1 }] }) // preview: resource lives
      .mockResolvedValueOnce(undefined) // COMMIT
      // recording transaction
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 5 }] }) // conv FOR UPDATE
      .mockResolvedValueOnce({ rowCount: 1 }) // writeTurnLocked UPDATE next_seq
      .mockResolvedValueOnce({ rows: [executionTurn] }) // INSERT execution turn
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
    // The one-time grant id is returned in the response only, never written to the ledger.
    expect(body.outputs.s1).toEqual({ grant_id: 'grant-xyz' })
    // The persisted execution turn records the reserved Operator principal that applied it.
    const insertExec = clientQuery.mock.calls.find(
      (c) => String(c[0]).includes('INSERT INTO operator_turns') && String(c[1]?.[5]) === 'execution',
    )
    expect(insertExec).toBeDefined()
    expect(String(insertExec![1][6])).toContain('succeeded')
    expect(String(insertExec![1][6])).toContain('system:caracal-operator')
    // The Operator holds no admin token and writes no manual audit: the control plane wrote
    // the tamper-evident audit natively when it applied the mutation.
    const auditInsert = clientQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO admin_audit_events'))
    expect(auditInsert).toBeUndefined()
    // The change flowed through the governed control plane as a least-privilege grant
    // create: the token carries exactly control:grant:write and the invoke is grant create.
    const stsCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/oauth/2/token'))
    expect(stsCall).toBeDefined()
    expect(decodeURIComponent(String((stsCall![1] as RequestInit).body))).toContain('control:grant:write')
    const invokeCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/v1/control/invoke'))
    expect(invokeCall).toBeDefined()
    const invokeBody = JSON.parse(String((invokeCall![1] as RequestInit).body))
    expect(invokeBody).toMatchObject({ command: 'grant', subcommand: 'create' })
    // The in-flight lock is taken and released by its owner.
    expect(redis.set).toHaveBeenCalled()
    expect(redis.eval).toHaveBeenCalled()
  })

  it('records durable zone memory of a plan it actually applied', async () => {
    const fetchMock = controlFetch([{ id: 'grant-xyz' }])
    const { app, clientQuery } = buildApp(true, { ...governedControl, fetchImpl: fetchMock as unknown as typeof fetch })
    const executionTurn = {
      id: 'turn-x',
      conversation_id: 'conv-1',
      seq: 5,
      role: 'operator',
      kind: 'execution',
      content: { plan_seq: 2, step_id: 's1', status: 'succeeded' },
      actor_id: 'actor-1',
      created_at: '2026-01-01T00:00:05Z',
    }
    clientQuery
      .mockResolvedValueOnce(undefined) // BEGIN (pre-flight)
      .mockResolvedValueOnce({ rows: [{ status: 'active' }] }) // conv status
      .mockResolvedValueOnce({ rows: [{ content: grantPlan }] }) // plan content
      .mockResolvedValueOnce({ rows: [{ kind: 'approval' }] }) // approved
      .mockResolvedValueOnce({ rows: [] }) // not executed
      .mockResolvedValueOnce({ rows: [{ one: 1 }] }) // preview: application lives
      .mockResolvedValueOnce({ rows: [{ one: 1 }] }) // preview: resource lives
      .mockResolvedValueOnce(undefined) // COMMIT
      .mockResolvedValueOnce(undefined) // BEGIN (recording)
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 5 }] }) // conv FOR UPDATE
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE next_seq
      .mockResolvedValueOnce({ rows: [executionTurn] }) // INSERT execution turn
      .mockResolvedValueOnce(undefined) // INSERT operator_zone_memory
      .mockResolvedValueOnce(undefined) // COMMIT
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/execute',
      payload: { plan_seq: 2 },
    })
    expect(res.statusCode).toBe(201)
    // The applied plan is written to durable, zone-scoped memory inside the recording
    // transaction: the memory carries the plan summary and the conversation that applied it.
    const memoryInsert = clientQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO operator_zone_memory'))
    expect(memoryInsert).toBeDefined()
    expect(memoryInsert![1][1]).toBe('z1')
    expect(memoryInsert![1][2]).toBe('conv-1')
    expect(memoryInsert![1][3]).toBe('Grant access')
  })

  it('records the execution turn even if the conversation was archived after the plan applied', async () => {
    // The mutation has already been applied to the control plane by the time the recording
    // transaction runs. If the conversation was archived in that window, the ledger must still
    // record the execution turn — both to reflect the real applied work and to write the dedup
    // marker that blocks a re-run. The recording FOR UPDATE returns an archived (but existing)
    // conversation; the execution turn is written all the same.
    const fetchMock = controlFetch([{ id: 'grant-xyz' }])
    const { app, clientQuery } = buildApp(true, { ...governedControl, fetchImpl: fetchMock as unknown as typeof fetch })
    const executionTurn = {
      id: 'turn-x',
      conversation_id: 'conv-1',
      seq: 5,
      role: 'operator',
      kind: 'execution',
      content: { plan_seq: 2, step_id: 's1', status: 'succeeded' },
      actor_id: 'actor-1',
      created_at: '2026-01-01T00:00:05Z',
    }
    clientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active' }] }) // conv status
      .mockResolvedValueOnce({ rows: [{ content: grantPlan }] }) // plan content
      .mockResolvedValueOnce({ rows: [{ kind: 'approval' }] }) // approved
      .mockResolvedValueOnce({ rows: [] }) // not executed
      .mockResolvedValueOnce({ rows: [{ one: 1 }] }) // preview: application lives
      .mockResolvedValueOnce({ rows: [{ one: 1 }] }) // preview: resource lives
      .mockResolvedValueOnce(undefined) // COMMIT
      .mockResolvedValueOnce(undefined) // BEGIN (recording)
      .mockResolvedValueOnce({ rows: [{ status: 'archived', next_seq: 5 }] }) // conv FOR UPDATE — archived
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE next_seq
      .mockResolvedValueOnce({ rows: [executionTurn] }) // INSERT execution turn
      .mockResolvedValueOnce(undefined) // COMMIT
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/execute',
      payload: { plan_seq: 2 },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    // The applied work is recorded truthfully, not dropped as a misleading empty success.
    expect(body.executed).toHaveLength(1)
    expect(body.outputs.s1).toEqual({ grant_id: 'grant-xyz' })
    // The dedup execution turn was written despite the archive, so the plan cannot be re-applied.
    const insertExec = clientQuery.mock.calls.find(
      (c) => String(c[0]).includes('INSERT INTO operator_turns') && String(c[1]?.[5]) === 'execution',
    )
    expect(insertExec).toBeDefined()
  })

  it('records nothing when the conversation was hard-deleted mid-execute, leaving no ledger to dedup', async () => {
    // A hard delete cascades away the whole plan ledger, so there is nothing to record against and
    // nothing left to re-run. The recording transaction finds no row and writes no turn.
    const fetchMock = controlFetch([{ id: 'grant-xyz' }])
    const { app, clientQuery } = buildApp(true, { ...governedControl, fetchImpl: fetchMock as unknown as typeof fetch })
    clientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active' }] }) // conv status
      .mockResolvedValueOnce({ rows: [{ content: grantPlan }] }) // plan content
      .mockResolvedValueOnce({ rows: [{ kind: 'approval' }] }) // approved
      .mockResolvedValueOnce({ rows: [] }) // not executed
      .mockResolvedValueOnce({ rows: [{ one: 1 }] }) // preview: application lives
      .mockResolvedValueOnce({ rows: [{ one: 1 }] }) // preview: resource lives
      .mockResolvedValueOnce(undefined) // COMMIT
      .mockResolvedValueOnce(undefined) // BEGIN (recording)
      .mockResolvedValueOnce({ rows: [] }) // conv FOR UPDATE — no row (deleted)
      .mockResolvedValueOnce(undefined) // COMMIT
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/execute',
      payload: { plan_seq: 2 },
    })
    expect(res.statusCode).toBe(201)
    const insertExec = clientQuery.mock.calls.find(
      (c) => String(c[0]).includes('INSERT INTO operator_turns') && String(c[1]?.[5]) === 'execution',
    )
    expect(insertExec).toBeUndefined()
  })

  it('refuses to execute a create plan whose target already exists, calling no control command', async () => {
    const fetchMock = controlFetch([])
    const { app, clientQuery } = buildApp(true, { ...governedControl, fetchImpl: fetchMock as unknown as typeof fetch })
    const registerPlan = {
      summary: 'Register',
      steps: [{ id: 's1', capability: 'registerApplication', mutating: true, args: { name: 'Billing' } }],
    }
    clientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active' }] }) // conv status
      .mockResolvedValueOnce({ rows: [{ content: registerPlan }] }) // plan
      .mockResolvedValueOnce({ rows: [{ kind: 'approval' }] }) // approved
      .mockResolvedValueOnce({ rows: [] }) // not executed
      .mockResolvedValueOnce({ rows: [{ one: 1 }] }) // preview: name now TAKEN -> exists
      .mockResolvedValueOnce(undefined) // COMMIT
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/execute',
      payload: { plan_seq: 2 },
    })
    expect(res.statusCode).toBe(409)
    const body = JSON.parse(res.body)
    expect(body.error).toBe('plan_already_satisfied')
    expect(body.steps[0]).toMatchObject({ step_id: 's1', capability: 'registerApplication' })
    // Nothing was applied: the control plane was never called.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('records an error turn when a control step is denied', async () => {
    const fetchMock = controlFetch([], { status: 403, body: { error: { reason: 'missing scope control:grant:write', code: 'forbidden' } } })
    const { app, clientQuery } = buildApp(true, { ...governedControl, fetchImpl: fetchMock as unknown as typeof fetch })
    const errorTurn = {
      id: 'turn-e',
      conversation_id: 'conv-1',
      seq: 5,
      role: 'system',
      kind: 'error',
      content: { message: 'Step s1 (grantAccess) failed: missing scope control:grant:write' },
      actor_id: 'actor-1',
      created_at: '2026-01-01T00:00:05Z',
    }
    clientQuery
      // pre-flight
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active' }] }) // conv status
      .mockResolvedValueOnce({ rows: [{ content: grantPlan }] }) // plan
      .mockResolvedValueOnce({ rows: [{ kind: 'approval' }] }) // approved
      .mockResolvedValueOnce({ rows: [] }) // not executed
      .mockResolvedValueOnce({ rows: [{ one: 1 }] }) // preview: application lives
      .mockResolvedValueOnce({ rows: [{ one: 1 }] }) // preview: resource lives
      .mockResolvedValueOnce(undefined) // COMMIT
      // recording transaction (error turn only; nothing applied)
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
    // An error turn was written describing the denied step, with the control reason.
    const insertError = clientQuery.mock.calls.find(
      (c) => String(c[0]).includes('INSERT INTO operator_turns') && String(c[1]?.[5]) === 'error',
    )
    expect(insertError).toBeDefined()
    expect(String(insertError![1][6])).toContain('missing scope control:grant:write')
    // A definitive denial applied nothing, so no execution turn is written and the plan
    // stays retriable once the missing scope is granted.
    const failedExec = clientQuery.mock.calls.find(
      (c) => String(c[0]).includes('INSERT INTO operator_turns') && String(c[1]?.[5]) === 'execution',
    )
    expect(failedExec).toBeUndefined()
  })

  it('records a failed execution turn when a control step fails ambiguously, blocking retry', async () => {
    // A 5xx at the invoke stage may have applied the mutation, so the failed step is
    // recorded as an execution turn: it shows as failed and blocks any re-run, so a
    // possibly-applied change is never applied twice.
    const fetchMock = controlFetch([], { status: 502, body: { error: { reason: 'upstream unavailable' } } })
    const { app, clientQuery } = buildApp(true, { ...governedControl, fetchImpl: fetchMock as unknown as typeof fetch })
    const failedTurn = {
      id: 'turn-f',
      conversation_id: 'conv-1',
      seq: 5,
      role: 'operator',
      kind: 'execution',
      content: { plan_seq: 2, step_id: 's1', status: 'failed', detail: 'upstream unavailable' },
      actor_id: 'actor-1',
      created_at: '2026-01-01T00:00:05Z',
    }
    const errorTurn = { ...failedTurn, id: 'turn-e', seq: 6, role: 'system', kind: 'error', content: { message: 'x' } }
    clientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active' }] }) // conv status
      .mockResolvedValueOnce({ rows: [{ content: grantPlan }] }) // plan
      .mockResolvedValueOnce({ rows: [{ kind: 'approval' }] }) // approved
      .mockResolvedValueOnce({ rows: [] }) // not executed
      .mockResolvedValueOnce({ rows: [{ one: 1 }] }) // preview: application lives
      .mockResolvedValueOnce({ rows: [{ one: 1 }] }) // preview: resource lives
      .mockResolvedValueOnce(undefined) // COMMIT
      // recording transaction: failed execution turn, then the system error turn
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 5 }] }) // conv FOR UPDATE
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE next_seq (failed exec)
      .mockResolvedValueOnce({ rows: [failedTurn] }) // INSERT failed execution turn
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE next_seq (error)
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
    // The failed step is recorded as an execution turn with status failed.
    const failedExec = clientQuery.mock.calls.find(
      (c) => String(c[0]).includes('INSERT INTO operator_turns') && String(c[1]?.[5]) === 'execution',
    )
    expect(failedExec).toBeDefined()
    expect(String(failedExec![1][6])).toContain('failed')
  })

  it('verifies an applied plan against live state and records a verification note', async () => {
    // After the apply, the route reads live state once more and runs the verifier, recording its
    // verdict as a note. Verification is advisory: it never gates or reverses the already-durable
    // apply, so the 201 stands whatever the verdict says. A combined fetch answers the control STS
    // and invoke for both the apply and the post-apply read, and the AI completion for the verdict.
    const aiProvider = {
      id: 'primary',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-x',
      apiKey: 'sk',
      timeoutMs: 1000,
      contextWindow: 0,
    }
    const registerPlan = {
      summary: 'Register the Billing application',
      steps: [{ id: 's1', capability: 'registerApplication', mutating: true, args: { name: 'Billing' } }],
    }
    const verdict = { status: 'matched', summary: 'The Billing application is present in current state.', findings: [] }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/oauth/2/token')) return jsonResponse({ access_token: 'control-token' })
      if (url.endsWith('/v1/control/invoke')) {
        const body = JSON.parse(String(init?.body))
        if (body.subcommand === 'create') return jsonResponse({ result: { id: 'app-new' } })
        return jsonResponse({ result: [{ name: 'Billing' }] }) // the post-apply application list
      }
      if (url.endsWith('/chat/completions')) {
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdict) } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const executionTurn = {
      id: 'turn-x',
      conversation_id: 'conv-1',
      seq: 5,
      role: 'operator',
      kind: 'execution',
      content: { plan_seq: 2, step_id: 's1', status: 'succeeded' },
      actor_id: 'actor-1',
      created_at: '2026-01-01T00:00:05Z',
    }
    const noteTurn = {
      id: 'turn-n',
      conversation_id: 'conv-1',
      seq: 6,
      role: 'operator',
      kind: 'note',
      content: { text: 'Verification (matched): The Billing application is present in current state.' },
      actor_id: 'actor-1',
      created_at: '2026-01-01T00:00:06Z',
    }
    const { app, clientQuery } = buildApp(true, {
      ...governedControl,
      aiProviders: [aiProvider],
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    clientQuery
      // pre-flight
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active' }] }) // conv status
      .mockResolvedValueOnce({ rows: [{ content: registerPlan }] }) // plan
      .mockResolvedValueOnce({ rows: [{ kind: 'approval' }] }) // approved
      .mockResolvedValueOnce({ rows: [] }) // not executed
      .mockResolvedValueOnce({ rows: [] }) // preview: name available -> create
      .mockResolvedValueOnce(undefined) // COMMIT
      // recording
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 5 }] }) // conv FOR UPDATE
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE next_seq
      .mockResolvedValueOnce({ rows: [executionTurn] }) // INSERT execution turn
      .mockResolvedValueOnce(undefined) // INSERT operator_zone_memory
      .mockResolvedValueOnce(undefined) // COMMIT
      // verification note (appendTurnTx)
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'active', mode: 'agent', autopilot: false, next_seq: 6 }] }) // conv FOR UPDATE
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE next_seq
      .mockResolvedValueOnce({ rows: [noteTurn] }) // INSERT note turn
      .mockResolvedValueOnce(undefined) // COMMIT
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/plan/execute',
      payload: { plan_seq: 2 },
    })
    expect(res.statusCode).toBe(201)
    // A verification note was written capturing the verdict the verifier produced over live state.
    const insertNote = clientQuery.mock.calls.find(
      (c) => String(c[0]).includes('INSERT INTO operator_turns') && String(c[1]?.[5]) === 'note',
    )
    expect(insertNote).toBeDefined()
    expect(String(insertNote![1][6])).toContain('Verification (matched)')
    // The verdict is recorded structurally as well as in human text, so a later turn's facts can
    // learn from it: a drift would re-enter the planner's grounding rather than dead-ending as prose.
    expect(JSON.parse(String(insertNote![1][6])).verification).toEqual({
      status: 'matched',
      summary: 'The Billing application is present in current state.',
    })
    // The verifier judged against live state read after the apply: the post-apply application list
    // was read through the governed control plane, scoped to the application domain the plan touched.
    const listInvoke = fetchMock.mock.calls.find(
      (c) => String(c[0]).endsWith('/v1/control/invoke') && JSON.parse(String((c[1] as RequestInit).body)).subcommand === 'list',
    )
    expect(listInvoke).toBeDefined()
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
    // The context reads run concurrently, so route by query shape rather than call order.
    db.query.mockImplementation((sql: string) => {
      if (sql.includes('FROM operator_conversations')) return Promise.resolve({ rows: [{ status: 'active', next_seq: 4 }] })
      if (sql.includes("kind = 'plan'")) return Promise.resolve({ rows: [{ seq: 2 }] }) // latest plan seq
      if (sql.includes('seq >= $3'))
        return Promise.resolve({
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
      if (sql.includes("kind = 'error'")) return Promise.resolve({ rows: [] })
      if (sql.includes("kind = 'message'"))
        return Promise.resolve({ rows: [{ seq: 1, role: 'user', kind: 'message', content: { text: 'Connect GitHub' } }] })
      return Promise.resolve({ rows: [] }) // facts: decision-turn history
    })
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
    // The context reads run concurrently, so route by query shape rather than call order.
    const decisionRows = [
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
    ]
    db.query.mockImplementation((sql: string) => {
      if (sql.includes('FROM operator_conversations')) return Promise.resolve({ rows: [{ status: 'active', next_seq: 6 }] })
      if (sql.includes("kind = 'plan'")) return Promise.resolve({ rows: [{ seq: 2 }] }) // latest plan seq
      if (sql.includes('seq >= $3')) return Promise.resolve({ rows: decisionRows }) // plan slice
      if (sql.includes("kind = 'error'")) return Promise.resolve({ rows: [] })
      if (sql.includes("kind = 'message'")) return Promise.resolve({ rows: [] })
      return Promise.resolve({ rows: decisionRows }) // facts: decision-turn history
    })
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

  // Parses a Server-Sent Events payload into its frames, so a streaming response can be asserted
  // by event name and decoded data the same way a streaming client would read it.
  function parseSse(payload: string): { event: string; data: unknown }[] {
    return payload
      .split('\n\n')
      .filter((block) => block.trim().length > 0)
      .map((block) => {
        const lines = block.split('\n')
        const event = lines.find((l) => l.startsWith('event: '))!.slice(7)
        const data = lines.find((l) => l.startsWith('data: '))!.slice(6)
        return { event, data: JSON.parse(data) }
      })
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

  it('resumes an existing durable message run without appending or calling the model again', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const { app, clientQuery } = buildApp(true, { aiProviders: [provider], fetchImpl })
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM operator_conversations')) {
        return { rows: [{ status: 'active', mode: 'agent', autopilot: false, next_seq: 8 }] }
      }
      if (sql.includes('FROM operator_message_runs')) {
        return {
          rows: [
            {
              id: 'run-1',
              zone_id: 'z1',
              conversation_id: 'conv-1',
              client_message_id: 'msg-1',
              server_message_turn_id: 'turn-1',
              correlation_id: 'corr-1',
              state: 'waiting_for_model',
              actor_id: 'actor-1',
              provider_id: null,
              reason: 'model_requested',
              error_code: null,
              error_detail: null,
              deadline_at: null,
              started_at: '2026-07-01T00:00:00Z',
              updated_at: '2026-07-01T00:00:01Z',
              completed_at: null,
              last_event_seq: 3,
            },
          ],
        }
      }
      return { rows: [], rowCount: 1 }
    })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/message',
      payload: { message: 'connect github', client_message_id: 'msg-1', correlation_id: 'corr-1' },
    })
    expect(res.statusCode).toBe(202)
    expect(JSON.parse(res.body)).toMatchObject({
      intent: 'message_run',
      ok: true,
      duplicate: true,
      message_run: { id: 'run-1', client_message_id: 'msg-1', correlation_id: 'corr-1', state: 'waiting_for_model' },
    })
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0)
    expect(clientQuery.mock.calls.some((call) => String(call[0]).includes('INSERT INTO operator_turns'))).toBe(false)
  })

  it('records a durable message run and marks it failed when the model budget stops the turn', async () => {
    const fetchImpl = fetchReturning('{"tier":"read"}', 'answer never reached')
    const { app, clientQuery, db } = buildApp(true, {
      aiProviders: [provider],
      fetchImpl,
      aiGovernance: { maxOutputTokens: 0, maxCallsPerTurn: 1 },
    })
    let runState = 'queued'
    let lastEventSeq = 0
    const run = (overrides: Record<string, unknown> = {}) => ({
      id: 'run-1',
      zone_id: 'z1',
      conversation_id: 'conv-1',
      client_message_id: 'msg-2',
      server_message_turn_id: null,
      correlation_id: 'corr-2',
      state: runState,
      actor_id: 'actor-1',
      provider_id: 'primary',
      reason: null,
      error_code: null,
      error_detail: null,
      deadline_at: '2026-07-01T00:02:00Z',
      started_at: '2026-07-01T00:00:00Z',
      updated_at: '2026-07-01T00:00:00Z',
      completed_at: null,
      last_event_seq: lastEventSeq,
      ...overrides,
    })
    clientQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM operator_conversations')) {
        return { rows: [{ status: 'active', mode: 'agent', autopilot: false, next_seq: 1 }] }
      }
      if (sql.includes('WHERE conversation_id = $1 AND client_message_id = $2')) return { rows: [] }
      if (sql.startsWith('INSERT INTO operator_message_runs')) return { rows: [run()] }
      if (sql.startsWith('INSERT INTO operator_message_run_events')) return { rows: [] }
      if (sql.startsWith('UPDATE operator_message_runs')) {
        if (params?.[1] === 'turn-1') return { rows: [run({ server_message_turn_id: 'turn-1' })] }
        runState = String(params?.[1] ?? runState)
        lastEventSeq = Number(params?.[6] ?? lastEventSeq)
        return {
          rows: [
            run({
              server_message_turn_id: 'turn-1',
              reason: typeof params?.[2] === 'string' ? params[2] : null,
              error_code: typeof params?.[3] === 'string' ? params[3] : null,
              error_detail: typeof params?.[4] === 'string' ? params[4] : null,
              completed_at: runState === 'failed' ? '2026-07-01T00:00:04Z' : null,
            }),
          ],
        }
      }
      if (sql.includes('SELECT') && sql.includes('FROM operator_message_runs')) return { rows: [run({ server_message_turn_id: 'turn-1' })] }
      if (sql.startsWith('INSERT INTO operator_turns')) return { rows: [{ id: 'turn-1', seq: 1, kind: 'message' }] }
      return { rows: [], rowCount: 1 }
    })
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ seq: 1, role: 'user', kind: 'message', content: { text: 'why denied' } }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ name: 'Pied Piper Production', slug: 'z1' }] })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/message',
      payload: { message: 'why denied', client_message_id: 'msg-2', correlation_id: 'corr-2', provider: 'primary' },
    })
    expect(res.statusCode).toBe(429)
    const body = JSON.parse(res.body)
    expect(body).toMatchObject({
      error: 'ai_budget_exceeded',
      message_run: { client_message_id: 'msg-2', correlation_id: 'corr-2', state: 'failed', error_code: 'ai_budget_exceeded' },
    })
    const messageInsert = clientQuery.mock.calls.find((call) => String(call[0]).includes('INSERT INTO operator_turns'))
    expect(messageInsert).toBeDefined()
    expect(messageInsert![1][8]).toBe('msg-2')
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

  it('refuses a message that would exceed the per-turn model-call budget', async () => {
    // With a budget of one model call, triage consumes it and the answer call is refused, so the
    // turn stops with a 429 rather than running an unbounded sequence of model calls.
    const fetchImpl = fetchReturning('{"tier":"read"}', 'an answer that is never reached')
    const { app, clientQuery, db } = buildApp(true, {
      aiProviders: [provider],
      fetchImpl,
      aiGovernance: { maxOutputTokens: 0, maxCallsPerTurn: 1 },
    })
    clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ status: 'active', mode: 'agent', autopilot: false, next_seq: 1 }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'turn-1', seq: 1, kind: 'message' }] })
      .mockResolvedValueOnce(undefined)
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/message',
      payload: { message: 'why was my agent denied' },
    })
    expect(res.statusCode).toBe(429)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'ai_budget_exceeded', max_calls: 1 })
    // Only the triage model call was made before the budget refused the next one.
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1)
  })

  it('surfaces a planner budget refusal as 429 rather than a misleading no-plan', async () => {
    // A change request: triage consumes the single-call budget, so the planner call is refused.
    // The planner propagates the budget stop rather than reporting an unmappable request, so the
    // turn returns 429, not a 200 no_plan.
    const fetchImpl = fetchReturning('{"tier":"change"}', '{"summary":"x","steps":[]}')
    const { app, clientQuery, db } = buildApp(true, {
      aiProviders: [provider],
      fetchImpl,
      aiGovernance: { maxOutputTokens: 0, maxCallsPerTurn: 1 },
    })
    clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ status: 'active', mode: 'agent', autopilot: false, next_seq: 1 }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'turn-1', seq: 1, kind: 'message' }] })
      .mockResolvedValueOnce(undefined)
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
    expect(res.statusCode).toBe(429)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'ai_budget_exceeded' })
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1)
  })

  it('turns a natural-language request into a validated, previewed plan', async () => {
    const plan = {
      summary: 'Connect GitHub',
      steps: [{ id: 's1', capability: 'connectProvider', args: { name: 'GitHub', kind: 'oauth2_authorization_code' } }],
    }
    const fetchImpl = fetchReturning('{"tier":"change"}', JSON.stringify(plan))
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
    expect(body).toMatchObject({ intent: 'plan', tier: 'change', ok: true })
    expect(body.turn).toMatchObject({ kind: 'plan' })
    expect(body.validation.ok).toBe(true)
    expect(body.preview.steps[0]).toMatchObject({ effect: 'create' })
  })

  it('streams a plan turn as Server-Sent Events with stage frames then a terminal result', async () => {
    const plan = {
      summary: 'Connect GitHub',
      steps: [{ id: 's1', capability: 'connectProvider', args: { name: 'GitHub', kind: 'oauth2_authorization_code' } }],
    }
    const fetchImpl = fetchReturning('{"tier":"change"}', JSON.stringify(plan))
    const { app, clientQuery, db } = buildApp(true, { aiProviders: [provider], fetchImpl })
    // user message turn (BEGIN, FOR UPDATE, UPDATE seq, INSERT, COMMIT)
    clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 1 }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'turn-1', seq: 1, kind: 'message' }] })
      .mockResolvedValueOnce(undefined)
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
      headers: { accept: 'text/event-stream' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    const frames = parseSse(res.body)
    // The deliberation stages stream first, then exactly one terminal result frame.
    expect(frames.filter((f) => f.event === 'stage').map((f) => (f.data as { stage: string }).stage)).toEqual([
      'triaging',
      'gathering',
      'planning',
      'critiquing',
      'guarding',
    ])
    const terminal = frames.at(-1)!
    expect(terminal.event).toBe('result')
    // The terminal frame carries the exact authoritative body the JSON path returns: a validated,
    // previewed, approval-gated plan. Streaming changed only delivery, never the governed outcome.
    expect(terminal.data).toMatchObject({ intent: 'plan', tier: 'change', ok: true })
    expect((terminal.data as { validation: { ok: boolean } }).validation.ok).toBe(true)
    expect((terminal.data as { preview: { steps: { effect: string }[] } }).preview.steps[0].effect).toBe('create')
    // The same trail that streamed live is recorded on the persisted plan turn so the console can
    // replay it after the stream ends.
    const planInsert = clientQuery.mock.calls.find((call) => {
      const param = call[1]?.[6]
      if (typeof param !== 'string') return false
      try {
        return Array.isArray(JSON.parse(param).steps)
      } catch {
        return false
      }
    })
    expect(planInsert).toBeDefined()
    expect(JSON.parse(planInsert![1][6]).deliberation).toEqual(['triaging', 'gathering', 'planning', 'critiquing', 'guarding'])
    // The effect each step was previewed to have against live state is recorded per step, so the
    // console can show the consequence the human reviewed rather than only the step's claim.
    expect(JSON.parse(planInsert![1][6]).steps[0].effect).toBe('create')
  })

  it('streams a governance budget refusal as a terminal error frame', async () => {
    // A one-call budget: triage consumes it and the planner call is refused, so the turn fails
    // closed. On the stream the refusal is a terminal error frame, never silently swallowed.
    const fetchImpl = fetchReturning('{"tier":"change"}', '{"summary":"x","steps":[]}')
    const { app, clientQuery, db } = buildApp(true, {
      aiProviders: [provider],
      fetchImpl,
      aiGovernance: { maxOutputTokens: 0, maxCallsPerTurn: 1 },
    })
    clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ status: 'active', mode: 'agent', autopilot: false, next_seq: 1 }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'turn-1', seq: 1, kind: 'message' }] })
      .mockResolvedValueOnce(undefined)
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
      headers: { accept: 'text/event-stream' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    const frames = parseSse(res.body)
    const terminal = frames.at(-1)!
    expect(terminal.event).toBe('error')
    expect(terminal.data).toMatchObject({ error: 'ai_budget_exceeded', max_calls: 1, status: 429 })
  })

  it('auto-approves a low-risk plan in agent mode when autopilot is engaged and the master switch is on', async () => {
    // With the master switch on and the conversation engaged, Caracal auto-satisfies the approval
    // for any non-empty plan. The conversation row reports agent mode with autopilot engaged.
    const plan = {
      summary: 'Register the billing app',
      steps: [{ id: 's1', capability: 'registerApplication', args: { name: 'Billing' } }],
    }
    const fetchImpl = fetchReturning('{"tier":"change"}', JSON.stringify(plan))
    const { app, clientQuery, db } = buildApp(true, {
      aiProviders: [provider],
      fetchImpl,
      autopilotPolicy: buildAutopilotPolicy({ enabled: true }),
    })
    // user message turn
    clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ status: 'active', mode: 'agent', autopilot: true, next_seq: 1 }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'turn-1', seq: 1, kind: 'message' }] })
      .mockResolvedValueOnce(undefined)
    db.query
      .mockResolvedValueOnce({ rows: [] }) // latest plan seq
      .mockResolvedValueOnce({ rows: [] }) // error rows
      .mockResolvedValueOnce({ rows: [] }) // messages
      .mockResolvedValueOnce({ rows: [] }) // facts
      .mockResolvedValueOnce({ rows: [] }) // zone memory recall
      .mockResolvedValueOnce({ rows: [{ name: 'Pied Piper Production', slug: 'z1' }] }) // operating zone
      .mockResolvedValueOnce({ rows: [] }) // previewPlan: application name free
    // plan turn persist
    clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ status: 'active', mode: 'agent', autopilot: true, next_seq: 2 }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'turn-2', seq: 2, kind: 'plan' }] })
      .mockResolvedValueOnce(undefined)
    // autopilot approval turn persist
    clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ status: 'active', mode: 'agent', autopilot: true, next_seq: 3 }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'turn-3', seq: 3, kind: 'approval' }] })
      .mockResolvedValueOnce(undefined)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/message',
      payload: { message: 'register the billing app' },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body).toMatchObject({ intent: 'plan', tier: 'change', ok: true, auto_approved: true })
    expect(body.approval_turn).toMatchObject({ kind: 'approval' })
    // The approval turn was persisted referencing the plan's seq and attributed to autopilot.
    const approvalInsert = clientQuery.mock.calls.find(
      (c) => String(c[0]).includes('INSERT INTO operator_turns') && String(c[1]?.[5]) === 'approval',
    )
    expect(approvalInsert).toBeDefined()
    const content = JSON.parse(String(approvalInsert![1][6]))
    expect(content).toMatchObject({ plan_seq: 2, autopilot: true })
    // The deliberation trail is recorded even on the non-streaming path, so the console can replay
    // how the plan was reasoned regardless of how the result was delivered.
    const planInsert = clientQuery.mock.calls.find(
      (c) => String(c[0]).includes('INSERT INTO operator_turns') && String(c[1]?.[5]) === 'plan',
    )
    expect(planInsert).toBeDefined()
    expect(JSON.parse(String(planInsert![1][6])).deliberation).toContain('triaging')
  })

  it('auto-approves a plan whose capability the old allowlist would have excluded', async () => {
    // connectProvider was never on the legacy allowlist, but with pass-all an engaged conversation
    // auto-approves it too: the plan is persisted and an approval turn is recorded.
    const plan = {
      summary: 'Connect GitHub',
      steps: [{ id: 's1', capability: 'connectProvider', args: { name: 'GitHub', kind: 'api_key' } }],
    }
    const fetchImpl = fetchReturning('{"tier":"change"}', JSON.stringify(plan))
    const { app, clientQuery, db } = buildApp(true, {
      aiProviders: [provider],
      fetchImpl,
      autopilotPolicy: buildAutopilotPolicy({ enabled: true }),
    })
    clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ status: 'active', mode: 'agent', autopilot: true, next_seq: 1 }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'turn-1', seq: 1, kind: 'message' }] })
      .mockResolvedValueOnce(undefined)
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }) // previewPlan: provider name free
    clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ status: 'active', mode: 'agent', autopilot: true, next_seq: 2 }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'turn-2', seq: 2, kind: 'plan' }] })
      .mockResolvedValueOnce(undefined)
    // autopilot approval turn persist
    clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ status: 'active', mode: 'agent', autopilot: true, next_seq: 3 }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'turn-3', seq: 3, kind: 'approval' }] })
      .mockResolvedValueOnce(undefined)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/message',
      payload: { message: 'connect github' },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body).toMatchObject({ intent: 'plan', ok: true, auto_approved: true })
    expect(body.approval_turn).toMatchObject({ kind: 'approval' })
    // An approval turn was written attributed to autopilot.
    expect(
      clientQuery.mock.calls.some((c) => String(c[0]).includes('INSERT INTO operator_turns') && String(c[1]?.[5]) === 'approval'),
    ).toBe(true)
  })

  it('does not auto-approve when autopilot is not engaged on the conversation', async () => {
    // The master switch is on, but the conversation has not engaged autopilot, so no auto-approval
    // happens.
    const plan = {
      summary: 'Register the billing app',
      steps: [{ id: 's1', capability: 'registerApplication', args: { name: 'Billing' } }],
    }
    const fetchImpl = fetchReturning('{"tier":"change"}', JSON.stringify(plan))
    const { app, clientQuery, db } = buildApp(true, {
      aiProviders: [provider],
      fetchImpl,
      autopilotPolicy: buildAutopilotPolicy({ enabled: true }),
    })
    clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ status: 'active', mode: 'agent', autopilot: false, next_seq: 1 }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'turn-1', seq: 1, kind: 'message' }] })
      .mockResolvedValueOnce(undefined)
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }) // previewPlan
    clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ status: 'active', mode: 'agent', autopilot: false, next_seq: 2 }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'turn-2', seq: 2, kind: 'plan' }] })
      .mockResolvedValueOnce(undefined)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/message',
      payload: { message: 'register the billing app' },
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ auto_approved: false, approval_turn: null })
    // No approval turn was written: the plan waits for a human.
    expect(
      clientQuery.mock.calls.some((c) => String(c[0]).includes('INSERT INTO operator_turns') && String(c[1]?.[5]) === 'approval'),
    ).toBe(false)
  })

  it('surfaces autopilot availability on the status endpoint', async () => {
    const { app } = buildApp(true, {
      aiProviders: [provider],
      autopilotPolicy: buildAutopilotPolicy({ enabled: true }),
    })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/operator/status' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.autopilot).toEqual({ available: true })
  })

  it('reports autopilot unavailable by default', async () => {
    const { app } = buildApp(true, { aiProviders: [provider] })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/operator/status' })
    expect(JSON.parse(res.body).autopilot).toEqual({ available: false })
  })

  it('refuses to plan in ask mode and answers with a switch-to-agent note', async () => {
    // Ask mode is read-only. Triage classifies the request as a change, but the orchestrator
    // short-circuits to a deterministic switch-to-agent answer and never calls the planner, so
    // only one model call is made (triage) and the turn is a note, never a plan.
    const fetchImpl = fetchReturning('{"tier":"change"}')
    const { app, clientQuery, db } = buildApp(true, { aiProviders: [provider], fetchImpl })
    // user message turn: FOR UPDATE returns ask mode
    clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ status: 'active', mode: 'ask', next_seq: 1 }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'turn-1', seq: 1, kind: 'message' }] })
      .mockResolvedValueOnce(undefined)
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    // note turn persist
    clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ status: 'active', mode: 'ask', next_seq: 2 }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'turn-2', seq: 2, kind: 'note' }] })
      .mockResolvedValueOnce(undefined)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/message',
      payload: { message: 'connect github' },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body).toMatchObject({ intent: 'explain', tier: 'change', ok: true })
    expect(body.text).toContain('ask mode')
    expect(body.turn).toMatchObject({ kind: 'note' })
    // Exactly one model call: triage. The planner is never invoked in ask mode.
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1)
  })

  it('answers a read in ask mode normally', async () => {
    // Ask mode still answers read and conversational requests; only changes are withheld.
    const fetchImpl = fetchReturning('{"tier":"read"}', 'You have two providers connected.')
    const { app, clientQuery, db } = buildApp(true, { aiProviders: [provider], fetchImpl })
    clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ status: 'active', mode: 'ask', next_seq: 1 }] })
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
      .mockResolvedValueOnce({ rows: [{ status: 'active', mode: 'ask', next_seq: 2 }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'turn-2', seq: 2, kind: 'note' }] })
      .mockResolvedValueOnce(undefined)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/message',
      payload: { message: 'what providers do i have' },
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ intent: 'explain', tier: 'read', ok: true })
  })

  it('composes a compound request: attaches and persists an advisory security review with the plan', async () => {
    const plan = {
      summary: 'Connect GitHub for the finance team',
      steps: [{ id: 's1', capability: 'connectProvider', args: { name: 'GitHub', kind: 'oauth2_authorization_code' } }],
    }
    const advisory = {
      summary: 'The connection is scoped to a single provider; low blast-radius.',
      findings: [{ severity: 'caution', concern: 'Confirm the OAuth app is restricted to the finance org.' }],
    }
    // No control identity, so the researcher is absent and the compound path degrades to no
    // evidence — but it still plans and still runs the correctness critic and the advisory review.
    // Four model calls in order: triage (compound), planner, correctness critic, security analyst.
    const fetchImpl = fetchReturning(
      '{"tier":"compound"}',
      JSON.stringify(plan),
      JSON.stringify({ verdict: 'sound', summary: 'Plan achieves the goal.', deficiencies: [] }),
      JSON.stringify(advisory),
    )
    const { app, clientQuery, db } = buildApp(true, { aiProviders: [provider], fetchImpl })
    clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 1 }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'turn-1', seq: 1, kind: 'message' }] })
      .mockResolvedValueOnce(undefined)
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ seq: 1, role: 'user', kind: 'message', content: { text: 'connect github for finance' } }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }) // previewPlan: provider name free
    let persistedContent: string | undefined
    clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ status: 'active', next_seq: 2 }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockImplementationOnce((_sql: string, args: unknown[]) => {
        // The plan turn INSERT carries the content JSON as its 7th parameter (after id,
        // conversation, zone, seq, role, kind); capture it to prove the advisory is persisted
        // with the plan, not only returned in the response.
        persistedContent = String(args[6])
        return Promise.resolve({ rows: [{ id: 'turn-2', seq: 2, kind: 'plan' }] })
      })
      .mockResolvedValueOnce(undefined)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/operator-conversations/conv-1/message',
      payload: { message: 'connect github for finance and keep it least privilege' },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body).toMatchObject({ intent: 'plan', tier: 'compound', ok: true })
    // The advisory is returned with the plan and never gates it — the plan is still validated,
    // previewed, and awaiting approval.
    expect(body.advisory).toEqual(advisory)
    expect(body.validation.ok).toBe(true)
    // The advisory is persisted in the plan turn content for durable, audited human review.
    expect(persistedContent).toBeDefined()
    expect(JSON.parse(persistedContent!).advisory).toEqual(advisory)
    // Four model calls: triage + planner + correctness critic + security analyst.
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(4)
  })

  it('records an error turn when the model cannot produce a usable plan', async () => {
    const fetchImpl = fetchReturning('{"tier":"change"}', 'I cannot help with that.')
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
    const fetchImpl = fetchReturning('{"tier":"read"}', 'The request was denied because the scope is missing.')
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
    expect(body).toMatchObject({ intent: 'explain', tier: 'read', ok: true })
    expect(body.text).toContain('scope is missing')
  })

  it('routes a diagnostic read through the troubleshooter and answers with a note turn', async () => {
    // Triage classifies the read with the diagnostic topic; the default registry selects the
    // troubleshooter, still a read-only answer recorded as a note. Two model calls: triage + answer.
    const fetchImpl = fetchReturning('{"tier":"read","topic":"diagnostic"}', 'It was denied because no grant exists yet for that resource.')
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
      payload: { message: 'why was my agent denied access to the invoices resource' },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body).toMatchObject({ intent: 'explain', tier: 'read', ok: true })
    expect(body.text).toContain('no grant exists')
    // Read-only diagnosis: triage + the answer, no planner, no governed write.
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2)
  })

  it('answers a conversational request as text without invoking the planner', async () => {
    // Triage classifies a greeting as conversational; the orchestrator answers it directly with
    // the explainer and never calls the planner, so only two model calls are made: triage and
    // the text answer.
    const fetchImpl = fetchReturning('{"tier":"conversational"}', 'I help you operate Caracal in plain language.')
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
      payload: { message: 'hello, what can you do?' },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body).toMatchObject({ intent: 'explain', tier: 'conversational', ok: true })
    expect(body.turn).toMatchObject({ kind: 'note' })
    // Exactly two model calls: triage + the text answer. No planner call.
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2)
  })

  it('grounds a read answer in evidence gathered through governed reads', async () => {
    // A read tier inspects state, so the orchestrator gathers live evidence through the
    // Operator's own scoped control identity before the explainer answers — the same dogfooded
    // path a change executes through. The combined fetch answers the AI chat completions, the STS
    // token mint, and each governed list invoke by URL.
    let aiCall = 0
    const aiContents = ['{"tier":"read"}', 'You have one provider connected: GitHub.']
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/chat/completions')) {
        return new Response(JSON.stringify({ choices: [{ message: { content: aiContents[aiCall++] } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/oauth/2/token')) return jsonResponse({ access_token: 'control-token' })
      if (url.endsWith('/v1/control/invoke')) {
        const body = JSON.parse(String(init?.body))
        const rows = body.command === 'identity-provider' ? [{ id: 'p1', name: 'GitHub' }] : []
        return jsonResponse({ result: rows })
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const { app, clientQuery, db } = buildApp(true, {
      aiProviders: [provider],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...governedControl,
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
      payload: { message: 'what providers do i have' },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body).toMatchObject({ intent: 'explain', tier: 'read', ok: true })
    // The governed reads ran: one control invoke per governed read capability, each a list
    // subcommand, so a read answer is grounded in live state and never reaches a mutating command.
    const invokeCalls = fetchImpl.mock.calls.filter((c) => String(c[0]).endsWith('/v1/control/invoke'))
    expect(invokeCalls).toHaveLength(5)
    for (const call of invokeCalls) {
      expect(JSON.parse(String((call[1] as RequestInit).body)).subcommand).toBe('list')
    }
  })

  it('answers a read tier without governed reads when no control identity is configured', async () => {
    // With no control identity the researcher is absent, so the read answer falls back to
    // conversation context alone — exactly the behavior before evidence-gathering existed.
    const fetchImpl = fetchReturning('{"tier":"read"}', 'I cannot read your live state right now.')
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
      payload: { message: 'what providers do i have' },
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ intent: 'explain', tier: 'read', ok: true })
    // Exactly two model calls and no control traffic: triage + the text answer.
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2)
  })

  it('reads a tenant zone through the zone-scope mandate when the identity is bound elsewhere', async () => {
    // The Operator acts as its single reserved system-zone identity in every zone. A conversation
    // in a zone the identity is not bound to is read through the governed control plane with a
    // zone-scope header, so the answer is grounded in that zone's live state without provisioning
    // any identity in it.
    let m = 0
    const modelContents = ['{"tier":"read"}', 'You have one provider connected.']
    const calls: { url: string; zoneScope: unknown }[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const headers = (init?.headers ?? {}) as Record<string, string>
      calls.push({ url, zoneScope: headers['x-caracal-zone-scope'] })
      if (url.endsWith('/oauth/2/token')) return jsonResponse({ access_token: 'control-token' })
      if (url.endsWith('/v1/control/invoke')) return jsonResponse({ result: [] })
      return new Response(JSON.stringify({ choices: [{ message: { content: modelContents[m++] } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const { app, clientQuery, db } = buildApp(true, {
      aiProviders: [provider],
      fetchImpl,
      controlIdentity: { applicationId: 'caracal-sys-operator', clientSecret: 'cs_sealed', zoneId: 'other-zone' },
      controlEndpoints: governedControl.controlEndpoints,
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
      payload: { message: 'what providers do i have' },
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ intent: 'explain', tier: 'read', ok: true })
    // The researcher read the conversation's zone, and every control invoke carried the
    // conversation zone as its zone-scope, so the read targeted z1, not the identity's home zone.
    const invokeCalls = calls.filter((c) => c.url.endsWith('/v1/control/invoke'))
    expect(invokeCalls.length).toBeGreaterThan(0)
    expect(invokeCalls.every((c) => c.zoneScope === 'z1')).toBe(true)
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
      { content: '{"tier":"read"}', prompt: 120, completion: 4 },
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

  it('reports the served model and a failover flag when the primary provider is unavailable', async () => {
    const first = { ...provider, id: 'first', model: 'model-a', apiKey: 'sk-first' }
    const second = { ...provider, id: 'second', model: 'model-b', apiKey: 'sk-second', contextWindow: 64000 }
    // The primary's key always fails, so every call fails over to the secondary. The mock keys off
    // the bearer credential because both providers share a base URL.
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string> | undefined)?.authorization
      if (auth === 'Bearer sk-first') return new Response('boom', { status: 503 })
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"tier":"read"}' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const { app, clientQuery, db } = buildApp(true, { aiProviders: [first, second], fetchImpl })
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
    // The console hears the model that actually answered, not the one that was expected, plus the
    // signal that Caracal fell back.
    expect(body.provider).toBe('second')
    expect(body.model).toBe('model-b')
    expect(body.max_tokens).toBe(64000)
    expect(body.failover).toBe(true)
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
    const fetchImpl = fetchReturning('{"tier":"read"}', 'Routed through model-b.')
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
