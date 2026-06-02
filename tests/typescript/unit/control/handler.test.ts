// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the control invoke route registration and pre-authentication request limiting.

import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthError, type Authenticator, type ControlClaims } from '../../../../apps/control/src/auth.js'
import { registerInvokeRoute, type InvokeDeps } from '../../../../apps/control/src/handler.js'
import { RateLimiter } from '../../../../apps/control/src/ratelimit.js'
import type { EventSink } from '../../../../apps/control/src/audit.js'
import type { Replay } from '../../../../apps/control/src/replay.js'
import type { DispatchContext } from '../../../../packages/engine/src/dispatch.js'

const apps: { close(): Promise<void> }[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

function deps(verify: Authenticator['verify']): InvokeDeps {
  return {
    auth: { verify } as Authenticator,
    replay: { mark: vi.fn(), ping: vi.fn() } as unknown as Replay,
    rate: new RateLimiter(10, 60_000),
    routeRateLimit: { max: 1, timeWindow: 60_000 },
    sink: { emit: vi.fn(async () => {}) } as EventSink,
    ctx: { admin: {} } as DispatchContext,
    gate: { enabled: () => true },
  }
}

function claims(overrides: Partial<ControlClaims> = {}): ControlClaims {
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
  it('rate-limits invoke requests before authentication work runs', async () => {
    const app = Fastify()
    apps.push(app)
    const verify = vi.fn(async () => {
      throw new AuthError('invalid token')
    })

    await app.register(rateLimit, { global: false, max: 1, timeWindow: 60_000 })
    registerInvokeRoute(app, deps(verify))

    const first = await app.inject({
      method: 'POST',
      url: '/v1/control/invoke',
      headers: { authorization: 'Bearer bad' },
      payload: {},
    })
    const second = await app.inject({
      method: 'POST',
      url: '/v1/control/invoke',
      headers: { authorization: 'Bearer bad' },
      payload: {},
    })

    expect(first.statusCode).toBe(401)
    expect(second.statusCode).toBe(429)
    expect(verify).toHaveBeenCalledTimes(1)
  })

  it('blocks invoke requests when the runtime endpoint gate is closed', async () => {
    const app = Fastify()
    apps.push(app)
    const verify = vi.fn()
    const d = deps(verify)
    d.gate = { enabled: () => false }

    await app.register(rateLimit, { global: false, max: 1, timeWindow: 60_000 })
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
    expect(deniedRes.json()).toEqual({ error: 'denied' })

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
    expect(invalidRes.json()).toEqual({ error: 'invalid request' })

    const upstreamDeps = deps(vi.fn(async () => claims()))
    upstreamDeps.replay.mark = vi.fn(async () => true)
    upstreamDeps.ctx = { admin: { agents: { list: vi.fn(async () => { throw new Error('api down') }) } } } as DispatchContext
    registerInvokeRoute(upstream, upstreamDeps)
    await upstream.ready()
    const upstreamRes = await upstream.inject({
      method: 'POST',
      url: '/v1/control/invoke',
      headers: { authorization: 'Bearer token' },
      payload: { command: 'agent', subcommand: 'list' },
    })
    expect(upstreamRes.statusCode).toBe(502)
    expect(upstreamRes.json()).toEqual({ error: 'upstream error' })
  })
})
