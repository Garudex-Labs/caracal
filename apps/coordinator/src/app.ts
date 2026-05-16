// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Coordinator Fastify application factory.

import Fastify from 'fastify'
import { hostname } from 'node:os'
import pino from 'pino'
import type { Pool } from 'pg'
import type { Redis as RedisClient } from 'ioredis'
import { ZodError } from 'zod'
import { getTraceContext, parseTraceparent, bindTrace, renderObservabilityMetrics, devLogMetrics, buildPinoRedactPaths } from '@caracalai/core'
import { agentsRoutes } from './routes/agents.js'
import { agentServicesRoutes } from './routes/agent-services.js'
import { delegationsRoutes } from './routes/delegations.js'
import { invocationsRoutes } from './routes/invocations.js'
import { v1Routes } from './routes/v1.js'
import type { Cfg } from './config.js'
import { verifyBearer } from './auth.js'
import { registerAdminAuditHook } from './admin-audit.js'
import { ttlSweeperStats } from './jobs/ttl-sweeper.js'
import { retentionCleanerStats } from './jobs/retention-cleaner.js'

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
}

export async function buildApp({ cfg, db, redis }: CoordinatorDeps) {
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
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      reply
        .code(400)
        .send({ error: 'invalid_body', issues: err.issues.map((i) => ({ path: i.path, message: i.message })) })
      return
    }
    req.log.error({ err }, 'unhandled route error')
    const status = (err as { statusCode?: number }).statusCode
    reply
      .code(typeof status === 'number' && status >= 400 && status < 600 ? status : 500)
      .send({ error: 'internal_error' })
  })
  app.addHook('onRequest', async (req, reply) => {
    const h = req.headers['traceparent']
    const value = Array.isArray(h) ? h[0] : h
    const tc = parseTraceparent(value)
    bindTrace({ traceId: tc.traceId, spanId: tc.spanId || req.id })
    if (cfg.coordinatorRateLimitPerMin <= 0) return
    const minute = Math.floor(Date.now() / 60_000)
    const key = `coordinator:global_rl:${req.ip}:${minute}`
    const count = await redis.incr(key)
    if (count === 1) await redis.expire(key, 90)
    if (count > cfg.coordinatorRateLimitPerMin) {
      return reply.code(429).send({ error: 'rate_limited' })
    }
  })
  app.addHook('preHandler', verifyBearer)
  registerAdminAuditHook(app, db)
  app.get('/health', async () => ({ ok: true }))
  app.get('/ready', async (req, reply) => {
    try {
      await app.db.query('SELECT 1')
      const pong = await app.redis.ping()
      if (pong !== 'PONG') throw new Error(`unexpected redis ping reply: ${pong}`)
      return { ok: true }
    } catch (err) {
      reply.code(503)
      req.log.warn({ err }, 'ready_dependency_check_failed')
      return { ok: false, error: 'dependency_check_failed' }
    }
  })
  app.get('/metrics', async (_req, reply) => {
    const { rows: invocations } = await app.db.query(
      `SELECT status, COUNT(*) AS n FROM agent_invocations GROUP BY status`,
    )
    const { rows: outbox } = await app.db.query(
      `SELECT status, COUNT(*) AS n FROM caracal_outbox WHERE producer = 'coordinator' GROUP BY status`,
    )
    const lines: string[] = []
    lines.push('# HELP caracal_invocations_total Coordinator invocations by status')
    lines.push('# TYPE caracal_invocations_total counter')
    for (const row of invocations as Array<{ status: string; n: string }>) {
      lines.push(`caracal_invocations_total{status="${row.status}"} ${Number(row.n)}`)
    }
    lines.push('# HELP caracal_outbox_total Coordinator outbox rows by status')
    lines.push('# TYPE caracal_outbox_total gauge')
    for (const row of outbox as Array<{ status: string; n: string }>) {
      lines.push(`caracal_outbox_total{status="${row.status}"} ${Number(row.n)}`)
    }
    lines.push('# HELP caracal_ttl_sweeper_runs_total Ttl sweeper iterations')
    lines.push('# TYPE caracal_ttl_sweeper_runs_total counter')
    lines.push(`caracal_ttl_sweeper_runs_total ${ttlSweeperStats.runs ?? 0}`)
    lines.push('# HELP caracal_retention_cleaner_runs_total Retention cleaner iterations')
    lines.push('# TYPE caracal_retention_cleaner_runs_total counter')
    lines.push(`caracal_retention_cleaner_runs_total ${retentionCleanerStats.runs ?? 0}`)
    reply.type('text/plain; version=0.0.4')
    return lines.join('\n') + '\n' + renderObservabilityMetrics()
  })
  app.get('/stats', async () => {
    const { rows: invocations } = await app.db.query(
      `SELECT status, COUNT(*) AS n FROM agent_invocations GROUP BY status`,
    )
    const { rows: outbox } = await app.db.query(
      `SELECT status, COUNT(*) AS n FROM caracal_outbox WHERE producer = 'coordinator' GROUP BY status`,
    )
    return {
      invocations: Object.fromEntries(invocations.map((row: { status: string; n: string }) => [row.status, Number(row.n)])),
      outbox: Object.fromEntries(outbox.map((row: { status: string; n: string }) => [row.status, Number(row.n)])),
      ttl_sweeper: { ...ttlSweeperStats },
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
