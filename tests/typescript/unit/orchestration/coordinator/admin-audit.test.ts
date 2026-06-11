// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Coordinator admin audit hook tests for mutating route attribution and skip paths.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import '../../../../shared/test-utils/typescript/coordinatorEnv.js'

const insertAdminAuditRecord = vi.fn()

vi.mock('@caracalai/admin-audit', () => ({
  MUTATING_METHODS: new Set(['POST', 'PUT', 'PATCH', 'DELETE']),
  insertAdminAuditRecord,
}))

const { registerAdminAuditHook } = await import('../../../../../apps/coordinator/src/admin-audit.js')

function makeDb() {
  const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() }
  return { connect: vi.fn().mockResolvedValue(client) } as never
}

function buildApp() {
  const app = Fastify({ logger: false })
  app.addHook('preHandler', async (req) => {
    ;(req as unknown as { caracalAuth: unknown }).caracalAuth = {
      zoneId: 'zone-1',
      scopes: ['coordinator.admin'],
      subject: 'operator-1',
      clientId: 'app-1',
    }
  })
  app.post('/zones/:zoneId/agents/:id/suspend', async () => ({ ok: true }))
  app.get('/zones/:zoneId/agents/:id', async () => ({ ok: true }))
  app.get('/health', async () => ({ ok: true }))
  registerAdminAuditHook(app, makeDb())
  return app
}

beforeEach(() => {
  insertAdminAuditRecord.mockReset()
})

describe('coordinator admin audit hook', () => {
  it('records mutating calls with zone and entity attribution', async () => {
    insertAdminAuditRecord.mockResolvedValueOnce(undefined)
    const app = buildApp()
    await app.ready()

    const res = await app.inject({ method: 'POST', url: '/zones/zone-1/agents/agent-1/suspend?reason=test' })

    expect(res.statusCode).toBe(200)
    expect(insertAdminAuditRecord).toHaveBeenCalledTimes(1)
    expect(insertAdminAuditRecord.mock.calls[0][1]).toMatchObject({
      actorId: 'operator-1',
      actorName: 'app-1',
      method: 'POST',
      zoneId: 'zone-1',
      entityType: 'agents',
      entityId: 'agent-1',
      statusCode: 200,
    })
  })

  it('skips successful read and health routes', async () => {
    const app = buildApp()
    await app.ready()

    await app.inject({ method: 'GET', url: '/zones/zone-1/agents/agent-1' })
    await app.inject({ method: 'GET', url: '/health' })

    expect(insertAdminAuditRecord).not.toHaveBeenCalled()
  })

  it('does not fail the request when audit persistence fails', async () => {
    insertAdminAuditRecord.mockRejectedValueOnce(new Error('audit down'))
    const app = buildApp()
    await app.ready()

    const res = await app.inject({ method: 'POST', url: '/zones/zone-1/agents/agent-1/suspend' })

    expect(res.statusCode).toBe(200)
    expect(insertAdminAuditRecord).toHaveBeenCalledTimes(1)
  })
})
