// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the control invoke route registration: gating, replay, per-subject limiting, and dispatch.

import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthError, type Authenticator, type Claims } from '../../../../../apps/api/src/control/auth.js'
import { registerInvokeRoute, type InvokeDeps } from '../../../../../apps/api/src/control/handler.js'
import { RateLimiter } from '../../../../../apps/api/src/control/ratelimit.js'
import type { EventSink } from '../../../../../apps/api/src/control/audit.js'
import type { Replay } from '../../../../../apps/api/src/control/replay.js'
import type { RedisClient } from '../../../../../apps/api/src/redis.js'
import type { DispatchContext } from '../../../../../packages/engine/src/dispatch.js'

const apps: { close(): Promise<void> }[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

function deps(verify: Authenticator['verify']): InvokeDeps {
  return {
    auth: { verify } as Authenticator,
    replay: { mark: vi.fn(), ping: vi.fn() } as unknown as Replay,
    rate: new RateLimiter(10, 60_000),
    sink: { emit: vi.fn(async () => {}) } as EventSink,
    ctx: { admin: {} } as DispatchContext,
    gate: { enabled: () => true },
    redis: {} as RedisClient,
    ipRateLimitPerMin: 0,
  }
}

function claims(overrides: Partial<Claims> = {}): Claims {
  return {
    sub: 'subject-1',
    jti: 'jti-1',
    exp: Math.floor(Date.now() / 1000) + 300,
    zoneId: 'z1',
    clientId: 'app-1',
    scope: 'control:agent:read control:agent:write',
    ...overrides,
  }
}

describe('registerInvokeRoute', () => {
  it('blocks invoke requests when the runtime endpoint gate is closed', async () => {
    const app = Fastify()
    apps.push(app)
    const verify = vi.fn()
    const d = deps(verify)
    d.gate = { enabled: () => false }

    registerInvokeRoute(app, d)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/control/invoke',
      headers: { authorization: 'Bearer token' },
      payload: {},
    })

    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ error: 'control disabled' })
    expect(verify).not.toHaveBeenCalled()
  })

  it('rejects replayed tokens before dispatch', async () => {
    const app = Fastify()
    apps.push(app)
    const d = deps(vi.fn(async () => claims()))
    d.replay.mark = vi.fn(async () => false)

    registerInvokeRoute(app, d)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/control/invoke',
      headers: { authorization: 'Bearer token' },
      payload: { command: 'agent', subcommand: 'list' },
    })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'token replay' })
    expect(d.sink.emit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'deny', reason: 'replay' }))
  })

  it('rate-limits authenticated subjects before dispatch', async () => {
    const app = Fastify()
    apps.push(app)
    const d = deps(vi.fn(async () => claims()))
    d.replay.mark = vi.fn(async () => true)
    d.rate = { allow: vi.fn(() => false) } as unknown as RateLimiter

    registerInvokeRoute(app, d)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/control/invoke',
      headers: { authorization: 'Bearer token' },
      payload: { command: 'agent', subcommand: 'list' },
    })

    expect(res.statusCode).toBe(429)
    expect(res.json()).toEqual({ error: 'rate limited' })
    expect(d.sink.emit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'deny', reason: 'rate limited' }))
  })

  it('throttles unauthenticated floods per IP before authentication', async () => {
    const app = Fastify()
    apps.push(app)
    const verify = vi.fn(async () => claims())
    const d = deps(verify)
    d.ipRateLimitPerMin = 1
    let count = 0
    d.redis = {
      time: async () => ['0', '0'],
      incr: vi.fn(async () => (count += 1)),
      expire: vi.fn(async () => 1),
    } as unknown as RedisClient

    registerInvokeRoute(app, d)
    await app.ready()
    const headers = { authorization: 'Bearer token' }
    const payload = { command: 'agent', subcommand: 'list' }

    const first = await app.inject({ method: 'POST', url: '/v1/control/invoke', headers, payload })
    expect(first.statusCode).not.toBe(429)
    const second = await app.inject({ method: 'POST', url: '/v1/control/invoke', headers, payload })

    expect(second.statusCode).toBe(429)
    expect(second.json()).toEqual({ error: 'rate limited' })
    expect(d.sink.emit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'deny', reason: 'ip rate limited' }))
    expect(verify).toHaveBeenCalledTimes(1)
  })

  it('dispatches valid control requests and emits allow audit events', async () => {
    const app = Fastify()
    apps.push(app)
    const d = deps(vi.fn(async () => claims()))
    d.replay.mark = vi.fn(async () => true)
    d.ctx = { admin: { agents: { list: vi.fn(async () => [{ id: 'agent-1' }]) } } } as DispatchContext

    registerInvokeRoute(app, d)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/control/invoke',
      headers: { authorization: 'Bearer token' },
      payload: { command: 'agent', subcommand: 'list', flags: ['ignored'] },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, result: [{ id: 'agent-1' }] })
    expect(d.sink.emit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'allow', command: 'agent' }))
  })

  it('records the body authorizing actor as audit attribution on the allow event', async () => {
    const app = Fastify()
    apps.push(app)
    const d = deps(vi.fn(async () => claims()))
    d.replay.mark = vi.fn(async () => true)
    d.ctx = { admin: { agents: { list: vi.fn(async () => [{ id: 'agent-1' }]) } } } as DispatchContext

    registerInvokeRoute(app, d)
    await app.ready()
    await app.inject({
      method: 'POST',
      url: '/v1/control/invoke',
      headers: { authorization: 'Bearer token' },
      payload: { command: 'agent', subcommand: 'list', authorized_by: 'account-7' },
    })

    expect(d.sink.emit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'allow', authorizedBy: 'account-7' }))
  })

  it('maps dispatch denials, invalid requests, and upstream failures', async () => {
    const denied = Fastify()
    const invalid = Fastify()
    const upstream = Fastify()
    apps.push(denied, invalid, upstream)

    const deniedDeps = deps(vi.fn(async () => claims()))
    deniedDeps.replay.mark = vi.fn(async () => true)
    deniedDeps.ctx = { admin: { zones: { list: vi.fn() } } } as DispatchContext
    registerInvokeRoute(denied, deniedDeps)
    await denied.ready()
    const deniedRes = await denied.inject({
      method: 'POST',
      url: '/v1/control/invoke',
      headers: { authorization: 'Bearer token' },
      payload: { command: 'zone', subcommand: 'nope' },
    })
    expect(deniedRes.statusCode).toBe(403)
    expect(deniedRes.json()).toEqual({ ok: false, error: { code: 'denied', reason: expect.any(String) } })

    const invalidDeps = deps(vi.fn(async () => claims()))
    invalidDeps.replay.mark = vi.fn(async () => true)
    invalidDeps.ctx = { admin: { agents: { suspend: vi.fn() } } } as DispatchContext
    registerInvokeRoute(invalid, invalidDeps)
    await invalid.ready()
    const invalidRes = await invalid.inject({
      method: 'POST',
      url: '/v1/control/invoke',
      headers: { authorization: 'Bearer token' },
      payload: { command: 'agent', subcommand: 'suspend' },
    })
    expect(invalidRes.statusCode).toBe(400)
    expect(invalidRes.json()).toEqual({ ok: false, error: { code: 'invalid', reason: expect.any(String) } })

    const upstreamDeps = deps(vi.fn(async () => claims()))
    upstreamDeps.replay.mark = vi.fn(async () => true)
    upstreamDeps.ctx = {
      admin: {
        agents: {
          list: vi.fn(async () => {
            throw new Error('api down')
          }),
        },
      },
    } as DispatchContext
    registerInvokeRoute(upstream, upstreamDeps)
    await upstream.ready()
    const upstreamRes = await upstream.inject({
      method: 'POST',
      url: '/v1/control/invoke',
      headers: { authorization: 'Bearer token' },
      payload: { command: 'agent', subcommand: 'list' },
    })
    expect(upstreamRes.statusCode).toBe(502)
    expect(upstreamRes.json()).toEqual({ ok: false, error: { code: 'upstream', reason: 'upstream error' } })
  })

  it('lets the reserved Operator govern a tenant zone via the zone-scope header', async () => {
    const app = Fastify()
    apps.push(app)
    const list = vi.fn(async () => [{ id: 'a1' }])
    const d = deps(vi.fn(async () => claims({ sub: 'operator-reader', zoneId: 'z-system', scope: 'control:app:read' })))
    d.replay.mark = vi.fn(async () => true)
    d.resolvePlatformOperatorSubject = () => 'operator-reader'
    d.ctx = { admin: { applications: { list } } } as unknown as DispatchContext

    registerInvokeRoute(app, d)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/control/invoke',
      headers: { authorization: 'Bearer token', 'x-caracal-zone-scope': 'z-tenant' },
      payload: { command: 'app', subcommand: 'list' },
    })

    expect(res.statusCode).toBe(200)
    // The read targets the tenant zone, and the audit is attributed to the zone actually read.
    expect(list).toHaveBeenCalledWith('z-tenant')
    expect(d.sink.emit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'allow', zoneId: 'z-tenant' }))
  })

  it('lets the reserved Operator mutate a tenant zone via the zone-scope header', async () => {
    const app = Fastify()
    apps.push(app)
    const create = vi.fn(async () => ({ id: 'app-new' }))
    const d = deps(vi.fn(async () => claims({ sub: 'operator-reader', zoneId: 'z-system', scope: 'control:app:write' })))
    d.replay.mark = vi.fn(async () => true)
    d.resolvePlatformOperatorSubject = () => 'operator-reader'
    d.ctx = { admin: { applications: { create } } } as unknown as DispatchContext

    registerInvokeRoute(app, d)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/control/invoke',
      headers: { authorization: 'Bearer token', 'x-caracal-zone-scope': 'z-tenant' },
      payload: { command: 'app', subcommand: 'create', flags: { name: 'Son of Anton' } },
    })

    expect(res.statusCode).toBe(200)
    // The mutation is applied in the tenant zone and attributed to it.
    expect(create).toHaveBeenCalledWith('z-tenant', expect.anything())
    expect(d.sink.emit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'allow', zoneId: 'z-tenant' }))
  })

  it('ignores the zone-scope header for a subject that is not the reserved Operator', async () => {
    const app = Fastify()
    apps.push(app)
    const list = vi.fn(async () => [{ id: 'a1' }])
    const d = deps(vi.fn(async () => claims({ sub: 'tenant-key', zoneId: 'z-own', scope: 'control:app:read' })))
    d.replay.mark = vi.fn(async () => true)
    d.resolvePlatformOperatorSubject = () => 'operator-reader'
    d.ctx = { admin: { applications: { list } } } as unknown as DispatchContext

    registerInvokeRoute(app, d)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/control/invoke',
      headers: { authorization: 'Bearer token', 'x-caracal-zone-scope': 'z-victim' },
      payload: { command: 'app', subcommand: 'list' },
    })

    expect(res.statusCode).toBe(200)
    // A tenant key can never use the header to reach another zone: the command stays in its own zone.
    expect(list).toHaveBeenCalledWith('z-own')
    expect(d.sink.emit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'allow', zoneId: 'z-own' }))
  })
})
