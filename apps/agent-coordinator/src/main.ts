// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Agent coordinator service entry point.

import { buildApp } from './app.js'
import { db } from './db.js'
import { redis } from './redis.js'
import { startOutboxPublisher } from './jobs/outbox-publisher.js'
import { startTTLSweeper } from './jobs/ttl-sweeper.js'
import { cfg } from './config.js'

const app = await buildApp()
startTTLSweeper(db)
startOutboxPublisher(db, redis)

try {
  await app.listen({ port: cfg.port, host: '0.0.0.0' })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
