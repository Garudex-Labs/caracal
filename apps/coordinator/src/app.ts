// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Coordinator Fastify application factory.

import Fastify from 'fastify'
import type { Pool } from 'pg'
import type { Redis as RedisClient } from 'ioredis'
import { agentsRoutes } from './routes/agents.js'
import { agentServicesRoutes } from './routes/agent-services.js'
import { delegationsRoutes } from './routes/delegations.js'
import { invocationsRoutes } from './routes/invocations.js'
import { v1Routes } from './routes/v1.js'
import { db } from './db.js'
import { redis } from './redis.js'
import { verifyBearer } from './auth.js'
import { ttlSweeperStats } from './jobs/ttl-sweeper.js'
import { retentionCleanerStats } from './jobs/retention-cleaner.js'

declare module 'fastify' {
  interface FastifyInstance {
    db: Pool
    redis: RedisClient
  }
}

export async function buildApp() {
  const app = Fastify({
    logger: { transport: { target: 'pino/file', options: { destination: '/dev/stderr' } } },
  })
  app.decorate('db', db)
  app.decorate('redis', redis)
  app.addHook('preHandler', verifyBearer)
  app.get('/health', async () => ({ ok: true }))
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
