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
