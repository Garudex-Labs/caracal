// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Admin token management route unit tests for global-only minting, listing, and revocation.

import { describe, it, expect } from 'vitest'
import { adminTokensRoutes } from '../../../../../apps/api/src/routes/admin-tokens.js'
import { buildRouteApp } from '../../../../shared/test-utils/typescript/fastify.js'

const globalActor = { id: 'op-1', name: 'operator', scope: 'global', zoneId: null }
const zoneActor = { id: 'op-z', name: 'zone-op', scope: 'zone', zoneId: 'z1' }

describe('POST /v1/admin-tokens', () => {
  it('mints a global-scoped token and returns the plaintext once', async () => {
    const { app, db } = buildRouteApp(adminTokensRoutes, { prefix: '/v1' }, { actor: globalActor })
    db.query.mockResolvedValueOnce({
      rows: [{ id: 't1', name: 'ci', scope: 'global', zone_id: null, created_by: 'admin:op-1', created_at: '2026-01-01T00:00:00.000Z' }],
    })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/admin-tokens', payload: { name: 'ci', scope: 'global' } })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.token).toMatch(/^cat_/)
    expect(body).toMatchObject({ id: 't1', scope: 'global', zone_id: null })
    const insertCols = db.query.mock.calls[0][1] as unknown[]
    expect(insertCols[5]).toBeNull()
  })

  it('mints a zone-scoped token after verifying the zone exists', async () => {
    const { app, db } = buildRouteApp(adminTokensRoutes, { prefix: '/v1' }, { actor: globalActor })
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    db.query.mockResolvedValueOnce({
      rows: [
        { id: 't2', name: 'deployer', scope: 'zone', zone_id: 'z1', created_by: 'admin:op-1', created_at: '2026-01-01T00:00:00.000Z' },
      ],
    })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/admin-tokens', payload: { name: 'deployer', scope: 'zone', zone_id: 'z1' } })

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ scope: 'zone', zone_id: 'z1' })
    expect(db.query.mock.calls[1][1][5]).toBe('z1')
  })

  it('rejects a zone-scoped actor with 403', async () => {
    const { app, db } = buildRouteApp(adminTokensRoutes, { prefix: '/v1' }, { actor: zoneActor })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/admin-tokens', payload: { name: 'x', scope: 'global' } })

    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'admin_token_management_requires_global' })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('returns 404 when the target zone does not exist', async () => {
    const { app, db } = buildRouteApp(adminTokensRoutes, { prefix: '/v1' }, { actor: globalActor })
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/admin-tokens', payload: { name: 'x', scope: 'zone', zone_id: 'missing' } })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'zone_not_found' })
  })

  it('rejects zone_id on a global-scoped mint', async () => {
    const { app } = buildRouteApp(adminTokensRoutes, { prefix: '/v1' }, { actor: globalActor })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/admin-tokens', payload: { name: 'x', scope: 'global', zone_id: 'z1' } })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'zone_id_not_allowed_for_global' })
  })

  it('requires zone_id when scope is zone', async () => {
    const { app } = buildRouteApp(adminTokensRoutes, { prefix: '/v1' }, { actor: globalActor })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/admin-tokens', payload: { name: 'x', scope: 'zone' } })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'zone_id_required' })
  })
})

describe('GET /v1/admin-tokens', () => {
  it('lists tokens without exposing secret material', async () => {
    const { app, db } = buildRouteApp(adminTokensRoutes, { prefix: '/v1' }, { actor: globalActor })
    db.query.mockResolvedValueOnce({
      rows: [{ id: 't1', name: 'ci', scope: 'global', zone_id: null, created_by: 'admin:op-1', created_at: '2026-01-01T00:00:00.000Z' }],
    })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/admin-tokens?limit=10' })

    expect(res.statusCode).toBe(200)
    const sql = db.query.mock.calls[0][0] as string
    expect(sql).not.toContain('token_hash')
    expect(sql).not.toContain('token_sha256')
  })

  it('rejects a zone-scoped actor with 403', async () => {
    const { app, db } = buildRouteApp(adminTokensRoutes, { prefix: '/v1' }, { actor: zoneActor })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/admin-tokens' })

    expect(res.statusCode).toBe(403)
    expect(db.query).not.toHaveBeenCalled()
  })
})

describe('DELETE /v1/admin-tokens/:id', () => {
  it('revokes an active token', async () => {
    const { app, db } = buildRouteApp(adminTokensRoutes, { prefix: '/v1' }, { actor: globalActor })
    db.query.mockResolvedValueOnce({ rows: [{ id: 't1' }] })

    await app.ready()
    const res = await app.inject({ method: 'DELETE', url: '/v1/admin-tokens/t1' })

    expect(res.statusCode).toBe(204)
  })

  it('returns 404 when the token is missing or already revoked', async () => {
    const { app, db } = buildRouteApp(adminTokensRoutes, { prefix: '/v1' }, { actor: globalActor })
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({ method: 'DELETE', url: '/v1/admin-tokens/t1' })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'admin_token_not_found' })
  })

  it('rejects a zone-scoped actor with 403', async () => {
    const { app, db } = buildRouteApp(adminTokensRoutes, { prefix: '/v1' }, { actor: zoneActor })

    await app.ready()
    const res = await app.inject({ method: 'DELETE', url: '/v1/admin-tokens/t1' })

    expect(res.statusCode).toBe(403)
    expect(db.query).not.toHaveBeenCalled()
  })
})
