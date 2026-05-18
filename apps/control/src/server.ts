// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Control HTTP server: wires /health, /ready, and /v1/control/invoke through the shared engine dispatch.

import Fastify, { type FastifyInstance } from 'fastify'
import { Redis } from 'ioredis'
import { AdminClient } from '@caracalai/admin'
import type { Logger } from '@caracalai/core'
import { Authenticator } from './auth.js'
import { LogSink, RedisSink, type EventSink } from './audit.js'
import type { Config } from './config.js'
import { registerInvokeRoute } from './handler.js'
import { RateLimiter } from './ratelimit.js'
import { MemoryReplay, RedisReplay, type Replay } from './replay.js'

export interface ServerDeps {
  app: FastifyInstance
  close(): Promise<void>
}

export async function buildServer(cfg: Config, log: Logger): Promise<ServerDeps> {
  const auth = new Authenticator({
    jwksUrl: cfg.jwksUrl,
    issuer: cfg.issuer,
    audience: cfg.audience,
  })

  let replay: Replay
  let auditSink: EventSink
  let redis: Redis | undefined
  let auditRedis: Redis | undefined

  if (cfg.redisUrl) {
    redis = new Redis(cfg.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 3 })
    replay = new RedisReplay(redis, cfg.replayTtlSec * 1000)
    log.info('replay cache: redis (multi-replica safe)')
    auditRedis = new Redis(cfg.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 3 })
    await auditRedis.ping()
    auditSink = new RedisSink(auditRedis, cfg.auditHmacKey, log)
  } else {
    replay = new MemoryReplay(cfg.replayTtlSec * 1000)
    log.info('replay cache: in-memory (single replica)')
    auditSink = new LogSink(log)
    log.warn('control audit sink: log-only')
  }

  const rate = new RateLimiter(cfg.rateCapacity, cfg.rateWindowSec * 1000)
  const admin = new AdminClient({ apiUrl: cfg.apiUrl, adminToken: cfg.apiToken })

  const app = Fastify({
    logger: { level: cfg.logLevel },
    bodyLimit: 64 * 1024,
    requestIdHeader: 'x-request-id',
  })

  app.get('/health', async (_req, reply) => reply.code(200).send())
  app.get('/ready', async (_req, reply) => {
    try {
      await replay.ping()
      return reply.code(200).send()
    } catch (err) {
      log.warn('readiness: replay backing store unavailable', { err: String(err) })
      return reply.code(503).send({ error: 'replay store unavailable' })
    }
  })

  registerInvokeRoute(app, { auth, replay, rate, sink: auditSink, ctx: { admin } })

  return {
    app,
    close: async () => {
      await app.close()
      if (redis) await redis.quit()
      if (auditRedis) await auditRedis.quit()
    },
  }
}
