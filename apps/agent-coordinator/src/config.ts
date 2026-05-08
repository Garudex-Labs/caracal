// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Agent coordinator configuration loaded strictly from environment.

import { getenv, mustGetenv } from '@caracalai/shared'

function intEnv(key: string, fallback: number, min = 1): number {
  const raw = process.env[key]
  if (raw === undefined || raw === '') return fallback
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < min) {
    throw new Error(`Invalid integer env var ${key}: ${raw}`)
  }
  return n
}

function buildCfg() {
  return {
    port: intEnv('PORT', 4000),
    databaseUrl: mustGetenv('DATABASE_URL'),
    redisUrl: mustGetenv('REDIS_URL'),
    stsUrl: mustGetenv('STS_URL'),
    issuerUrl: mustGetenv('ISSUER_URL'),
    audience: mustGetenv('AGENT_COORDINATOR_AUDIENCE'),
    requiredScope: mustGetenv('AGENT_COORDINATOR_SCOPE'),
    dbPoolMax: intEnv('DB_POOL_MAX', 20),
    dbStatementTimeoutMs: intEnv('DB_STATEMENT_TIMEOUT_MS', 10_000),
    dbConnectionTimeoutMs: intEnv('DB_CONNECTION_TIMEOUT_MS', 5_000),
    dbIdleTimeoutMs: intEnv('DB_IDLE_TIMEOUT_MS', 30_000),
    outboxIntervalMs: intEnv('OUTBOX_INTERVAL_MS', 1_000),
    outboxBatchSize: intEnv('OUTBOX_BATCH_SIZE', 50),
    outboxMaxAttempts: intEnv('OUTBOX_MAX_ATTEMPTS', 10),
    ttlSweepIntervalMs: intEnv('TTL_SWEEP_INTERVAL_MS', 60_000),
    deadlineSweepIntervalMs: intEnv('DEADLINE_SWEEP_INTERVAL_MS', 5_000),
    shutdownGraceMs: intEnv('SHUTDOWN_GRACE_MS', 15_000),
    logLevel: getenv('LOG_LEVEL', 'info'),
  }
}

export type Cfg = ReturnType<typeof buildCfg>

let _cfg: Cfg | undefined

export const cfg: Cfg = new Proxy({} as Cfg, {
  get<K extends keyof Cfg>(_: Cfg, key: K): Cfg[K] {
    _cfg ??= buildCfg()
    return _cfg[key]
  },
})
