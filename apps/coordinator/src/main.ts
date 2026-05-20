// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Coordinator service entry point with graceful shutdown.

import { buildApp } from './app.js'
import { buildDB } from './db.js'
import { buildRedis, closeRedis } from './redis.js'
import { startOutboxPublisher } from './jobs/outbox-publisher.js'
import { startTTLSweeper } from './jobs/ttl-sweeper.js'
import { startDeadlineEnforcer } from './jobs/deadline-enforcer.js'
import { startRetentionCleaner } from './jobs/retention-cleaner.js'
import { cfg } from './config.js'
import { assertPublishedSafe, createLogger, ShutdownRegistry, withTimeout } from '@caracalai/core'

assertPublishedSafe()

const bootstrapLog = createLogger('coordinator-bootstrap', (cfg.logLevel ?? 'info') as 'debug' | 'info' | 'warn' | 'error' | 'fatal')
const log = (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>): void => {
  bootstrapLog[level](msg, meta)
}

process.on('unhandledRejection', (reason) => {
  log('error', 'unhandledRejection', { reason: reason instanceof Error ? reason.stack ?? reason.message : String(reason) })
  process.exit(1)
})
process.on('uncaughtException', (err) => {
  log('error', 'uncaughtException', { stack: err.stack ?? err.message })
  process.exit(1)
})

const db = buildDB(cfg)
const redis = buildRedis(cfg)

const shutdown = new ShutdownRegistry({
  timeoutMs: cfg.shutdownGraceMs,
  log,
})
shutdown.register('redis', () => closeRedis(redis))
shutdown.register('postgres', () => db.end())
shutdown.install()

try {
  await withTimeout(redis.ping(), cfg.shutdownGraceMs, 'startup redis ping timed out')
  await withTimeout(db.query('SELECT 1'), cfg.shutdownGraceMs, 'startup postgres ping timed out')

  const app = await buildApp({ cfg, db, redis, isDraining: () => shutdown.draining })

  const outbox = startOutboxPublisher(db, redis, { log: app.log })
  const ttl = startTTLSweeper(db, { log: app.log })
  const deadline = startDeadlineEnforcer(db, { log: app.log })
  const retention = startRetentionCleaner(db, { log: app.log })

  shutdown.register('retention-cleaner', () => retention.stop())
  shutdown.register('deadline-enforcer', () => deadline.stop())
  shutdown.register('ttl-sweeper', () => ttl.stop())
  shutdown.register('outbox-publisher', () => outbox.stop())
  shutdown.register('fastify', () => app.close())

  try {
    await app.listen({ port: cfg.port, host: cfg.host })
  } catch (err) {
    app.log.error(err)
    await shutdown.fire('listen-failed', 1)
  }
} catch (err) {
  const reason = err instanceof Error ? err.message : String(err)
  log('error', `startup failed: ${reason}`)
  await shutdown.fire('startup-failed', 1)
}
