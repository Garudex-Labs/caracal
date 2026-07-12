// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Language-neutral mandate verification route tests.

import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import '../../../../../shared/test-utils/typescript/coordinatorEnv.js'
import { verifyRoutes } from '../../../../../../apps/coordinator/src/routes/verify.js'

function buildApp(limit = 1) {
  const app = Fastify({ logger: false })
  app.decorate('db', {} as never)
  app.decorate('redis', {
    incr: vi.fn().mockResolvedValue(limit),
    expire: vi.fn().mockResolvedValue(1),
  } as never)
  app.register(verifyRoutes)
  return app
}

describe('POST /v1/verify', () => {
  it('accepts the canonical require_session verifier option', async () => {
    const app = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/verify',
      payload: { token: 'not-a-jwt', zone_id: 'z1', require_session: true },
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects unknown verifier options', async () => {
    const app = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/verify',
      payload: { token: 'not-a-jwt', zone_id: 'z1', require_agent: true },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rate-limits verification', async () => {
    const app = buildApp(10_000)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/verify',
      payload: { token: 'not-a-jwt', zone_id: 'z1' },
    })
    expect(res.statusCode).toBe(429)
    expect(res.json()).toEqual({ valid: false, error: 'rate_limited' })
  })

  it('rejects a missing token', async () => {
    const app = buildApp()
    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/verify', payload: { zone_id: 'z1' } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ valid: false, error: 'missing_token' })
  })

  it('returns a structured error for a malformed token', async () => {
    const app = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/verify',
      payload: { token: 'not-a-jwt', zone_id: 'z1' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ valid: false, error: 'token_invalid' })
  })
})
