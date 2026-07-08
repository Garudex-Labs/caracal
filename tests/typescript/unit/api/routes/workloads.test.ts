// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Workload route unit tests for launcher identity lifecycle and binding validation.

import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import { SecretBackendError, workloadSecretRef } from '@caracalai/server-core'
import type { DB } from '../../../../../apps/api/src/db.js'
import '../../../../../apps/api/src/fastify-augmentation.js'
import { workloadsRoutes } from '../../../../../apps/api/src/routes/workloads.js'

function buildApp() {
  const app = Fastify({ logger: false })
  const clientQuery = vi.fn()
  const db = {
    query: vi.fn(),
    connect: vi.fn().mockResolvedValue({
      query: clientQuery,
      release: vi.fn(),
    }),
  }
  const secretValues = new Map<string, Buffer>()
  const secrets = {
    kind: 'builtin' as const,
    values: secretValues,
    put: vi.fn(async (ref: string, value: Buffer) => {
      secretValues.set(ref, Buffer.from(value))
    }),
    get: vi.fn(async (ref: string) => {
      const value = secretValues.get(ref)
      return value ? Buffer.from(value) : null
    }),
    delete: vi.fn(async (ref: string) => {
      secretValues.delete(ref)
    }),
  }
  app.decorate('db', db as unknown as DB)
  app.decorate('secrets', secrets as never)
  app.addHook('preHandler', async (req) => {
    ;(req as unknown as { actor: unknown }).actor = {
      id: 'actor-1',
      name: 'operator',
      scope: 'zone',
      capability: 'write',
      zoneId: 'z1',
      createdBy: 'admin:op',
    }
  })
  app.register(workloadsRoutes, { prefix: '/v1' })
  return { app, db, clientQuery, secrets }
}

const workloadRow = {
  id: 'wl-1',
  zone_id: 'z1',
  name: 'Son of Anton',
  bindings: [],
  created_at: '2026-06-01T12:00:00.000Z',
  updated_by: null,
  updated_at: null,
}

describe('POST /v1/zones/:zoneId/workloads', () => {
  it('returns 404 when creating in a missing zone', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/workloads', payload: { name: 'Son of Anton' } })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'zone_not_found' })
  })

  it('creates a workload and stores the secret in custody', async () => {
    const { app, db, clientQuery, secrets } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    db.query.mockResolvedValueOnce({ rows: [] })
    clientQuery.mockImplementation((sql: string) => {
      if (String(sql).includes('INSERT INTO workloads')) return Promise.resolve({ rows: [workloadRow] })
      return Promise.resolve({ rows: [] })
    })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/workloads', payload: { name: 'Son of Anton' } })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body).toMatchObject({ id: 'wl-1', secret: expect.stringMatching(/^ws_[A-Za-z0-9_-]+$/) })
    const insertCall = clientQuery.mock.calls.find((call) => String(call[0]).includes('INSERT INTO workloads'))
    expect((insertCall?.[1] as unknown[])[3]).toMatch(/^argon2id\$/)
    expect(secrets.put).toHaveBeenCalledTimes(1)
    const [ref, stored] = secrets.put.mock.calls[0]
    expect(ref).toMatch(/^zones\/z1\/workloads\/[0-9a-f-]+\/secret$/)
    expect(stored.toString()).toBe(body.secret)
  })

  it('rolls the creation back when the secret backend rejects the custody write', async () => {
    const { app, db, clientQuery, secrets } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    db.query.mockResolvedValueOnce({ rows: [] })
    clientQuery.mockImplementation((sql: string) => {
      if (String(sql).includes('INSERT INTO workloads')) return Promise.resolve({ rows: [workloadRow] })
      return Promise.resolve({ rows: [] })
    })
    secrets.put.mockRejectedValueOnce(new SecretBackendError('secret backend write failed with status 503'))

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/workloads', payload: { name: 'Son of Anton' } })

    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'secret_backend_unavailable' })
    expect(clientQuery).toHaveBeenCalledWith('ROLLBACK')
    expect(secrets.values.size).toBe(0)
  })

  it('rejects a duplicate workload name', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/workloads', payload: { name: 'Son of Anton' } })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'workload_name_taken' })
  })

  it('rejects a whitespace-only workload name', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/workloads', payload: { name: '   ' } })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_workload' })
  })
})

describe('GET /v1/zones/:zoneId/workloads', () => {
  it('lists workloads without secret material', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [workloadRow] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/workloads' })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.items).toHaveLength(1)
    expect(body.next_cursor).toBeNull()
    expect(body.items[0]).not.toHaveProperty('secret_hash')
    expect(db.query.mock.calls[0][0]).not.toContain('secret_hash')
  })
})

describe('GET /v1/zones/:zoneId/workloads/:id', () => {
  it('returns the workload', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [workloadRow] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/workloads/wl-1' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'wl-1', name: 'Son of Anton' })
  })

  it('returns 404 for a missing workload', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/workloads/missing' })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'workload_not_found' })
  })
})

describe('PUT /v1/zones/:zoneId/workloads/:id', () => {
  it('stores normalized bindings with an authorship stamp', async () => {
    const { app, db } = buildApp()
    const stored = [
      { env: 'PIPERNET_TOKEN', resource: 'resource://pipernet', scopes: ['pipernet:read'] },
      { env: 'HOOLIBOX_TOKEN', resource: 'resource://hoolibox', optional: true, on_failure: 'warn' },
    ]
    db.query.mockResolvedValueOnce({ rows: [{ ...workloadRow, bindings: stored, updated_by: 'admin:op' }] })

    await app.ready()
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/zones/z1/workloads/wl-1',
      payload: {
        bindings: [
          { env: 'PIPERNET_TOKEN', resource: 'resource://pipernet', scopes: ['pipernet:read'] },
          { env: 'HOOLIBOX_TOKEN', resource: 'resource://hoolibox', optional: true, on_failure: 'warn' },
        ],
      },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'wl-1', bindings: stored })
    const updateValues = db.query.mock.calls[0][1] as unknown[]
    expect(JSON.parse(updateValues[2] as string)).toEqual(stored)
    expect(updateValues[3]).toBe('admin:actor-1')
  })

  it('rejects blocked env names', async () => {
    const { app, db } = buildApp()

    await app.ready()
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/zones/z1/workloads/wl-1',
      payload: { bindings: [{ env: 'LD_PRELOAD', resource: 'resource://pipernet' }] },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_credential_env', details: { env: 'LD_PRELOAD' } })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('rejects duplicate env names', async () => {
    const { app, db } = buildApp()

    await app.ready()
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/zones/z1/workloads/wl-1',
      payload: {
        bindings: [
          { env: 'PIPERNET_TOKEN', resource: 'resource://pipernet' },
          { env: 'PIPERNET_TOKEN', resource: 'resource://hoolibox' },
        ],
      },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'duplicate_credential_env', details: { env: 'PIPERNET_TOKEN' } })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('rejects a rename to a taken name', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const res = await app.inject({ method: 'PUT', url: '/v1/zones/z1/workloads/wl-1', payload: { name: 'Fiona' } })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'workload_name_taken' })
  })

  it('rejects an empty update', async () => {
    const { app, db } = buildApp()

    await app.ready()
    const res = await app.inject({ method: 'PUT', url: '/v1/zones/z1/workloads/wl-1', payload: {} })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'no_fields' })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('returns 404 for a missing workload', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/zones/z1/workloads/missing',
      payload: { bindings: [{ env: 'PIPERNET_TOKEN', resource: 'resource://pipernet' }] },
    })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'workload_not_found' })
  })
})

describe('POST /v1/zones/:zoneId/workloads/:id/rotate-secret', () => {
  it('issues a fresh secret and replaces the custody copy', async () => {
    const { app, clientQuery, secrets } = buildApp()
    secrets.values.set(workloadSecretRef('z1', 'wl-1'), Buffer.from('ws_previous'))
    clientQuery.mockImplementation((sql: string) => {
      if (String(sql).includes('UPDATE workloads')) return Promise.resolve({ rows: [workloadRow] })
      return Promise.resolve({ rows: [] })
    })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/workloads/wl-1/rotate-secret' })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body).toMatchObject({ id: 'wl-1', secret: expect.stringMatching(/^ws_[A-Za-z0-9_-]+$/) })
    expect(secrets.values.get(workloadSecretRef('z1', 'wl-1'))?.toString()).toBe(body.secret)
  })

  it('returns 404 for a missing workload', async () => {
    const { app, clientQuery, secrets } = buildApp()
    clientQuery.mockResolvedValue({ rows: [] })

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/workloads/missing/rotate-secret' })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'workload_not_found' })
    expect(secrets.put).not.toHaveBeenCalled()
  })
})

describe('GET /v1/zones/:zoneId/workloads/:id/secret', () => {
  it('reveals the custody copy and records the reveal in the audit outbox', async () => {
    const { app, db, clientQuery, secrets } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ name: 'Son of Anton' }] })
    secrets.values.set(workloadSecretRef('z1', 'wl-1'), Buffer.from('ws_stored'))
    clientQuery.mockResolvedValue({ rows: [] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/workloads/wl-1/secret' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ secret: 'ws_stored' })
    const outboxCall = clientQuery.mock.calls.find((call) => String(call[0]).includes('INSERT INTO event_outbox'))
    expect(outboxCall).toBeDefined()
    expect(String(outboxCall?.[1]?.[2])).toContain('credential_revealed')
  })

  it('returns 404 when the workload predates credential custody', async () => {
    const { app, db, clientQuery } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ name: 'Son of Anton' }] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/workloads/wl-1/secret' })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'workload_secret_not_stored' })
    expect(clientQuery).not.toHaveBeenCalled()
  })

  it('returns 404 for a missing workload', async () => {
    const { app, db, secrets } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/workloads/missing/secret' })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'workload_not_found' })
    expect(secrets.get).not.toHaveBeenCalled()
  })

  it('returns 502 when the secret backend is unavailable', async () => {
    const { app, db, secrets } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ name: 'Son of Anton' }] })
    secrets.get.mockRejectedValueOnce(new SecretBackendError('secret backend read failed with status 503'))

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/workloads/wl-1/secret' })

    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'secret_backend_unavailable' })
  })
})

describe('DELETE /v1/zones/:zoneId/workloads/:id', () => {
  it('hard-deletes the workload and its custody copy', async () => {
    const { app, db, secrets } = buildApp()
    secrets.values.set(workloadSecretRef('z1', 'wl-1'), Buffer.from('ws_stored'))
    db.query.mockResolvedValueOnce({ rowCount: 1 })

    await app.ready()
    const res = await app.inject({ method: 'DELETE', url: '/v1/zones/z1/workloads/wl-1' })

    expect(res.statusCode).toBe(204)
    expect(db.query.mock.calls[0][0]).toContain('DELETE FROM workloads')
    expect(secrets.delete).toHaveBeenCalledWith(workloadSecretRef('z1', 'wl-1'))
    expect(secrets.values.size).toBe(0)
  })

  it('deletes even when the custody delete fails', async () => {
    const { app, db, secrets } = buildApp()
    db.query.mockResolvedValueOnce({ rowCount: 1 })
    secrets.delete.mockRejectedValueOnce(new SecretBackendError('secret backend delete failed with status 503'))

    await app.ready()
    const res = await app.inject({ method: 'DELETE', url: '/v1/zones/z1/workloads/wl-1' })

    expect(res.statusCode).toBe(204)
  })

  it('returns 404 for a missing workload', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rowCount: 0 })

    await app.ready()
    const res = await app.inject({ method: 'DELETE', url: '/v1/zones/z1/workloads/missing' })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'workload_not_found' })
  })
})
