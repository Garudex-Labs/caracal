// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Redis client factory for the API service; durable publishes go through the outbox.

import { Redis } from 'ioredis'

export type RedisClient = Redis

export function newRedis(url: string): RedisClient {
  return new Redis(url, {
    lazyConnect: false,
    enableAutoPipelining: true,
    maxRetriesPerRequest: 3,
    keepAlive: 30_000,
    connectTimeout: 10_000,
  })
}

export const STREAM_POLICY_INVALIDATE = 'caracal.policy.invalidate'
export const STREAM_SESSIONS_REVOKE = 'caracal.sessions.revoke'
export const STREAM_AGENTS_LIFECYCLE = 'caracal.agents.lifecycle'

export async function redisMinuteBucket(redis: RedisClient): Promise<number> {
  return Math.floor(await redisTimeMs(redis) / 60_000)
}

export async function redisTimeMs(redis: RedisClient): Promise<number> {
  if (typeof redis.time !== 'function') return Date.now()
  const [seconds, microseconds] = await redis.time()
  const secondsPart = Number(seconds)
  const microsecondsPart = Number(microseconds)
  if (!Number.isFinite(secondsPart) || !Number.isFinite(microsecondsPart)) {
    throw new Error('redis TIME returned an invalid response')
  }
  return secondsPart * 1000 + Math.floor(microsecondsPart / 1000)
}
