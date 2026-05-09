// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Local bootstrap route unit tests for idempotent provisioning and transaction behavior.

import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { localBootstrapRoutes } from '../../../../../apps/api/src/routes/local-bootstrap.js'
import { buildRouteApp } from '../../../../shared/test-utils/typescript/fastify.js'

const TEST_ZONE_KEK = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20'
beforeAll(() => { vi.stubEnv('ZONE_KEK', TEST_ZONE_KEK) })
afterAll(() => { vi.unstubAllEnvs() })

describe('POST /v1/local/bootstrap', () => {
  it('returns existing bootstrap metadata without rotating when force is false', async () => {
    const { app, db } = buildRouteApp(localBootstrapRoutes)
    db.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'zone1' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ dek_id: 'local' }] })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/local/bootstrap', payload: {} })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({
      zone_id: 'zone1',
      app_id: 'app1',
      app_client_id: 'zone1:app1',
      app_client_secret: null,
      rotated: false,
    })
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('refuses to overwrite a zone whose signing key was sealed under a real KEK', async () => {
    const { app, db } = buildRouteApp(localBootstrapRoutes)
    db.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'zone1' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ dek_id: 'kek-prod-1' }] })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/local/bootstrap', payload: { force: true } })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'zone_not_local_bootstrap' })
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('provisions local data in one transaction', async () => {
    const { app, db } = buildRouteApp(localBootstrapRoutes)
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() }
    db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] })
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/local/bootstrap', payload: { force: true } })
    const body = JSON.parse(res.body) as { app_client_secret: string }

    expect(res.statusCode).toBe(201)
    expect(body.app_client_secret).toHaveLength(48)
    expect(client.query.mock.calls[0][0]).toBe('BEGIN')
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('COMMIT')
    expect(client.query.mock.calls.some((call) => String(call[0]).includes('INSERT INTO secrets'))).toBe(true)
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it('rolls back and releases the connection on transaction failure', async () => {
    const { app, db } = buildRouteApp(localBootstrapRoutes)
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockRejectedValueOnce(new Error('insert failed'))
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] })
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/local/bootstrap', payload: { force: true } })

    expect(res.statusCode).toBe(500)
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
    expect(client.release).toHaveBeenCalledTimes(1)
  })
})