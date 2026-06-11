// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Coordinator Fastify application factory.

import Fastify from 'fastify'
import { hostname } from 'node:os'
import { timingSafeEqual } from 'node:crypto'
import pino from 'pino'
import type { Pool } from 'pg'
import type { Redis as RedisClient } from 'ioredis'
import { ZodError } from 'zod'
import { getTraceContext, parseTraceparent, bindTrace, renderObservabilityMetrics, devLogMetrics, buildPinoRedactPaths, instrumentFastifyApp, withTimeout, CaracalError, isPublished } from '@caracalai/core'
import { agentsRoutes } from './routes/agents.js'
import { agentServicesRoutes } from './routes/agent-services.js'
import { delegationsRoutes } from './routes/delegations.js'
import { invocationsRoutes } from './routes/invocations.js'
import { v1Routes } from './routes/v1.js'
import type { Cfg } from './config.js'
import { verifyBearer } from './auth.js'
import { registerAdminAuditHook } from './admin-audit.js'
import { ttlSweeperStats } from './jobs/ttl-sweeper.js'
import { serviceLeaseSweeperStats } from './jobs/service-lease-sweeper.js'
import { retentionCleanerStats } from './jobs/retention-cleaner.js'
import { redisMinuteBucket } from './redis.js'

declare module 'fastify' {
  interface FastifyInstance {
    db: Pool
    redis: RedisClient
  }
}

export interface CoordinatorDeps {
  cfg: Cfg
  db: Pool
  redis: RedisClient
  isDraining?: () => boolean
}

interface RuntimeStats {
  invocations: Record<string, number>
  outbox: Record<string, number>
  expiresAt: number
}

const RUNTIME_STATS_TTL_MS = 15_000
const READY_CHECK_TIMEOUT_MS = 5_000

export async function buildApp({ cfg, db, redis, isDraining }: CoordinatorDeps) {
  let runtimeStats: RuntimeStats | null = null
  let runtimeStatsRefresh: Promise<RuntimeStats> | null = null
  const loadRuntimeStats = async (): Promise<RuntimeStats> => {
    const now = performance.now()
    if (runtimeStats && runtimeStats.expiresAt > now) return runtimeStats
    if (runtimeStatsRefresh) return runtimeStatsRefresh
    runtimeStatsRefresh = (async () => {
      const { rows: invocations } = await db.query<{ status: string; n: string }>(
        `SELECT status, COUNT(*) AS n FROM agent_invocations GROUP BY status`,
      )
      const { rows: outbox } = await db.query<{ status: string; n: string }>(
        `SELECT status, COUNT(*) AS n FROM caracal_outbox WHERE producer = 'coordinator' GROUP BY status`,
      )
      runtimeStats = {
        invocations: Object.fromEntries(invocations.map((row) => [row.status, Number(row.n)])),
        outbox: Object.fromEntries(outbox.map((row) => [row.status, Number(row.n)])),
        expiresAt: performance.now() + RUNTIME_STATS_TTL_MS,
      }
      return runtimeStats
    })().finally(() => { runtimeStatsRefresh = null })
    return runtimeStatsRefresh
  }

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      base: {
        service: 'coordinator',
        env: process.env.CARACAL_ENV || process.env.NODE_ENV || 'development',
        version: process.env.CARACAL_VERSION || 'dev',
        pid: process.pid,
        hostname: hostname(),
      },
      messageKey: 'msg',
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      serializers: { err: pino.stdSerializers.err, error: pino.stdSerializers.err },
      redact: { paths: buildPinoRedactPaths(), censor: '***' },
      mixin: () => {
        const tc = getTraceContext()
        const out: Record<string, unknown> = {}
        if (tc?.traceId) out.trace_id = tc.traceId
        if (tc?.spanId) out.span_id = tc.spanId
        return out
      },
    },
    requestTimeout: cfg.requestTimeoutMs,
    trustProxy: cfg.trustProxy,
  })
  app.decorate('db', db)
  app.decorate('redis', redis)
  instrumentFastifyApp(app, 'caracal-coordinator')
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
  app.addHook('onRequest', async (req, reply) => {
    const h = req.headers['traceparent']
    const value = Array.isArray(h) ? h[0] : h
    const tc = parseTraceparent(value)
    bindTrace({ traceId: tc.traceId, spanId: tc.spanId || req.id })
    if (cfg.coordinatorRateLimitPerMin <= 0) return
    const minute = await redisMinuteBucket(redis)
    const key = `coordinator:global_rl:${req.ip}:${minute}`
    const count = await redis.incr(key)
    if (count === 1) await redis.expire(key, 90)
    if (count > cfg.coordinatorRateLimitPerMin) {
      return reply.code(429).send({ error: 'rate_limited' })
    }
  })
  app.addHook('preHandler', verifyBearer)
  registerAdminAuditHook(app, db, cfg.auditHmacKey)
  app.get('/health', async () => ({ ok: true }))
  app.get('/ready', async (req, reply) => {
    if (cfg.readyRateLimitPerMin > 0) {
      const minute = await redisMinuteBucket(redis)
      const key = `coordinator:ready_rl:${req.ip}:${minute}`
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
      await withTimeout(app.db.query('SELECT 1'), READY_CHECK_TIMEOUT_MS, 'ready postgres check timed out')
    } catch (err) {
      reply.code(503)
      req.log.warn({ err }, 'ready_postgres_unreachable')
      return { ok: false, error: 'postgres_unreachable', dependency: 'postgres' }
    }
    try {
      const pong = await withTimeout(app.redis.ping(), READY_CHECK_TIMEOUT_MS, 'ready redis check timed out')
      if (pong !== 'PONG') throw new Error(`unexpected redis ping reply: ${pong}`)
    } catch (err) {
      reply.code(503)
      req.log.warn({ err }, 'ready_redis_unreachable')
      return { ok: false, error: 'redis_unreachable', dependency: 'redis' }
    }
    return { ok: true }
  })
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
    const stats = await loadRuntimeStats()
    const lines: string[] = []
    lines.push('# HELP caracal_invocations_total Coordinator invocations by status')
    lines.push('# TYPE caracal_invocations_total counter')
    for (const [status, n] of Object.entries(stats.invocations)) {
      lines.push(`caracal_invocations_total{status="${status}"} ${n}`)
    }
    lines.push('# HELP caracal_outbox_total Coordinator outbox rows by status')
    lines.push('# TYPE caracal_outbox_total gauge')
    for (const [status, n] of Object.entries(stats.outbox)) {
      lines.push(`caracal_outbox_total{status="${status}"} ${n}`)
    }
    lines.push('# HELP caracal_ttl_sweeper_runs_total Ttl sweeper iterations')
    lines.push('# TYPE caracal_ttl_sweeper_runs_total counter')
    lines.push(`caracal_ttl_sweeper_runs_total ${ttlSweeperStats.runs ?? 0}`)
    lines.push('# HELP caracal_service_lease_sweeper_runs_total Service lease sweeper iterations')
    lines.push('# TYPE caracal_service_lease_sweeper_runs_total counter')
    lines.push(`caracal_service_lease_sweeper_runs_total ${serviceLeaseSweeperStats.runs ?? 0}`)
    lines.push('# HELP caracal_retention_cleaner_runs_total Retention cleaner iterations')
    lines.push('# TYPE caracal_retention_cleaner_runs_total counter')
    lines.push(`caracal_retention_cleaner_runs_total ${retentionCleanerStats.runs ?? 0}`)
    reply.type('text/plain; version=0.0.4')
    return lines.join('\n') + '\n' + renderObservabilityMetrics()
  })
  app.get('/stats', async () => {
    const stats = await loadRuntimeStats()
    return {
      invocations: stats.invocations,
      outbox: stats.outbox,
      ttl_sweeper: { ...ttlSweeperStats },
      service_lease_sweeper: { ...serviceLeaseSweeperStats },
      retention_cleaner: { ...retentionCleanerStats },
      log: devLogMetrics(),
    }
  })
  await app.register(agentsRoutes)
  await app.register(agentServicesRoutes)
  await app.register(delegationsRoutes)
  await app.register(invocationsRoutes)
  await app.register(v1Routes)
  return app
}
