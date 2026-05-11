// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Coordinator service entry point with graceful shutdown.

import { buildApp } from './app.js'
import { db } from './db.js'
import { buildRedis, closeRedis } from './redis.js'
import { startOutboxPublisher } from './jobs/outbox-publisher.js'
import { startTTLSweeper } from './jobs/ttl-sweeper.js'
import { startDeadlineEnforcer } from './jobs/deadline-enforcer.js'
import { startRetentionCleaner } from './jobs/retention-cleaner.js'
import { cfg } from './config.js'

const app = await buildApp()
const redis = buildRedis()
const log = app.log
const outbox = startOutboxPublisher(db, redis, { log })
const ttl = startTTLSweeper(db, { log })
const deadline = startDeadlineEnforcer(db, { log })
const retention = startRetentionCleaner(db, { log })

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  app.log.info({ signal }, 'shutdown_begin')
  const grace = setTimeout(() => {
    app.log.error('shutdown_timeout_force_exit')
    process.exit(1)
  }, cfg.shutdownGraceMs)
  grace.unref()
  try {
    await app.close()
    await Promise.all([outbox.stop(), ttl.stop(), deadline.stop(), retention.stop()])
    await db.end()
    await closeRedis()
    app.log.info('shutdown_complete')
    process.exit(0)
  } catch (err) {
    app.log.error({ err }, 'shutdown_failed')
    process.exit(1)
  }
}

process.on('SIGTERM', () => { void shutdown('SIGTERM') })
process.on('SIGINT', () => { void shutdown('SIGINT') })

try {
  await app.listen({ port: cfg.port, host: '0.0.0.0' })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
