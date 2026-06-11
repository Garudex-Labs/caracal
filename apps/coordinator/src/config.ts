// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Coordinator configuration loaded strictly from environment.

import { getenv, mustGetenv, intEnv, boolEnv, resolveFileSecrets } from '@caracalai/core'

resolveFileSecrets(['DATABASE_URL', 'REDIS_URL', 'STREAMS_HMAC_KEY', 'AUDIT_HMAC_KEY', 'CARACAL_COORDINATOR_TOKEN', 'METRICS_BEARER'])

/**
 * Coordinator JWT audience. The STS issues ambient tokens with `aud=[ISSUER_URL]`
 * (see services/sts/internal/jwt.go issueToken). Verification must use the same
 * value; there is no second source of truth.
 */

function buildCfg() {
  const issuerUrl = mustGetenv('ISSUER_URL')
  const auditHmacKey = process.env.AUDIT_HMAC_KEY ? Buffer.from(process.env.AUDIT_HMAC_KEY, 'hex') : null
  if (auditHmacKey && auditHmacKey.length < 32) {
    throw new Error('AUDIT_HMAC_KEY must be hex-encoded with at least 32 bytes')
  }
  return {
    port: intEnv('PORT', 4000),
    host: getenv('HOST', process.env.CARACAL_MODE === 'rc' || process.env.CARACAL_MODE === 'stable' ? '0.0.0.0' : '127.0.0.1'),
    databaseUrl: mustGetenv('DATABASE_URL'),
    redisUrl: mustGetenv('REDIS_URL'),
    stsUrl: mustGetenv('STS_URL'),
    issuerUrl,
    audience: issuerUrl,
    requiredScope: mustGetenv('AGENT_COORDINATOR_SCOPE'),
    coordinatorToken: getenv('CARACAL_COORDINATOR_TOKEN', ''),
    metricsBearer: getenv('METRICS_BEARER', ''),
    dbPoolMax: intEnv('DB_POOL_MAX', 20),
    dbStatementTimeoutMs: intEnv('DB_STATEMENT_TIMEOUT_MS', 10_000),
    dbConnectionTimeoutMs: intEnv('DB_CONNECTION_TIMEOUT_MS', 5_000),
    dbIdleTimeoutMs: intEnv('DB_IDLE_TIMEOUT_MS', 30_000),
    outboxIntervalMs: intEnv('OUTBOX_INTERVAL_MS', 1_000),
    outboxBatchSize: intEnv('OUTBOX_BATCH_SIZE', 50),
    outboxMaxAttempts: intEnv('OUTBOX_MAX_ATTEMPTS', 10),
    streamsMaxLen: intEnv('STREAMS_MAXLEN', 100_000),
     ttlSweepIntervalMs: intEnv('TTL_SWEEP_INTERVAL_MS', 60_000),
    serviceLeaseSweepIntervalMs: intEnv('SERVICE_LEASE_SWEEP_INTERVAL_MS', 30_000),
    serviceAgentLeaseSeconds: intEnv('SERVICE_AGENT_LEASE_SECONDS', 120),
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
    readyRateLimitPerMin: intEnv('READY_RATE_LIMIT_PER_MIN', 120, 0),
    dedupeWindowSec: intEnv('RELAY_DEDUPE_WINDOW_SEC', 3600),
    logLevel: getenv('LOG_LEVEL', 'info'),
    trustProxy: boolEnv('TRUST_PROXY', false),
    auditHmacKey,
  }
}

export type Cfg = ReturnType<typeof buildCfg>

export const cfg: Cfg = buildCfg()
