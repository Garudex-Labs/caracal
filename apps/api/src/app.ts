// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Fastify app factory: registers plugins, decorations, and all route handlers.

import Fastify from 'fastify'
import swagger from '@fastify/swagger'
import swaggerUI from '@fastify/swagger-ui'
import { randomUUID } from 'node:crypto'
import { timingSafeEqual } from 'node:crypto'
import { hostname } from 'node:os'
import pino from 'pino'
import { ZodError } from 'zod'
import type { Config } from './config.js'
import type { DB } from './db.js'
import type { RedisClient } from './redis.js'
import { adminAuthPlugin } from './auth.js'
import { registerAdminAuditHook } from './admin-audit.js'
import { isPublished, getTraceContext, parseTraceparent, bindTrace, renderObservabilityMetrics, buildPinoRedactPaths, instrumentFastifyApp, withTimeout } from '@caracalai/core'
import { zonesRoutes } from './routes/zones.js'
import { applicationsRoutes } from './routes/applications.js'
import { resourcesRoutes } from './routes/resources.js'
import { providersRoutes } from './routes/providers.js'
import { policiesRoutes } from './routes/policies.js'
import { policySetsRoutes } from './routes/policy-sets.js'
import { grantsRoutes } from './routes/grants.js'
import { invitationsRoutes } from './routes/invitations.js'
import { teamsRoutes } from './routes/teams.js'
import { stepUpChallengesRoutes } from './routes/step-up-challenges.js'
import { policyTemplatesRoutes } from './routes/policy-templates.js'
import { zoneEventsRoutes } from './routes/zone-events.js'

import './fastify-augmentation.js'

const READY_CHECK_TIMEOUT_MS = 5_000

export interface AppDeps {
  cfg: Config
  db: DB
  redis: RedisClient
  isDraining?: () => boolean
}

export async function buildApp({ cfg, db, redis, isDraining }: AppDeps) {
  const redactPaths = buildPinoRedactPaths()
  const app = Fastify({
    logger: {
      level: cfg.logLevel,
      base: {
        service: 'api',
        env: process.env.CARACAL_ENV || process.env.NODE_ENV || 'development',
        version: process.env.CARACAL_VERSION || 'dev',
        pid: process.pid,
        hostname: hostname(),
      },
      messageKey: 'msg',
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      serializers: { err: pino.stdSerializers.err, error: pino.stdSerializers.err },
      redact: { paths: redactPaths, censor: '***' },
      mixin: () => {
        const tc = getTraceContext()
        const out: Record<string, unknown> = {}
        if (tc?.traceId) out.trace_id = tc.traceId
        if (tc?.spanId) out.span_id = tc.spanId
        return out
      },
    },
    bodyLimit: cfg.bodyLimitBytes,
    requestTimeout: cfg.requestTimeoutMs,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id']
      const value = Array.isArray(incoming) ? incoming[0] : incoming
      return value && /^[A-Za-z0-9_.\-:]{1,128}$/.test(value) ? value : randomUUID()
    },
    requestIdHeader: 'x-request-id',
    disableRequestLogging: false,
    trustProxy: cfg.trustProxy,
  })

  app.decorate('db', db)
  app.decorate('redis', redis)
  app.decorate('cfg', cfg)
  instrumentFastifyApp(app, 'caracal-api')

  app.addHook('onRequest', async (req) => {
    const h = req.headers['traceparent']
    const value = Array.isArray(h) ? h[0] : h
    const tc = parseTraceparent(value)
    bindTrace({ traceId: tc.traceId, spanId: tc.spanId || req.id })
  })

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      reply.code(400).send({ error: 'invalid_body', issues: err.issues.map((i) => ({ path: i.path, message: i.message })) })
      return
    }
    req.log.error({ err }, 'unhandled route error')
    const status = (err as { statusCode?: number }).statusCode
    reply.code(typeof status === 'number' && status >= 400 && status < 600 ? status : 500)
      .send({ error: 'internal_error' })
  })

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-request-id', req.id)
    if (req.url.startsWith('/v1/')) {
      reply.header('x-content-type-options', 'nosniff')
      reply.header('referrer-policy', 'no-referrer')
      reply.header('cache-control', 'no-store')
    }
    return payload
  })

  if (cfg.v1RateLimitPerMin > 0) {
    // Pre-auth bucket keyed by IP. After-auth re-evaluation happens in preHandler
    // so authenticated callers are accounted by actor.id (preventing X-Forwarded-For evasion).
    // Deployment requirement when trustProxy=true: the upstream proxy must strip any
    // client-supplied X-Forwarded-For; otherwise unauthenticated callers can rotate the
    // header to bypass the per-IP bucket.
    const tick = async (key: string): Promise<number> => {
      const n = await redis.incr(key)
      if (n === 1) await redis.expire(key, 90)
      return n
    }
    app.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith('/v1/')) return
      const minute = Math.floor(Date.now() / 60_000)
      const count = await tick(`api:v1_rl:ip:${req.ip}:${minute}`)
      if (count > cfg.v1RateLimitPerMin) {
        return reply.code(429).send({ error: 'rate_limited' })
      }
    })
    app.addHook('preHandler', async (req, reply) => {
      if (!req.url.startsWith('/v1/')) return
      if (!req.actor?.id) return
      const minute = Math.floor(Date.now() / 60_000)
      const count = await tick(`api:v1_rl:actor:${req.actor.id}:${minute}`)
      if (count > cfg.v1RateLimitPerMin) {
        return reply.code(429).send({ error: 'rate_limited' })
      }
    })
  }

  await app.register(adminAuthPlugin, {
    db,
    redis,
    authFailLimitPerMin: cfg.adminAuthFailLimitPerMin,
    lastUsedDebounceSec: cfg.lastUsedDebounceSec,
  })
  registerAdminAuditHook(app, { db })

  if (cfg.enableDocs) {
    await app.register(swagger, {
      openapi: {
        info: { title: 'Caracal API', version: process.env.CARACAL_VERSION ?? '0.0.0-dev' },
        servers: [{ url: `http://localhost:${cfg.port}` }],
      },
    })
    if (!isPublished()) {
      await app.register(swaggerUI, { routePrefix: '/docs' })
    }
  }

  await app.register(zonesRoutes, { prefix: '/v1' })
  await app.register(applicationsRoutes, { prefix: '/v1' })
  await app.register(resourcesRoutes, { prefix: '/v1' })
  await app.register(providersRoutes, { prefix: '/v1' })
  await app.register(policiesRoutes, { prefix: '/v1' })
  await app.register(policySetsRoutes, { prefix: '/v1' })
  await app.register(grantsRoutes, { prefix: '/v1' })
  await app.register(invitationsRoutes, { prefix: '/v1' })
  await app.register(teamsRoutes, { prefix: '/v1' })
  await app.register(stepUpChallengesRoutes, { prefix: '/v1' })
  await app.register(policyTemplatesRoutes, { prefix: '/v1' })
  await app.register(zoneEventsRoutes, { prefix: '/v1' })

  app.get('/health', async () => ({ ok: true }))
  app.get('/metrics', async (req, reply) => {
    if (cfg.metricsBearer) {
      const auth = req.headers.authorization
      const expected = `Bearer ${cfg.metricsBearer}`
      if (typeof auth !== 'string' || auth.length !== expected.length || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) {
        return reply.code(401).send({ error: 'unauthorized' })
      }
    }
    reply.type('text/plain; version=0.0.4')
    return renderObservabilityMetrics()
  })
  app.get('/ready', async (req, reply) => {
    if (cfg.readyRateLimitPerMin > 0) {
      const minute = Math.floor(Date.now() / 60_000)
      const key = `api:ready_rl:${req.ip}:${minute}`
      const count = await redis.incr(key)
      if (count === 1) await redis.expire(key, 90)
      if (count > cfg.readyRateLimitPerMin) {
        return reply.code(429).send({ error: 'rate_limited' })
      }
    }
    if (isDraining?.()) {
      reply.code(503)
      return { ok: false, draining: true }
    }
    try {
      await withTimeout(db.query('SELECT 1'), READY_CHECK_TIMEOUT_MS, 'ready postgres check timed out')
    } catch (err) {
      reply.code(503)
      req.log.warn({ err }, 'ready_postgres_unreachable')
      return { ok: false, error: 'postgres_unreachable', dependency: 'postgres' }
    }
    try {
      const pong = await withTimeout(redis.ping(), READY_CHECK_TIMEOUT_MS, 'ready redis check timed out')
      if (pong !== 'PONG') throw new Error(`unexpected redis ping reply: ${pong}`)
    } catch (err) {
      reply.code(503)
      req.log.warn({ err }, 'ready_redis_unreachable')
      return { ok: false, error: 'redis_unreachable', dependency: 'redis' }
    }
    return { ok: true }
  })

  return app
}
