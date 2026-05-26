// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// API service configuration loaded from environment variables.

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadEnvFile } from 'node:process'
import { getenv, mustGetenv, intEnv, boolEnv, resolveFileSecrets } from '@caracalai/core'

function loadEnvChain(): void {
  const seen = new Set<string>()
  const candidates: string[] = []
  const mode = process.env.CARACAL_MODE
  const isDevMode = mode === 'dev' && process.env.NODE_ENV !== 'production'

  if (process.env.CARACAL_ENV_FILE) candidates.push(resolve(process.env.CARACAL_ENV_FILE))
  if (isDevMode && process.env.CARACAL_REPO_ROOT) {
    candidates.push(join(process.env.CARACAL_REPO_ROOT, 'infra', 'docker', 'local.env'))
    candidates.push(join(process.env.CARACAL_REPO_ROOT, 'infra', 'docker', 'dev.env'))
  }
  if (!isDevMode && process.env.CARACAL_HOME) {
    candidates.push(join(process.env.CARACAL_HOME, 'caracal.env'))
  }

  for (const path of candidates) {
    if (seen.has(path)) continue
    seen.add(path)
    if (existsSync(path)) loadEnvFile(path)
  }
}

loadEnvChain()
resolveFileSecrets([
  'DATABASE_URL',
  'REDIS_URL',
  'CARACAL_ADMIN_TOKEN',
  'ZONE_KEK',
  'STREAMS_HMAC_KEY',
  'AUDIT_HMAC_KEY',
  'GATEWAY_STS_HMAC_KEY',
])

export interface Config {
  port: number
  host: string
  databaseUrl: string
  redisUrl: string
  stsUrl: string
  gatewayStsHmacKey: Buffer | null
  logLevel: string
  bootstrapAdminToken: string | null
  shutdownGraceMs: number
  workerId: string
  bodyLimitBytes: number
  requestTimeoutMs: number
  db: {
    poolMax: number
    statementTimeoutMs: number
    idleInTxTimeoutMs: number
    connectionTimeoutMs: number
    idleTimeoutMs: number
  }
  outbox: {
    pollIntervalMs: number
    batchSize: number
    lockDurationSec: number
    maxAttempts: number
    streamMaxLen: number
  }
  readyRateLimitPerMin: number
  v1RateLimitPerMin: number
  adminAuthFailLimitPerMin: number
  lastUsedDebounceSec: number
  maxResourcesPerZone: number
  trustProxy: boolean
  enableDocs: boolean
  metricsBearer: string | null
}

function deriveWorkerId(): string {
  return process.env.WORKER_ID
    ?? `${process.env.HOSTNAME ?? 'api'}:${process.pid}`
}

export function loadConfig(): Config {
  const gatewayStsHmacKey = process.env.GATEWAY_STS_HMAC_KEY
    ? Buffer.from(process.env.GATEWAY_STS_HMAC_KEY, 'hex')
    : null
  if (gatewayStsHmacKey && gatewayStsHmacKey.length < 32) {
    throw new Error('GATEWAY_STS_HMAC_KEY must be hex-encoded with at least 32 bytes')
  }
  return {
    port: intEnv('PORT', 3000, 1),
    host: getenv('HOST', process.env.CARACAL_MODE === 'rc' || process.env.CARACAL_MODE === 'stable' ? '0.0.0.0' : '127.0.0.1'),
    databaseUrl: mustGetenv('DATABASE_URL'),
    redisUrl: mustGetenv('REDIS_URL'),
    stsUrl: getenv('STS_URL', 'http://localhost:8080'),
    gatewayStsHmacKey,
    logLevel: getenv('LOG_LEVEL', 'info'),
    bootstrapAdminToken: process.env.CARACAL_ADMIN_TOKEN ?? null,
    shutdownGraceMs: intEnv('SHUTDOWN_GRACE_MS', 15_000, 1),
    workerId: deriveWorkerId(),
    bodyLimitBytes: intEnv('API_BODY_LIMIT_BYTES', 1_048_576, 1),
    requestTimeoutMs: intEnv('REQUEST_TIMEOUT_MS', 30_000, 1),
    db: {
      poolMax: intEnv('DB_POOL_MAX', 20, 1),
      statementTimeoutMs: intEnv('DB_STATEMENT_TIMEOUT_MS', 15_000, 1),
      idleInTxTimeoutMs: intEnv('DB_IDLE_IN_TX_TIMEOUT_MS', 30_000, 1),
      connectionTimeoutMs: intEnv('DB_CONNECTION_TIMEOUT_MS', 5_000, 1),
      idleTimeoutMs: intEnv('DB_IDLE_TIMEOUT_MS', 30_000, 1),
    },
    outbox: {
      pollIntervalMs: intEnv('OUTBOX_POLL_MS', 250, 1),
      batchSize: intEnv('OUTBOX_BATCH_SIZE', 32, 1),
      lockDurationSec: intEnv('OUTBOX_LOCK_SEC', 30, 1),
      maxAttempts: intEnv('OUTBOX_MAX_ATTEMPTS', 100, 1),
      streamMaxLen: intEnv('OUTBOX_STREAM_MAXLEN', 100_000, 1),
    },
    readyRateLimitPerMin: intEnv('READY_RATE_LIMIT_PER_MIN', 120, 0),
    v1RateLimitPerMin: intEnv('API_V1_RATE_LIMIT_PER_MIN', 600, 0),
    adminAuthFailLimitPerMin: intEnv('ADMIN_AUTH_FAIL_LIMIT_PER_MIN', 60, 0),
    lastUsedDebounceSec: intEnv('ADMIN_TOKEN_LAST_USED_DEBOUNCE_SEC', 60, 0),
    maxResourcesPerZone: intEnv('API_MAX_RESOURCES_PER_ZONE', 100_000, 0),
    trustProxy: boolEnv('TRUST_PROXY', false),
    enableDocs: boolEnv('API_ENABLE_DOCS', true),
    metricsBearer: process.env.METRICS_BEARER ?? null,
  }
}
