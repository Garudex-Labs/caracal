// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Fastify app factory: registers plugins, decorations, and all route handlers.

import Fastify from 'fastify'
import swagger from '@fastify/swagger'
import swaggerUI from '@fastify/swagger-ui'
import { randomUUID } from 'node:crypto'
import { ZodError } from 'zod'
import type { Config } from './config.js'
import type { DB } from './db.js'
import type { RedisClient } from './redis.js'
import { adminAuthPlugin } from './auth.js'
import { registerAdminAuditHook } from './admin-audit.js'
import { isProduction } from '@caracalai/core'
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
import { localBootstrapRoutes } from './routes/local-bootstrap.js'

declare module 'fastify' {
  interface FastifyInstance {
    db: DB
    redis: RedisClient
  }
}

export interface AppDeps {
  cfg: Config
  db: DB
  redis: RedisClient
  isDraining?: () => boolean
}

export async function buildApp({ cfg, db, redis, isDraining }: AppDeps) {
  const app = Fastify({
    logger: { level: cfg.logLevel },
    bodyLimit: cfg.bodyLimitBytes,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id']
      const value = Array.isArray(incoming) ? incoming[0] : incoming
      return value && /^[A-Za-z0-9_.\-:]{1,128}$/.test(value) ? value : randomUUID()
    },
    requestIdHeader: 'x-request-id',
    disableRequestLogging: false,
    trustProxy: false,
  })

  app.decorate('db', db)
  app.decorate('redis', redis)

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
    return payload
  })

  await app.register(adminAuthPlugin, { db })
  registerAdminAuditHook(app, { db })

  await app.register(swagger, {
    openapi: {
      info: { title: 'Caracal API', version: '0.1.0' },
      servers: [{ url: `http://localhost:${cfg.port}` }],
    },
  })
  if (!isProduction()) {
    await app.register(swaggerUI, { routePrefix: '/docs' })
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

  if (cfg.localBootstrapEnabled) {
    if (isProduction()) {
      throw new Error('CARACAL_LOCAL_BOOTSTRAP_ENABLED must not be set in production')
    }
    await app.register(localBootstrapRoutes, { prefix: '/v1' })
    app.log.warn('local bootstrap endpoint enabled; loopback-only, non-production only')
  }

  app.get('/health', async () => ({ ok: true }))
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
      await db.query('SELECT 1')
      const pong = await redis.ping()
      if (pong !== 'PONG') throw new Error(`unexpected redis ping reply: ${pong}`)
      return { ok: true }
    } catch (err) {
      reply.code(503)
      return { ok: false, error: (err as Error).message }
    }
  })

  return app
}
