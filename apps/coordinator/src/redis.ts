// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Redis client lifecycle for the coordinator outbox publisher.

import { Redis } from 'ioredis'
import { cfg, type Cfg } from './config.js'

export function buildRedis(config: Cfg = cfg): Redis {
  return new Redis(config.redisUrl, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  })
}

export async function closeRedis(client: Redis): Promise<void> {
  try {
    await client.quit()
  } catch {
    client.disconnect()
  }
}
