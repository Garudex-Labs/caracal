// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Subject route unit tests for the per-subject aggregation and investigation overview.

import { describe, it, expect } from 'vitest'

const { subjectsRoutes } = await import('../../../../../apps/api/src/routes/subjects.js')
const { buildRouteApp } = await import('../../../../shared/test-utils/typescript/fastify.js')

const SUBJECT_ROW = {
  subject_id: 'auth0|507f1f77bcf86cd799439011',
  federated: true,
  application_name: null,
  total_sessions: 12,
  active_sessions: 2,
  revoked_sessions: 1,
  first_seen: '2026-05-01T00:00:00.000Z',
  last_seen: '2026-07-01T00:00:00.000Z',
  last_revoked_at: null,
  issuer: 'https://login.hooli.example',
}

describe('GET /v1/zones/:zoneId/subjects', () => {
  it('aggregates one row per subject with identity resolution', async () => {
    const { app, db } = buildRouteApp(subjectsRoutes)
    db.query.mockResolvedValueOnce({ rows: [SUBJECT_ROW] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/subjects' })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.items).toHaveLength(1)
    expect(body.items[0].issuer).toBe('https://login.hooli.example')
    const sql = String(db.query.mock.calls[0][0])
    expect(sql).toContain('GROUP BY s.subject_id')
    expect(sql).toContain('LEFT JOIN applications')
  })

  it('filters by kind and search with parameterized values', async () => {
    const { app, db } = buildRouteApp(subjectsRoutes)
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones/z1/subjects?kind=user&search=richard',
    })

    expect(res.statusCode).toBe(200)
    const [sql, values] = db.query.mock.calls[0]
    expect(String(sql)).toContain("BOOL_OR(s.session_type = 'user')")
    expect(values).toContain('%richard%')
    expect(String(sql)).not.toContain('richard')
  })

  it('rejects a malformed cursor', async () => {
    const { app, db } = buildRouteApp(subjectsRoutes)
    db.query.mockResolvedValue({ rows: [] })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/subjects?cursor=not-a-cursor' })
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /v1/zones/:zoneId/subjects/overview', () => {
  it('bundles identity, governed activity, approvals, and connections', async () => {
    const { app, db } = buildRouteApp(subjectsRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [SUBJECT_ROW] })
      .mockResolvedValueOnce({ rows: [{ active: 1, total: 4 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'ag-1',
            application_id: 'app-1',
            application_name: 'Son of Anton',
            lifecycle: 'task',
            status: 'active',
            spawned_at: '2026-07-01T00:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ pending: 1, total: 3 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'pc-1',
            provider_id: 'prov-1',
            provider_name: 'Hooli OIDC',
            status: 'active',
            expires_at: null,
            created_at: '2026-06-01T00:00:00.000Z',
          },
        ],
      })

    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: `/v1/zones/z1/subjects/overview?subject_id=${encodeURIComponent(SUBJECT_ROW.subject_id)}`,
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.subject.subject_id).toBe(SUBJECT_ROW.subject_id)
    expect(body.governed).toMatchObject({ active: 1, total: 4 })
    expect(body.governed.recent[0].application_name).toBe('Son of Anton')
    expect(body.approvals).toEqual({ pending: 1, total: 3 })
    expect(body.connections[0].provider_name).toBe('Hooli OIDC')
  })

  it('404s an unknown subject and requires subject_id', async () => {
    const { app, db } = buildRouteApp(subjectsRoutes)
    db.query.mockResolvedValue({ rows: [] })
    await app.ready()
    const missing = await app.inject({
      method: 'GET',
      url: '/v1/zones/z1/subjects/overview?subject_id=ghost',
    })
    expect(missing.statusCode).toBe(404)
    const noParam = await app.inject({ method: 'GET', url: '/v1/zones/z1/subjects/overview' })
    expect(noParam.statusCode).toBe(400)
  })
})
