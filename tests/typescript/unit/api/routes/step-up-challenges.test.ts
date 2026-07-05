// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Step-up challenge route unit tests for lookup, decision guards, and audit enqueue.

import { describe, it, expect, vi } from 'vitest'
import { stepUpChallengesRoutes } from '../../../../../apps/api/src/routes/step-up-challenges.js'
import { buildRouteApp } from '../../../../shared/test-utils/typescript/fastify.js'

const OPERATOR = { actor: { id: 'op-1', name: 'operator', scope: 'global', zoneId: null } }

const DECIDED_ROW = {
  id: 'challenge-1',
  session_id: 's-1',
  application_id: 'app-1',
  tier: 'money',
  approver_class: 'operator',
  privacy_mode: 'identified',
  binding: 'aa11',
  satisfied_at: '2026-05-05T00:00:00.000Z',
  rejected_at: null,
  decision_reason: null,
  approver_subject_id: 'admin:op-1',
}

function txClient(handler: (sql: string, params?: unknown[]) => { rows: unknown[] } | undefined) {
  const client = { query: vi.fn(), release: vi.fn() }
  client.query.mockImplementation(async (sql: string, params?: unknown[]) => handler(sql, params) ?? { rows: [] })
  return client
}

describe('GET /v1/zones/:zoneId/step-up-challenges', () => {
  it('lists challenges with derived state and keyset pagination', async () => {
    const { app, db } = buildRouteApp(stepUpChallengesRoutes)
    db.query.mockResolvedValueOnce({
      rows: [
        { id: 'challenge-2', zone_id: 'z1', state: 'pending', created_at: '2026-01-02T00:00:00.000Z' },
        { id: 'challenge-1', zone_id: 'z1', state: 'approved', created_at: '2026-01-01T00:00:00.000Z' },
      ],
    })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/step-up-challenges?limit=1' })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.items).toHaveLength(2)
    expect(body.next_cursor).toEqual(expect.any(String))
    expect(String(db.query.mock.calls[0][0])).toContain('END AS state')
    expect(db.query.mock.calls[0][1]).toEqual(['z1', 1])
  })
})

describe('GET /v1/zones/:zoneId/step-up-challenges/:id', () => {
  it('returns a zone-scoped challenge with its approval fact', async () => {
    const { app, db } = buildRouteApp(stepUpChallengesRoutes)
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'challenge-1', zone_id: 'z1', challenge_type: 'human_approval', tier: 'money', state: 'pending', binding: 'aa11' }],
    })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/step-up-challenges/challenge-1' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'challenge-1', tier: 'money', state: 'pending', binding: 'aa11' })
  })

  it('returns 404 when challenge is missing or outside the zone', async () => {
    const { app, db } = buildRouteApp(stepUpChallengesRoutes)
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/step-up-challenges/challenge-1' })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'challenge_not_found' })
  })
})

describe('POST /v1/zones/:zoneId/step-up-challenges/:id decisions', () => {
  it('approves a live hold, attributes the actor, and enqueues the audit event in the same transaction', async () => {
    const { app, db } = buildRouteApp(stepUpChallengesRoutes, { prefix: '/v1' }, OPERATOR)
    const client = txClient((sql) => {
      if (sql.includes('UPDATE step_up_challenges')) return { rows: [DECIDED_ROW] }
      return undefined
    })
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/step-up-challenges/challenge-1/approve', payload: {} })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'challenge-1', state: 'approved', approver_subject_id: 'admin:op-1' })
    const update = client.query.mock.calls.find((c) => String(c[0]).includes('UPDATE step_up_challenges'))
    expect(String(update?.[0])).toContain('satisfied_at = now()')
    expect(String(update?.[0])).toContain("approver_class IN ('operator', 'any')")
    expect(update?.[1]).toEqual(['challenge-1', 'z1', 'admin:op-1', null])
    const outbox = client.query.mock.calls.find((c) => String(c[0]).includes('INSERT INTO event_outbox'))
    expect(outbox).toBeDefined()
    const payload = JSON.parse(String((outbox?.[1] as unknown[])[2]))
    expect(JSON.parse(payload.data)).toMatchObject({
      event_type: 'step_up_decided',
      decision: 'approved',
      zone_id: 'z1',
      metadata_json: { challenge_id: 'challenge-1', approver_plane: 'operator', approver_subject_id: 'admin:op-1', binding: 'aa11' },
    })
    expect(client.query.mock.calls.map((c) => String(c[0])).at(-1)).toBe('COMMIT')
  })

  it('rejects a live hold and records the rationale', async () => {
    const { app, db } = buildRouteApp(stepUpChallengesRoutes, { prefix: '/v1' }, OPERATOR)
    const client = txClient((sql) => {
      if (sql.includes('UPDATE step_up_challenges')) {
        return { rows: [{ ...DECIDED_ROW, satisfied_at: null, rejected_at: '2026-05-05T00:00:00.000Z', decision_reason: 'wrong amount' }] }
      }
      return undefined
    })
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/step-up-challenges/challenge-1/reject',
      payload: { reason: 'wrong amount' },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'challenge-1', state: 'rejected' })
    const update = client.query.mock.calls.find((c) => String(c[0]).includes('UPDATE step_up_challenges'))
    expect(String(update?.[0])).toContain('rejected_at = now()')
    expect(update?.[1]).toEqual(['challenge-1', 'z1', 'admin:op-1', 'wrong amount'])
    const outbox = client.query.mock.calls.find((c) => String(c[0]).includes('INSERT INTO event_outbox'))
    const payload = JSON.parse(String((outbox?.[1] as unknown[])[2]))
    expect(JSON.parse(payload.data)).toMatchObject({ decision: 'rejected', metadata_json: { reason: 'wrong amount' } })
  })

  it('attributes a console decision through the bound account profile id', async () => {
    const { app, db } = buildRouteApp(
      stepUpChallengesRoutes,
      { prefix: '/v1' },
      {
        ...OPERATOR,
        account: { id: 'acct-1' },
      },
    )
    const client = txClient((sql) => {
      if (sql.includes('UPDATE step_up_challenges')) {
        return { rows: [{ ...DECIDED_ROW, approver_subject_id: 'console:acct-1' }] }
      }
      return undefined
    })
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/step-up-challenges/challenge-1/approve', payload: {} })

    expect(res.statusCode).toBe(200)
    const update = client.query.mock.calls.find((c) => String(c[0]).includes('UPDATE step_up_challenges'))
    expect(update?.[1]?.[2]).toBe('console:acct-1')
  })

  it('returns 404 when no such challenge exists in the zone', async () => {
    const { app, db } = buildRouteApp(stepUpChallengesRoutes, { prefix: '/v1' }, OPERATOR)
    const client = txClient(() => undefined)
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/step-up-challenges/challenge-1/approve', payload: {} })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'challenge_not_found' })
  })

  it('refuses the operator plane a subject-only hold', async () => {
    const { app, db } = buildRouteApp(stepUpChallengesRoutes, { prefix: '/v1' }, OPERATOR)
    const client = txClient((sql) => {
      if (sql.includes('SELECT approver_class')) return { rows: [{ approver_class: 'subject', state: 'pending' }] }
      return undefined
    })
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/step-up-challenges/challenge-1/approve', payload: {} })

    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'subject_approval_required' })
  })

  it('returns 409 with the settled state when the hold is no longer decidable', async () => {
    const { app, db } = buildRouteApp(stepUpChallengesRoutes, { prefix: '/v1' }, OPERATOR)
    const client = txClient((sql) => {
      if (sql.includes('SELECT approver_class')) return { rows: [{ approver_class: 'operator', state: 'expired' }] }
      return undefined
    })
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/step-up-challenges/challenge-1/reject', payload: {} })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'challenge_not_decidable', state: 'expired' })
  })

  it('refuses an oversized rationale', async () => {
    const { app, db } = buildRouteApp(stepUpChallengesRoutes, { prefix: '/v1' }, OPERATOR)
    db.connect.mockResolvedValueOnce(txClient(() => undefined))

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/step-up-challenges/challenge-1/reject',
      payload: { reason: 'x'.repeat(501) },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_body' })
  })
})
