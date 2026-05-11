// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// API service entrypoint: bootstraps deps, wires graceful shutdown, and starts background workers.

import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { newDB } from './db.js'
import { newRedis } from './redis.js'
import { startDCRGC } from './jobs/dcr-gc.js'
import { startSessionsReaper } from './jobs/sessions-reaper.js'
import { runMigrations } from './migrate.js'
import { ShutdownRegistry } from './lifecycle.js'
import { OutboxDispatcher } from './outbox.js'
import { seedBootstrapAdminToken } from './auth.js'

const cfg = loadConfig()
const db = newDB({
  connectionString: cfg.databaseUrl,
  max: cfg.db.poolMax,
  statementTimeoutMs: cfg.db.statementTimeoutMs,
  idleInTxTimeoutMs: cfg.db.idleInTxTimeoutMs,
  connectionTimeoutMs: cfg.db.connectionTimeoutMs,
  idleTimeoutMs: cfg.db.idleTimeoutMs,
  applicationName: cfg.workerId,
})
const redis = newRedis(cfg.redisUrl)

const log = (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>): void => {
  const line = meta ? `${msg} ${JSON.stringify(meta)}` : msg
  process.stdout.write(`[${level}] ${line}\n`)
}

await runMigrations(db, (msg) => log('info', msg))
await seedBootstrapAdminToken(db, {
  envToken: cfg.bootstrapAdminToken,
  log: (msg) => log('info', msg),
})

const shutdown = new ShutdownRegistry({
  timeoutMs: cfg.shutdownTimeoutMs,
  log,
})

const app = await buildApp({ cfg, db, redis, isDraining: () => shutdown.draining })

const dispatcher = new OutboxDispatcher({
  db,
  redis,
  workerId: cfg.workerId,
  batchSize: cfg.outbox.batchSize,
  pollIntervalMs: cfg.outbox.pollIntervalMs,
  lockDurationSec: cfg.outbox.lockDurationSec,
  maxAttempts: cfg.outbox.maxAttempts,
  streamMaxLen: cfg.outbox.streamMaxLen,
  log: (level, msg, meta) => app.log[level]({ ...meta }, msg),
})

const dcrTimer = startDCRGC(db, app.log)
const sessionsReaperTimer = startSessionsReaper(db, app.log)

shutdown.register('dcr-gc-timer', () => { clearInterval(dcrTimer) })
shutdown.register('sessions-reaper', () => { clearInterval(sessionsReaperTimer) })
shutdown.register('outbox-dispatcher', () => dispatcher.stop())
shutdown.register('fastify', () => app.close())
shutdown.register('redis', async () => { await redis.quit() })
shutdown.register('postgres', () => db.end())
shutdown.install()

dispatcher.start()

try {
  await app.listen({ port: cfg.port, host: '0.0.0.0' })
} catch (err) {
  app.log.error(err)
  await shutdown.fire('listen-failed')
}
