// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the control invoke route registration: gating, replay, per-subject limiting, and dispatch.

import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Authenticator, type Claims } from '../../../../../apps/api/src/control/auth.js'
import { registerInvokeRoute, type InvokeDeps, type ZoneScopeTarget } from '../../../../../apps/api/src/control/handler.js'
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
    scope: 'control:session:read control:session:write',
    ...overrides,
  }
}

// Builds a dispatch context whose admin mock supports the request-scoped header wrapping the
// handler applies to every dispatch.
function ctx(admin: Record<string, unknown>): DispatchContext {
  const full: Record<string, unknown> = { ...admin, withDefaultHeaders: () => full }
  return { admin: full } as unknown as DispatchContext
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
    expect(res.json()).toEqual({ ok: false, error: { code: 'control_disabled', reason: expect.any(String) } })
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
      payload: { command: 'session', subcommand: 'list' },
    })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ ok: false, error: { code: 'token_replay', reason: expect.any(String) } })
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
      payload: { command: 'session', subcommand: 'list' },
    })

    expect(res.statusCode).toBe(429)
    expect(res.json()).toEqual({ ok: false, error: { code: 'rate_limited', reason: expect.any(String) } })
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
    const payload = { command: 'session', subcommand: 'list' }

    const first = await app.inject({ method: 'POST', url: '/v1/control/invoke', headers, payload })
    expect(first.statusCode).not.toBe(429)
    const second = await app.inject({ method: 'POST', url: '/v1/control/invoke', headers, payload })

    expect(second.statusCode).toBe(429)
    expect(second.json()).toEqual({ ok: false, error: { code: 'rate_limited', reason: expect.any(String) } })
    expect(d.sink.emit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'deny', reason: 'ip rate limited' }))
    expect(verify).toHaveBeenCalledTimes(1)
  })

  it('dispatches valid control requests and emits allow audit events', async () => {
    const app = Fastify()
    apps.push(app)
    const d = deps(vi.fn(async () => claims()))
    d.replay.mark = vi.fn(async () => true)
    d.ctx = ctx({ sessions: { list: vi.fn(async () => [{ id: 'session-1' }]) } })

    registerInvokeRoute(app, d)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/control/invoke',
      headers: { authorization: 'Bearer token' },
      payload: { command: 'session', subcommand: 'list', flags: ['ignored'] },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, result: [{ id: 'session-1' }] })
    expect(d.sink.emit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'allow', command: 'session' }))
  })

  it('refuses to report success when the allow audit cannot be durably recorded', async () => {
    const app = Fastify()
    apps.push(app)
    const d = deps(vi.fn(async () => claims()))
    d.replay.mark = vi.fn(async () => true)
    const emit = vi.fn(async (ev: { decision: string }) => {
      if (ev.decision === 'allow') throw new Error('audit store unavailable')
    })
    d.sink = { emit } as EventSink
    d.ctx = ctx({ sessions: { list: vi.fn(async () => [{ id: 'session-1' }]) } })

    registerInvokeRoute(app, d)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/control/invoke',
      headers: { authorization: 'Bearer token' },
      payload: { command: 'session', subcommand: 'list' },
    })

    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ ok: false, error: { code: 'audit_unavailable', reason: expect.any(String) } })
  })

  it('records the body authorizing actor as audit attribution when the subject is a reserved Operator identity', async () => {
    const app = Fastify()
    apps.push(app)
    const d = deps(vi.fn(async () => claims()))
    d.replay.mark = vi.fn(async () => true)
    d.resolveOperatorSubjects = () => new Set(['subject-1'])
    const admin = { sessions: { list: vi.fn(async () => [{ id: 'session-1' }]) }, withDefaultHeaders: () => admin }
    d.ctx = { admin } as unknown as DispatchContext

    registerInvokeRoute(app, d)
    await app.ready()
    await app.inject({
      method: 'POST',
      url: '/v1/control/invoke',
      headers: { authorization: 'Bearer token' },
      payload: { command: 'session', subcommand: 'list', authorized_by: 'account-7' },
    })

    expect(d.sink.emit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'allow', authorizedBy: 'account-7' }))
  })

  it('discards client-supplied attribution from any subject that is not a reserved Operator identity', async () => {
    const app = Fastify()
    apps.push(app)
    const d = deps(vi.fn(async () => claims({ sub: 'tenant-key' })))
    d.replay.mark = vi.fn(async () => true)
    d.resolveOperatorSubjects = () => new Set(['operator-executor'])
    const admin = { sessions: { list: vi.fn(async () => [{ id: 'session-1' }]) }, withDefaultHeaders: vi.fn(() => admin) }
    d.ctx = { admin } as unknown as DispatchContext

    registerInvokeRoute(app, d)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/control/invoke',
      headers: { authorization: 'Bearer token' },
      payload: { command: 'session', subcommand: 'list', authorized_by: 'forged-human', co_author_operator: true },
    })

    // The command still runs in the caller's own authority, but no attribution header is ever
    // derived from the client-supplied fields and the audit carries no forged actor. The only
    // header stamped on the dispatch is the request id for trace correlation.
    expect(res.statusCode).toBe(200)
    expect(admin.withDefaultHeaders).toHaveBeenCalledWith({ 'x-request-id': expect.any(String) })
    expect(d.sink.emit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'allow', authorizedBy: undefined }))
  })

  it('maps dispatch denials, invalid requests, and upstream failures', async () => {
    const denied = Fastify()
    const invalid = Fastify()
    const upstream = Fastify()
    apps.push(denied, invalid, upstream)

    const deniedDeps = deps(vi.fn(async () => claims()))
    deniedDeps.replay.mark = vi.fn(async () => true)
    deniedDeps.ctx = ctx({ zones: { list: vi.fn() } })
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
    invalidDeps.ctx = ctx({ sessions: { suspend: vi.fn() } })
    registerInvokeRoute(invalid, invalidDeps)
    await invalid.ready()
    const invalidRes = await invalid.inject({
      method: 'POST',
      url: '/v1/control/invoke',
      headers: { authorization: 'Bearer token' },
      payload: { command: 'session', subcommand: 'suspend' },
    })
    expect(invalidRes.statusCode).toBe(400)
    expect(invalidRes.json()).toEqual({ ok: false, error: { code: 'invalid', reason: expect.any(String) } })

    const upstreamDeps = deps(vi.fn(async () => claims()))
    upstreamDeps.replay.mark = vi.fn(async () => true)
    upstreamDeps.ctx = ctx({
      sessions: {
        list: vi.fn(async () => {
          throw new Error('api down')
        }),
      },
    })
    registerInvokeRoute(upstream, upstreamDeps)
    await upstream.ready()
    const upstreamRes = await upstream.inject({
      method: 'POST',
      url: '/v1/control/invoke',
      headers: { authorization: 'Bearer token' },
      payload: { command: 'session', subcommand: 'list' },
    })
    expect(upstreamRes.statusCode).toBe(502)
    expect(upstreamRes.json()).toEqual({ ok: false, error: { code: 'upstream', reason: 'upstream error' } })
  })

  it('lets the reserved Operator govern a granted zone via the zone-scope header', async () => {
    const app = Fastify()
    apps.push(app)
    const list = vi.fn(async () => [{ id: 'a1' }])
    const d = deps(vi.fn(async () => claims({ sub: 'operator-reader', zoneId: 'z-system', scope: 'control:app:read' })))
    d.replay.mark = vi.fn(async () => true)
    d.resolveOperatorSubjects = () => new Set(['operator-reader'])
    d.lookupZoneScopeTarget = vi.fn(async () => ({ reserved: false, archived: false, operatorGoverned: true }))
    d.ctx = ctx({ applications: { list } })

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
    expect(d.lookupZoneScopeTarget).toHaveBeenCalledWith('z-tenant')
    expect(list).toHaveBeenCalledWith('z-tenant')
    expect(d.sink.emit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'allow', zoneId: 'z-tenant' }))
  })

  it('lets the reserved Operator mutate a granted zone via the zone-scope header', async () => {
    const app = Fastify()
    apps.push(app)
    const create = vi.fn(async () => ({ id: 'app-new' }))
    const d = deps(vi.fn(async () => claims({ sub: 'operator-executor', zoneId: 'z-system', scope: 'control:app:write' })))
    d.replay.mark = vi.fn(async () => true)
    d.resolveOperatorSubjects = () => new Set(['operator-executor'])
    d.lookupZoneScopeTarget = vi.fn(async () => ({ reserved: false, archived: false, operatorGoverned: true }))
    d.ctx = ctx({ applications: { create } })

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

  it('acts in the token zone without any grant check when the header names it', async () => {
    const app = Fastify()
    apps.push(app)
    const list = vi.fn(async () => [{ id: 'a1' }])
    const d = deps(vi.fn(async () => claims({ sub: 'operator-reader', zoneId: 'z-system', scope: 'control:app:read' })))
    d.replay.mark = vi.fn(async () => true)
    d.resolveOperatorSubjects = () => new Set(['operator-reader'])
    d.lookupZoneScopeTarget = vi.fn(async () => null)
    d.ctx = ctx({ applications: { list } })

    registerInvokeRoute(app, d)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/control/invoke',
      headers: { authorization: 'Bearer token', 'x-caracal-zone-scope': 'z-system' },
      payload: { command: 'app', subcommand: 'list' },
    })

    expect(res.statusCode).toBe(200)
    expect(d.lookupZoneScopeTarget).not.toHaveBeenCalled()
    expect(list).toHaveBeenCalledWith('z-system')
  })

  it('denies the zone-scope header for a subject that is not a reserved Operator identity', async () => {
    const app = Fastify()
    apps.push(app)
    const list = vi.fn(async () => [{ id: 'a1' }])
    const d = deps(vi.fn(async () => claims({ sub: 'tenant-key', zoneId: 'z-own', scope: 'control:app:read' })))
    d.replay.mark = vi.fn(async () => true)
    d.resolveOperatorSubjects = () => new Set(['operator-reader'])
    d.lookupZoneScopeTarget = vi.fn(async () => ({ reserved: false, archived: false, operatorGoverned: true }))
    d.ctx = { admin: { applications: { list } } } as unknown as DispatchContext

    registerInvokeRoute(app, d)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/control/invoke',
      headers: { authorization: 'Bearer token', 'x-caracal-zone-scope': 'z-victim' },
      payload: { command: 'app', subcommand: 'list' },
    })

    // A tenant key stamping the header is refused and audited, never silently re-scoped.
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ ok: false, error: { code: 'denied', reason: 'zone scope: subject is not a reserved operator identity' } })
    expect(list).not.toHaveBeenCalled()
    expect(d.sink.emit).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'deny', reason: 'zone scope: subject is not a reserved operator identity', zoneId: 'z-own' }),
    )
  })

  it('denies the zone-scope header when the Operator credential has expired and no subjects resolve', async () => {
    // An expired Operator identity resolves to null subjects, so a previously valid subject
    // presenting a still-live token fails closed at the boundary instead of retaining authority.
    const app = Fastify()
    apps.push(app)
    const list = vi.fn(async () => [{ id: 'a1' }])
    const d = deps(vi.fn(async () => claims({ sub: 'operator-reader', zoneId: 'z-system', scope: 'control:app:read' })))
    d.replay.mark = vi.fn(async () => true)
    d.resolveOperatorSubjects = () => null
    d.lookupZoneScopeTarget = vi.fn(async () => ({ reserved: false, archived: false, operatorGoverned: true }))
    d.ctx = { admin: { applications: { list } } } as unknown as DispatchContext

    registerInvokeRoute(app, d)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/control/invoke',
      headers: { authorization: 'Bearer token', 'x-caracal-zone-scope': 'z-tenant' },
      payload: { command: 'app', subcommand: 'list' },
    })

    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ ok: false, error: { code: 'denied', reason: 'zone scope: subject is not a reserved operator identity' } })
    expect(list).not.toHaveBeenCalled()
  })

  it.each([
    ['a malformed zone id', 'z/../etc', null, 'zone scope: malformed zone id'],
    ['a zone that does not exist', 'z-missing', null, 'zone scope: zone does not exist'],
    ['an archived zone', 'z-archived', { reserved: false, archived: true, operatorGoverned: true }, 'zone scope: zone is archived'],
    ['a reserved zone', 'z-reserved', { reserved: true, archived: false, operatorGoverned: true }, 'zone scope: reserved zone'],
    [
      'a zone without the administration grant',
      'z-ungoverned',
      { reserved: false, archived: false, operatorGoverned: false },
      'zone scope: zone has not granted operator administration',
    ],
  ] as [string, string, ZoneScopeTarget | null, string][])('denies zone scope targeting %s', async (_case, target, zone, reason) => {
    const app = Fastify()
    apps.push(app)
    const list = vi.fn(async () => [{ id: 'a1' }])
    const d = deps(vi.fn(async () => claims({ sub: 'operator-reader', zoneId: 'z-system', scope: 'control:app:read' })))
    d.replay.mark = vi.fn(async () => true)
    d.resolveOperatorSubjects = () => new Set(['operator-reader'])
    d.lookupZoneScopeTarget = vi.fn(async () => zone)
    d.ctx = { admin: { applications: { list } } } as unknown as DispatchContext

    registerInvokeRoute(app, d)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/control/invoke',
      headers: { authorization: 'Bearer token', 'x-caracal-zone-scope': target },
      payload: { command: 'app', subcommand: 'list' },
    })

    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ ok: false, error: { code: 'denied', reason } })
    expect(list).not.toHaveBeenCalled()
    expect(d.sink.emit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'deny', reason, command: 'app', subcommand: 'list' }))
  })

  it('denies zone scope targeting an isolated zone', async () => {
    const app = Fastify()
    apps.push(app)
    const d = deps(vi.fn(async () => claims({ sub: 'operator-reader', zoneId: 'z-system', scope: 'control:app:read' })))
    d.replay.mark = vi.fn(async () => true)
    d.resolveOperatorSubjects = () => new Set(['operator-reader'])
    d.lookupZoneScopeTarget = vi.fn(async () => ({ reserved: false, archived: false, operatorGoverned: true }))
    d.isolatedZones = new Set(['z-isolated'])
    d.ctx = { admin: { applications: { list: vi.fn() } } } as unknown as DispatchContext

    registerInvokeRoute(app, d)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/control/invoke',
      headers: { authorization: 'Bearer token', 'x-caracal-zone-scope': 'z-isolated' },
      payload: { command: 'app', subcommand: 'list' },
    })

    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ ok: false, error: { code: 'denied', reason: 'zone scope: isolated zone' } })
  })

  it('denies zone scope when no zone authority is wired', async () => {
    const app = Fastify()
    apps.push(app)
    const d = deps(vi.fn(async () => claims({ sub: 'operator-reader', zoneId: 'z-system', scope: 'control:app:read' })))
    d.replay.mark = vi.fn(async () => true)
    d.resolveOperatorSubjects = () => new Set(['operator-reader'])
    d.ctx = { admin: { applications: { list: vi.fn() } } } as unknown as DispatchContext

    registerInvokeRoute(app, d)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/control/invoke',
      headers: { authorization: 'Bearer token', 'x-caracal-zone-scope': 'z-tenant' },
      payload: { command: 'app', subcommand: 'list' },
    })

    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ ok: false, error: { code: 'denied', reason: 'zone scope: no zone authority configured' } })
  })
})
