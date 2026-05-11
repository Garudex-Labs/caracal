// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Redis client lifecycle for the coordinator outbox publisher.

import { Redis } from 'ioredis'
import { cfg } from './config.js'

let client: Redis | undefined

export function buildRedis(): Redis {
  client ??= new Redis(cfg.redisUrl, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  })
  return client
}

export async function closeRedis(): Promise<void> {
  if (!client) return
  try {
    await client.quit()
  } catch {
    client.disconnect()
  } finally {
    client = undefined
  }
}

export const redis = new Proxy({} as Redis, {
  get(_target, prop) {
    return Reflect.get(buildRedis(), prop)
  },
})
