// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Step-up challenge route unit tests for lookup and satisfaction guards.

import { describe, it, expect } from 'vitest'
import { stepUpChallengesRoutes } from '../../../../../apps/api/src/routes/step-up-challenges.js'
import { buildRouteApp } from '../../../../shared/test-utils/typescript/fastify.js'

describe('GET /v1/zones/:zoneId/step-up-challenges', () => {
  it('lists challenges with keyset pagination', async () => {
    const { app, db } = buildRouteApp(stepUpChallengesRoutes)
    db.query.mockResolvedValueOnce({
      rows: [
        { id: 'challenge-2', zone_id: 'z1', created_at: '2026-01-02T00:00:00.000Z' },
        { id: 'challenge-1', zone_id: 'z1', created_at: '2026-01-01T00:00:00.000Z' },
      ],
    })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/step-up-challenges?limit=1' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toHaveLength(2)
    expect(res.headers.link).toContain('cursor=')
    expect(db.query.mock.calls[0][1]).toEqual(['z1', 1])
  })
})

describe('GET /v1/zones/:zoneId/step-up-challenges/:id', () => {
  it('returns a zone-scoped challenge', async () => {
    const { app, db } = buildRouteApp(stepUpChallengesRoutes)
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'challenge-1', zone_id: 'z1', challenge_type: 'step_up' }],
    })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/step-up-challenges/challenge-1' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'challenge-1', challenge_type: 'step_up' })
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

describe('POST /v1/zones/:zoneId/step-up-challenges/:id/satisfy', () => {
  it('binds the approver to the authenticated actor', async () => {
    const { app, db } = buildRouteApp(stepUpChallengesRoutes, { prefix: '/v1' }, { actor: { id: 'op-1', name: 'operator', scope: 'global', zoneId: null } })
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'challenge-1', satisfied_at: '2026-05-05T00:00:00.000Z', approver_subject_id: 'admin:op-1' }],
    })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/step-up-challenges/challenge-1/satisfy' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'challenge-1', approver_subject_id: 'admin:op-1' })
    expect(db.query.mock.calls[0][1]).toEqual(['challenge-1', 'z1', 'admin:op-1'])
  })

  it('returns 409 when challenge is expired, completed, cross-zone, or self-approved', async () => {
    const { app, db } = buildRouteApp(stepUpChallengesRoutes, { prefix: '/v1' }, { actor: { id: 'op-1', name: 'operator', scope: 'global', zoneId: null } })
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/step-up-challenges/challenge-1/satisfy' })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'challenge_not_satisfiable' })
  })
})
