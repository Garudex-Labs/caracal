// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Coordinator configuration loaded strictly from environment.

import { getenv, mustGetenv, intEnv, boolEnv } from '@caracalai/core'

/**
 * Coordinator JWT audience. The STS issues ambient tokens with `aud=[ISSUER_URL]`
 * (see services/sts/internal/jwt.go issueToken). Verification must use the same
 * value; there is no second source of truth.
 */

function buildCfg() {
  const issuerUrl = mustGetenv('ISSUER_URL')
  return {
    port: intEnv('PORT', 4000),
    host: getenv('HOST', '127.0.0.1'),
    databaseUrl: mustGetenv('DATABASE_URL'),
    redisUrl: mustGetenv('REDIS_URL'),
    stsUrl: mustGetenv('STS_URL'),
    issuerUrl,
    audience: issuerUrl,
    requiredScope: mustGetenv('AGENT_COORDINATOR_SCOPE'),
    dbPoolMax: intEnv('DB_POOL_MAX', 20),
    dbStatementTimeoutMs: intEnv('DB_STATEMENT_TIMEOUT_MS', 10_000),
    dbConnectionTimeoutMs: intEnv('DB_CONNECTION_TIMEOUT_MS', 5_000),
    dbIdleTimeoutMs: intEnv('DB_IDLE_TIMEOUT_MS', 30_000),
    outboxIntervalMs: intEnv('OUTBOX_INTERVAL_MS', 1_000),
    outboxBatchSize: intEnv('OUTBOX_BATCH_SIZE', 50),
    outboxMaxAttempts: intEnv('OUTBOX_MAX_ATTEMPTS', 10),
    streamsMaxLen: intEnv('STREAMS_MAXLEN', 100_000),
    ttlSweepIntervalMs: intEnv('TTL_SWEEP_INTERVAL_MS', 60_000),
    deadlineSweepIntervalMs: intEnv('DEADLINE_SWEEP_INTERVAL_MS', 5_000),
    sweeperBatchSize: intEnv('SWEEPER_BATCH_SIZE', 500),
    retentionCleanupIntervalMs: intEnv('RETENTION_CLEANUP_INTERVAL_MS', 900_000),
    retentionCleanupBatchSize: intEnv('RETENTION_CLEANUP_BATCH_SIZE', 500),
    delegationRetentionDays: intEnv('DELEGATION_RETENTION_DAYS', 90),
    outboxRetentionDays: intEnv('OUTBOX_RETENTION_DAYS', 7),
    shutdownGraceMs: intEnv('SHUTDOWN_GRACE_MS', 15_000),
    requestTimeoutMs: intEnv('REQUEST_TIMEOUT_MS', 30_000),
    jwksCacheMax: intEnv('JWKS_CACHE_MAX', 256),
    verifyRateLimitPerMin: intEnv('VERIFY_RATE_LIMIT_PER_MIN', 60, 0),
    invocationRateLimitPerMin: intEnv('INVOCATION_RATE_LIMIT_PER_MIN', 120, 0),
    v1RateLimitPerMin: intEnv('V1_RATE_LIMIT_PER_MIN', 300, 0),
    coordinatorRateLimitPerMin: intEnv('COORDINATOR_RATE_LIMIT_PER_MIN', 600, 0),
    dedupeWindowSec: intEnv('RELAY_DEDUPE_WINDOW_SEC', 3600),
    logLevel: getenv('LOG_LEVEL', 'info'),
    trustProxy: boolEnv('TRUST_PROXY', false),
  }
}

export type Cfg = ReturnType<typeof buildCfg>

export const cfg: Cfg = buildCfg()
