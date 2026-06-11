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
import { redisMinuteBucket } from './redis.js'
import { adminAuthPlugin } from './auth.js'
import { registerAdminAuditHook } from './admin-audit.js'
import {
  isPublished,
  getTraceContext,
  parseTraceparent,
  bindTrace,
  renderObservabilityMetrics,
  buildPinoRedactPaths,
  instrumentFastifyApp,
  withTimeout,
  CaracalError,
  pathOnly,
} from '@caracalai/core'
import { zonesRoutes } from './routes/zones.js'
import { applicationsRoutes } from './routes/applications.js'
import { resourcesRoutes } from './routes/resources.js'
import { providersRoutes } from './routes/providers.js'
import { policiesRoutes } from './routes/policies.js'
import { policySetsRoutes } from './routes/policy-sets.js'
import { grantsRoutes } from './routes/grants.js'
import { stepUpChallengesRoutes } from './routes/step-up-challenges.js'
import { policyTemplatesRoutes } from './routes/policy-templates.js'
import { zoneEventsRoutes } from './routes/zone-events.js'
import { adminTokensRoutes } from './routes/admin-tokens.js'

import './fastify-augmentation.js'

const READY_CHECK_TIMEOUT_MS = 5_000

interface OutboxHealth {
  pendingCount: number
  deadCount: number
  oldestPendingAgeSeconds: number
  oldestDeadAgeSeconds: number
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

async function queryOutboxHealth(db: DB): Promise<OutboxHealth> {
  const { rows } = await db.query<{
    pending_count: string | number
    dead_count: string | number
    oldest_pending_age_seconds: string | number | null
    oldest_dead_age_seconds: string | number | null
  }>(
    `SELECT
       count(*) FILTER (
         WHERE dispatched_at IS NULL
           AND available_at <> 'infinity'::timestamptz
       ) AS pending_count,
       count(*) FILTER (
         WHERE dispatched_at IS NULL
           AND available_at = 'infinity'::timestamptz
       ) AS dead_count,
       COALESCE(EXTRACT(EPOCH FROM now() - MIN(created_at) FILTER (
         WHERE dispatched_at IS NULL
           AND available_at <> 'infinity'::timestamptz
       )), 0) AS oldest_pending_age_seconds,
       COALESCE(EXTRACT(EPOCH FROM now() - MIN(created_at) FILTER (
         WHERE dispatched_at IS NULL
           AND available_at = 'infinity'::timestamptz
       )), 0) AS oldest_dead_age_seconds
     FROM event_outbox`,
  )
  const row = rows[0]
  return {
    pendingCount: toNumber(row?.pending_count),
    deadCount: toNumber(row?.dead_count),
    oldestPendingAgeSeconds: toNumber(row?.oldest_pending_age_seconds),
    oldestDeadAgeSeconds: toNumber(row?.oldest_dead_age_seconds),
  }
}

function renderOutboxMetrics(health: OutboxHealth): string {
  return [
    '# HELP caracal_api_outbox_pending_total Undispatched API outbox rows that remain eligible for retry.',
    '# TYPE caracal_api_outbox_pending_total gauge',
    `caracal_api_outbox_pending_total ${health.pendingCount}`,
    '# HELP caracal_api_outbox_dead_total API outbox rows abandoned after exhausting delivery attempts.',
    '# TYPE caracal_api_outbox_dead_total gauge',
    `caracal_api_outbox_dead_total ${health.deadCount}`,
    '# HELP caracal_api_outbox_oldest_pending_age_seconds Age in seconds of the oldest pending API outbox row.',
    '# TYPE caracal_api_outbox_oldest_pending_age_seconds gauge',
    `caracal_api_outbox_oldest_pending_age_seconds ${health.oldestPendingAgeSeconds}`,
    '# HELP caracal_api_outbox_oldest_dead_age_seconds Age in seconds of the oldest dead API outbox row.',
    '# TYPE caracal_api_outbox_oldest_dead_age_seconds gauge',
    `caracal_api_outbox_oldest_dead_age_seconds ${health.oldestDeadAgeSeconds}`,
  ].join('\n')
}

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
      serializers: {
        err: pino.stdSerializers.err,
        error: pino.stdSerializers.err,
        req: (request: { method?: string; url?: string; ip?: string }) => ({
          method: request.method,
          url: request.url ? pathOnly(request.url) : request.url,
          ip: request.ip,
        }),
      },
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
      const issues = err.issues.map((i) => ({ path: i.path.map(String), message: i.message }))
      reply.code(400).send(
        new CaracalError('invalid_body', 'Request body failed validation', {
          requestId: req.id,
          details: { issues },
        }).toJSON(),
      )
      return
    }
    req.log.error({ err }, 'unhandled route error')
    const status = (err as { statusCode?: number }).statusCode
    const code = typeof status === 'number' && status >= 400 && status < 600 ? status : 500
    reply.code(code).send(
      new CaracalError('internal_error', 'The service failed to process the request', {
        requestId: req.id,
      }).toJSON(),
    )
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
      const minute = await redisMinuteBucket(redis)
      const count = await tick(`api:v1_rl:ip:${req.ip}:${minute}`)
      if (count > cfg.v1RateLimitPerMin) {
        return reply.code(429).send({ error: 'rate_limited' })
      }
    })
    app.addHook('preHandler', async (req, reply) => {
      if (!req.url.startsWith('/v1/')) return
      if (!req.actor?.id) return
      const minute = await redisMinuteBucket(redis)
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
  registerAdminAuditHook(app, { db, hmacKey: cfg.auditHmacKey })

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
  await app.register(stepUpChallengesRoutes, { prefix: '/v1' })
  await app.register(policyTemplatesRoutes, { prefix: '/v1' })
  await app.register(zoneEventsRoutes, { prefix: '/v1' })
  await app.register(adminTokensRoutes, { prefix: '/v1' })

  app.get('/health', async () => ({ ok: true }))
  app.get('/metrics', async (req, reply) => {
    if (cfg.metricsBearer) {
      const auth = req.headers.authorization
      const expected = `Bearer ${cfg.metricsBearer}`
      if (typeof auth !== 'string' || auth.length !== expected.length || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) {
        return reply.code(401).send({ error: 'unauthorized' })
      }
    } else if (isPublished()) {
      // Published builds bind to 0.0.0.0; refuse to expose operational metrics
      // on the network unless an operator has provisioned METRICS_BEARER.
      return reply.code(401).send({ error: 'unauthorized' })
    }
    const health = await withTimeout(queryOutboxHealth(db), READY_CHECK_TIMEOUT_MS, 'metrics outbox check timed out')
    reply.type('text/plain; version=0.0.4')
    return `${renderObservabilityMetrics()}\n${renderOutboxMetrics(health)}\n`
  })
  app.get('/ready', async (req, reply) => {
    if (cfg.readyRateLimitPerMin > 0) {
      const minute = await redisMinuteBucket(redis)
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
    let outboxHealth: OutboxHealth
    try {
      outboxHealth = await withTimeout(queryOutboxHealth(db), READY_CHECK_TIMEOUT_MS, 'ready outbox check timed out')
    } catch (err) {
      reply.code(503)
      req.log.warn({ err }, 'ready_outbox_unreachable')
      return { ok: false, error: 'outbox_unreachable', dependency: 'postgres' }
    }
    if (outboxHealth.deadCount > cfg.readyOutboxDeadMax) {
      reply.code(503)
      req.log.warn({ deadCount: outboxHealth.deadCount, limit: cfg.readyOutboxDeadMax }, 'ready_outbox_dead_messages')
      return { ok: false, error: 'outbox_dead_messages', deadCount: outboxHealth.deadCount, limit: cfg.readyOutboxDeadMax }
    }
    return { ok: true }
  })

  return app
}
