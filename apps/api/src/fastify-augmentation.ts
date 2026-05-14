// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// FastifyInstance augmentation for API services. Kept in a dedicated module so
// route tests can import this file and share the same instance typing as buildApp.

import type { DB } from './db.js'
import type { RedisClient } from './redis.js'

declare module 'fastify' {
  interface FastifyInstance {
    db: DB
    redis: RedisClient
  }
}

export {}
