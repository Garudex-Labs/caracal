// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Zone overview route tests cover the aggregated dashboard read model.

import { describe, it, expect } from 'vitest'
import { zoneOverviewRoutes } from '../../../../../apps/api/src/routes/zone-overview.js'
import { buildRouteApp } from '../../../../shared/test-utils/typescript/fastify.js'

function mockOverviewQueries(db: { query: ReturnType<typeof import('vitest').vi.fn> }) {
  db.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM applications')) {
      return { rows: [{ total: 3, expired: 1, expiring_soon: 2 }] }
    }
    if (sql.includes('FROM resources')) {
      return { rows: [{ total: 4, unenforced: 1 }] }
    }
    if (sql.includes('FROM providers')) {
      return { rows: [{ total: 2 }] }
    }
    if (sql.includes('FROM policy_sets')) {
      return { rows: [{ total: 2, enforcing: 1, active_name: 'PiperNet baseline v3' }] }
    }
    if (sql.includes('FROM authority_records')) {
      return { rows: [{ active: 5 }] }
    }
    if (sql.includes('occurred_at >= now()')) {
      return { rows: [{ allowed: 40, denied: 3 }] }
    }
    return {
      rows: [
        {
          id: 'audit-1',
          event_type: 'token_exchange',
          request_id: 'req-1',
          decision: 'allow',
          occurred_at: '2026-07-01T00:00:00.000Z',
          metadata_json: { resource: 'resource://pipernet', token: 'leak-me' },
        },
      ],
    }
  })
}

describe('GET /v1/zones/:zoneId/overview', () => {
  it('aggregates zone-scoped counts, decisions, and redacted recent events', async () => {
    const { app, db } = buildRouteApp(zoneOverviewRoutes)
    mockOverviewQueries(db)

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/overview' })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.zone_id).toBe('z1')
    expect(body.applications).toEqual({ total: 3, expired: 1, expiring_soon: 2 })
    expect(body.resources).toEqual({ total: 4, unenforced: 1 })
    expect(body.providers).toEqual({ total: 2 })
    expect(body.policy_sets).toEqual({ total: 2, enforcing: 1, active_name: 'PiperNet baseline v3' })
    expect(body.sessions).toEqual({ active: 5 })
    expect(body.decisions_24h).toEqual({ allowed: 40, denied: 3 })
    expect(body.recent_events).toHaveLength(1)
    expect(body.recent_events[0].metadata_json.token).toBe('[redacted]')
    expect(body.recent_events[0].metadata_json.resource).toBe('resource://pipernet')
  })

  it('scopes every aggregate to the requested zone', async () => {
    const { app, db } = buildRouteApp(zoneOverviewRoutes)
    mockOverviewQueries(db)

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/overview' })

    expect(res.statusCode).toBe(200)
    expect(db.query).toHaveBeenCalledTimes(7)
    for (const call of db.query.mock.calls) {
      expect(call[0]).toContain('zone_id = $1')
      expect(call[1]).toEqual(['z1'])
    }
  })

  it('excludes archived entities from inventory counts', async () => {
    const { app, db } = buildRouteApp(zoneOverviewRoutes)
    mockOverviewQueries(db)

    await app.ready()
    await app.inject({ method: 'GET', url: '/v1/zones/z1/overview' })

    const inventorySql = db.query.mock.calls
      .map((call) => call[0] as string)
      .filter((sql) => /FROM (applications|resources|providers|policy_sets)/.test(sql))
    expect(inventorySql).toHaveLength(4)
    for (const sql of inventorySql) {
      expect(sql).toContain('archived_at IS NULL')
    }
  })

  it('counts only live sessions and time-bounds decision counts', async () => {
    const { app, db } = buildRouteApp(zoneOverviewRoutes)
    mockOverviewQueries(db)

    await app.ready()
    await app.inject({ method: 'GET', url: '/v1/zones/z1/overview' })

    const sqls = db.query.mock.calls.map((call) => call[0] as string)
    expect(sqls.find((sql) => sql.includes('FROM authority_records'))).toContain("status = 'active' AND expires_at > now()")
    const decisions = sqls.find((sql) => sql.includes("decision = 'deny'"))
    expect(decisions).toContain("occurred_at >= now() - interval '24 hours'")
  })

  it('rejects an invalid zone id', async () => {
    const { app } = buildRouteApp(zoneOverviewRoutes)

    await app.ready()
    const res = await app.inject({ method: 'GET', url: `/v1/zones/${encodeURIComponent('z 1!')}/overview` })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_params' })
  })
})
