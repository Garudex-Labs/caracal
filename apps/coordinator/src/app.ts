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
import { agentsRoutes } from './routes/agents.js'
import { agentServicesRoutes } from './routes/agent-services.js'
import { delegationsRoutes } from './routes/delegations.js'
import { invocationsRoutes } from './routes/invocations.js'
import { v1Routes } from './routes/v1.js'
import { db } from './db.js'
import { redis } from './redis.js'
import { cfg } from './config.js'
import { verifyBearer } from './auth.js'
import { registerAdminAuditHook } from './admin-audit.js'
import { ttlSweeperStats } from './jobs/ttl-sweeper.js'
import { retentionCleanerStats } from './jobs/retention-cleaner.js'
import { buildPinoRedactPaths } from './log-redact.js'

declare module 'fastify' {
  interface FastifyInstance {
    db: Pool
    redis: RedisClient
  }
}

export async function buildApp() {
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
  app.get('/metrics', async () => {
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
    }
  })
  await app.register(agentsRoutes)
  await app.register(agentServicesRoutes)
  await app.register(delegationsRoutes)
  await app.register(invocationsRoutes)
  await app.register(v1Routes)
  return app
}
