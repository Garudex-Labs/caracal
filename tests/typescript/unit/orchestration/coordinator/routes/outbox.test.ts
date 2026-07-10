// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Coordinator dead-outbox recovery route tests.

import { describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import '../../../../../shared/test-utils/typescript/coordinatorEnv.js'
import { outboxRoutes } from '../../../../../../apps/coordinator/src/routes/outbox.js'

const outboxId = '0198fef0-2a85-7d77-b747-6dfad4bd8888'
const zoneId = '0198fef0-2a85-7d77-b747-6dfad4bd7777'

function buildApp(scopes = ['coordinator.admin']) {
  const app = Fastify({ logger: false })
  const db = { query: vi.fn() }
  app.decorate('db', db as never)
  app.decorate('redis', {} as never)
  app.addHook('preHandler', async (req) => {
    ;(req as unknown as { caracalAuth: unknown }).caracalAuth = {
      zoneId: 'zone-1',
      scopes,
      subject: 'operator-1',
      clientId: 'control',
    }
  })
  app.register(outboxRoutes, { prefix: '/v1' })
  return { app, db }
}

describe('POST /v1/zones/:zoneId/outbox/:id/requeue', () => {
  it('atomically requeues a dead Coordinator outbox row', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [{ id: outboxId }] })
    await app.ready()

    const response = await app.inject({ method: 'POST', url: `/v1/zones/${zoneId}/outbox/${outboxId}/requeue` })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ id: outboxId, status: 'pending' })
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("status = 'pending'"), [outboxId, zoneId])
    expect(db.query.mock.calls[0][0]).toContain("status = 'dead'")
  })

  it('requires Coordinator admin authority', async () => {
    const { app, db } = buildApp([])
    await app.ready()

    const response = await app.inject({ method: 'POST', url: `/v1/zones/${zoneId}/outbox/${outboxId}/requeue` })

    expect(response.statusCode).toBe(403)
    expect(db.query).not.toHaveBeenCalled()
  })

  it('does not requeue a row that is not dead', async () => {
    const { app, db } = buildApp()
    db.query.mockResolvedValueOnce({ rows: [] })
    await app.ready()

    const response = await app.inject({ method: 'POST', url: `/v1/zones/${zoneId}/outbox/${outboxId}/requeue` })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: 'dead_outbox_not_found' })
  })
})
