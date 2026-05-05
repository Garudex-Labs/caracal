// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Zone event route unit tests for audit and session read models.

import { describe, it, expect } from 'vitest'
import { zoneEventsRoutes } from '../../../../../apps/api/src/routes/zone-events.js'
import { buildRouteApp } from '../../../../shared/test-utils/typescript/fastify.js'

describe('GET /v1/zones/:zoneId/audit', () => {
  it('returns zone-scoped audit events', async () => {
    const { app, db } = buildRouteApp(zoneEventsRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'audit-1', zone_id: 'z1', decision: 'deny' }] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/audit' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual([{ id: 'audit-1', zone_id: 'z1', decision: 'deny' }])
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('zone_id = $1'), ['z1', 100])
  })

  it('applies filter parameters', async () => {
    const { app, db } = buildRouteApp(zoneEventsRoutes)
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones/z1/audit?decision=deny&request_id=req-9&limit=50',
    })

    expect(res.statusCode).toBe(200)
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('decision = $'),
      ['z1', 'req-9', 'deny', 50],
    )
  })
})

describe('GET /v1/zones/:zoneId/audit/by-request/:requestId', () => {
  it('returns full audit detail with diagnostics', async () => {
    const { app, db } = buildRouteApp(zoneEventsRoutes)
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'a1', request_id: 'r1', decision: 'deny', determining_policies_json: [], diagnostics_json: [{ reason: 'no_active_policy_set' }] }],
    })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/audit/by-request/r1' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)[0].diagnostics_json[0].reason).toBe('no_active_policy_set')
  })

  it('404s when no rows', async () => {
    const { app, db } = buildRouteApp(zoneEventsRoutes)
    db.query.mockResolvedValueOnce({ rows: [] })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/audit/by-request/missing' })
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /v1/zones/:zoneId/sessions', () => {
  it('returns zone-scoped sessions', async () => {
    const { app, db } = buildRouteApp(zoneEventsRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'session-1', zone_id: 'z1', status: 'active' }] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/sessions' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual([{ id: 'session-1', zone_id: 'z1', status: 'active' }])
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('zone_id = $1'), ['z1', 100])
  })
})