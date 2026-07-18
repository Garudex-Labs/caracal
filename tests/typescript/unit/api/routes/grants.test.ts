// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Delegated grant route unit tests for same-zone references and scope boundaries.

import { afterEach, describe, it, expect, vi } from 'vitest'
import { grantsRoutes } from '../../../../../apps/api/src/routes/grants.js'
import { buildRouteApp } from '../../../../shared/test-utils/typescript/fastify.js'

const grantBody = {
  application_id: 'app-1',
  user_id: 'user-1',
  resource_id: 'res-1',
  scopes: ['read'],
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('POST /v1/zones/:zoneId/grants', () => {
  it('rejects application references outside the zone', async () => {
    const { app, db } = buildRouteApp(grantsRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ application_exists: false, resource_scopes: ['read'] }] })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/grants', payload: grantBody })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'application_not_found' })
  })

  it('rejects resource references outside the zone', async () => {
    const { app, db } = buildRouteApp(grantsRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ application_exists: true, resource_scopes: null }] })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/grants', payload: grantBody })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'resource_not_found' })
  })

  it('rejects grant scopes outside the resource scope set', async () => {
    const { app, db } = buildRouteApp(grantsRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ application_exists: true, resource_scopes: ['read'] }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/grants',
      payload: { ...grantBody, scopes: ['write'] },
    })

    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'grant_scopes_exceed_resource' })
  })

  it('refuses a delegated grant on the control resource', async () => {
    const { app, db } = buildRouteApp(grantsRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }).mockResolvedValueOnce({
      rows: [{ application_exists: true, resource_scopes: ['control:agent:read'], resource_identifier: 'caracal-control' }],
    })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/grants',
      payload: { ...grantBody, scopes: ['control:agent:read'] },
    })

    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'control_resource_not_grantable' })
  })

  it('creates a grant with same-zone references and bounded scopes', async () => {
    const { app, db } = buildRouteApp(grantsRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ application_exists: true, resource_scopes: ['read', 'write'], resource_identifier: 'urn:res-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'grant-1', zone_id: 'z1', scopes: ['read'] }] })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/grants', payload: grantBody })

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'grant-1', scopes: ['read'] })
  })
})

describe('DELETE /v1/zones/:zoneId/grants/:id bounded session revocation', () => {
  it('returns 404 when the delegated grant is missing', async () => {
    const { app, db } = buildRouteApp(grantsRoutes)
    const client = { query: vi.fn(), release: vi.fn() }
    client.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
    db.connect.mockResolvedValue(client)

    await app.ready()
    const res = await app.inject({ method: 'DELETE', url: '/v1/zones/z1/grants/missing' })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'grant_not_found' })
  })

  it('pages session revocation in batches of 1000 and stops at the short batch', async () => {
    const { app, db } = buildRouteApp(grantsRoutes)

    const fullBatch = Array.from({ length: 1000 }, (_, i) => ({ id: `s${i}` }))
    const tailBatch = [{ id: 's-tail' }]

    const client = {
      query: vi.fn(),
      release: vi.fn(),
    }
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ user_id: 'user-1' }] })
      .mockResolvedValueOnce({ rows: fullBatch })

    for (let i = 0; i < fullBatch.length; i += 1) {
      client.query.mockResolvedValueOnce({ rows: [] })
    }

    client.query.mockResolvedValueOnce({ rows: tailBatch })
    client.query.mockResolvedValueOnce({ rows: [] })
    client.query.mockResolvedValueOnce({ rows: [] })

    db.connect.mockResolvedValue(client)

    await app.ready()
    const res = await app.inject({ method: 'DELETE', url: '/v1/zones/z1/grants/g1' })

    expect(res.statusCode).toBe(204)
    const updates = client.query.mock.calls.filter((c: unknown[]) => /UPDATE authority_records SET status = 'revoked'/.test(c[0] as string))
    expect(updates.length).toBe(2)
    const limitArg = (updates[0][1] as unknown[])[2]
    expect(limitArg).toBe(1000)
  })
})

describe('GET /v1/zones/:zoneId/grants list and detail', () => {
  it('lists grants for the zone', async () => {
    const { app, db } = buildRouteApp(grantsRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'grant-1' }, { id: 'grant-2' }] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/grants' })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.items).toHaveLength(2)
    expect(body.next_cursor).toBeNull()
  })

  it('applies grant list filters and enriches provider context', async () => {
    const { app, db } = buildRouteApp(grantsRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'grant-1', provider_id: 'provider-1' }] })

    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones/z1/grants?application_id=app-1&subject_id=user-1&resource_id=res-1&provider_id=provider-1&status=active&scopes=read,write',
    })

    expect(res.statusCode).toBe(200)
    const [sql, values] = db.query.mock.calls[0]
    expect(sql).toContain('LEFT JOIN applications')
    expect(sql).toContain('r.credential_provider_id = $5')
    expect(sql).toContain('dg.scopes @> $7::text[]')
    expect(values).toEqual(['z1', 'app-1', 'user-1', 'res-1', 'provider-1', 'active', ['read', 'write'], 200])
  })

  it('returns a single grant', async () => {
    const { app, db } = buildRouteApp(grantsRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'grant-1', status: 'active' }] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/grants/grant-1' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'grant-1' })
  })

  it('returns 404 for a missing grant', async () => {
    const { app, db } = buildRouteApp(grantsRoutes)
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/grants/missing' })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'grant_not_found' })
  })
})
