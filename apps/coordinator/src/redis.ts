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

export async function redisMinuteBucket(redis: Redis): Promise<number> {
  return Math.floor(await redisTimeMs(redis) / 60_000)
}

export async function redisTimeMs(redis: Redis): Promise<number> {
  if (typeof redis.time !== 'function') return Date.now()
  const [seconds, microseconds] = await redis.time()
  const secondsPart = Number(seconds)
  const microsecondsPart = Number(microseconds)
  if (!Number.isFinite(secondsPart) || !Number.isFinite(microsecondsPart)) {
    throw new Error('redis TIME returned an invalid response')
  }
  return secondsPart * 1000 + Math.floor(microsecondsPart / 1000)
}

export async function closeRedis(client: Redis): Promise<void> {
  try {
    await client.quit()
  } catch {
    client.disconnect()
  }
}
