// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared API app test helpers: builds a Config and DB mock that satisfies admin-token auth.

import { createHash } from 'node:crypto'
import { vi } from 'vitest'
import type { Config } from '../../../../apps/api/src/config.js'

export interface ApiDepsOptions {
  adminToken?: string
  adminScope?: 'global' | 'zone'
  adminZoneId?: string | null
}

export interface ApiDeps {
  cfg: Config
  db: { query: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> }
  redis: { xadd: ReturnType<typeof vi.fn>; ping: ReturnType<typeof vi.fn>; quit: ReturnType<typeof vi.fn> }
}

export function apiAppDeps(opts: ApiDepsOptions = {}): ApiDeps {
  const adminToken = opts.adminToken ?? 'admin-secret'
  const adminScope = opts.adminScope ?? 'global'
  const adminZoneId = opts.adminZoneId ?? null
  const adminDigest = createHash('sha256').update(adminToken).digest()

  const db = {
    query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('FROM admin_tokens') && Array.isArray(params)) {
        const candidate = params[0]
        if (Buffer.isBuffer(candidate) && candidate.equals(adminDigest)) {
          return Promise.resolve({
            rows: [{
              id: 'token-test',
              name: 'test',
              scope: adminScope,
              zone_id: adminZoneId,
              token_sha256: adminDigest,
              revoked_at: null,
            }],
            rowCount: 1,
          })
        }
        return Promise.resolve({ rows: [], rowCount: 0 })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    }),
    connect: vi.fn(),
  }

  const redis = {
    xadd: vi.fn(),
    ping: vi.fn().mockResolvedValue('PONG'),
    quit: vi.fn().mockResolvedValue('OK'),
  }

  const cfg: Config = {
    port: 0,
    databaseUrl: 'postgres://localhost/caracal',
    redisUrl: 'redis://localhost:6379',
    logLevel: 'silent',
    bootstrapAdminToken: null,
    localBootstrapEnabled: false,
    shutdownTimeoutMs: 1000,
    workerId: 'test:0',
    bodyLimitBytes: 1_048_576,
    outbox: {
      pollIntervalMs: 1000,
      batchSize: 8,
      lockDurationSec: 5,
      maxAttempts: 3,
      streamMaxLen: 10_000,
    },
  }

  return { cfg, db, redis }
}
