// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Fastify app factory: registers plugins, decorations, and all route handlers.

import Fastify from 'fastify'
import swagger from '@fastify/swagger'
import swaggerUI from '@fastify/swagger-ui'
import { timingSafeEqual } from 'crypto'
import type { Config } from './config.js'
import type { DB } from './db.js'
import type { RedisClient } from './redis.js'
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

interface AppDeps {
  cfg: Config
  db: DB
  redis: RedisClient
}

export async function buildApp({ cfg, db, redis }: AppDeps) {
  const app = Fastify({
    logger: { level: cfg.logLevel },
  })

  app.decorate('db', db)
  app.decorate('redis', redis)

  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/v1/')) return

    const auth = req.headers.authorization
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : ''
    const expected = Buffer.from(cfg.adminToken)
    const actual = Buffer.from(token)

    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return reply.code(401).send({ error: 'invalid_admin_token' })
    }
  })

  await app.register(swagger, {
    openapi: {
      info: { title: 'Caracal API', version: '0.1.0' },
      servers: [{ url: `http://localhost:${cfg.port}` }],
    },
  })
  await app.register(swaggerUI, { routePrefix: '/docs' })

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
  await app.register(localBootstrapRoutes, { prefix: '/v1' })

  app.get('/health', async () => ({ ok: true }))
  app.get('/ready', async () => {
    await db.query('SELECT 1')
    return { ok: true }
  })

  return app
}
