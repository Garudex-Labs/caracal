// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// API service configuration loaded from environment variables.

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadEnvFile } from 'node:process'
import { getenv, mustGetenv } from '@caracalai/core'

function loadEnvChain(): void {
  const seen = new Set<string>()
  const candidates: string[] = []

  if (process.env.CARACAL_ENV_FILE) candidates.push(resolve(process.env.CARACAL_ENV_FILE))
  if (process.env.CARACAL_REPO_ROOT) {
    candidates.push(join(process.env.CARACAL_REPO_ROOT, 'infra', 'docker', '.env'))
  }

  for (const path of candidates) {
    if (seen.has(path)) continue
    seen.add(path)
    if (existsSync(path)) loadEnvFile(path)
  }
}

loadEnvChain()

export interface Config {
  port: number
  host: string
  databaseUrl: string
  redisUrl: string
  logLevel: string
  bootstrapAdminToken: string | null
  localBootstrapEnabled: boolean
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
  trustProxy: boolean
}

function buildDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const user = encodeURIComponent(mustGetenv('POSTGRES_USER'))
  const password = encodeURIComponent(mustGetenv('POSTGRES_PASSWORD'))
  const host = getenv('POSTGRES_HOST', 'localhost')
  const port = getenv('POSTGRES_PORT', '5432')
  const db = mustGetenv('POSTGRES_DB')
  return `postgres://${user}:${password}@${host}:${port}/${db}`
}

function buildRedisUrl(): string {
  if (process.env.REDIS_URL) return process.env.REDIS_URL
  const password = encodeURIComponent(mustGetenv('REDIS_PASSWORD'))
  const host = getenv('REDIS_HOST', 'localhost')
  const port = getenv('REDIS_PORT', '6379')
  return `redis://:${password}@${host}:${port}`
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback
  return value === '1' || value.toLowerCase() === 'true'
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function parseNonNegIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function deriveWorkerId(): string {
  return process.env.WORKER_ID
    ?? `${process.env.HOSTNAME ?? 'api'}:${process.pid}`
}

export function loadConfig(): Config {
  return {
    port: parseIntEnv('PORT', 3000),
    host: getenv('HOST', '127.0.0.1'),
    databaseUrl: buildDatabaseUrl(),
    redisUrl: buildRedisUrl(),
    logLevel: getenv('LOG_LEVEL', 'info'),
    bootstrapAdminToken: process.env.CARACAL_ADMIN_TOKEN ?? null,
    localBootstrapEnabled: parseBool(process.env.CARACAL_LOCAL_BOOTSTRAP_ENABLED, false),
    shutdownGraceMs: parseIntEnv('SHUTDOWN_GRACE_MS', 15_000),
    workerId: deriveWorkerId(),
    bodyLimitBytes: parseIntEnv('API_BODY_LIMIT_BYTES', 1_048_576),
    requestTimeoutMs: parseIntEnv('REQUEST_TIMEOUT_MS', 30_000),
    db: {
      poolMax: parseIntEnv('DB_POOL_MAX', 20),
      statementTimeoutMs: parseIntEnv('DB_STATEMENT_TIMEOUT_MS', 15_000),
      idleInTxTimeoutMs: parseIntEnv('DB_IDLE_IN_TX_TIMEOUT_MS', 30_000),
      connectionTimeoutMs: parseIntEnv('DB_CONNECTION_TIMEOUT_MS', 5_000),
      idleTimeoutMs: parseIntEnv('DB_IDLE_TIMEOUT_MS', 30_000),
    },
    outbox: {
      pollIntervalMs: parseIntEnv('OUTBOX_POLL_MS', 250),
      batchSize: parseIntEnv('OUTBOX_BATCH_SIZE', 32),
      lockDurationSec: parseIntEnv('OUTBOX_LOCK_SEC', 30),
      maxAttempts: parseIntEnv('OUTBOX_MAX_ATTEMPTS', 100),
      streamMaxLen: parseIntEnv('OUTBOX_STREAM_MAXLEN', 100_000),
    },
    readyRateLimitPerMin: parseNonNegIntEnv('READY_RATE_LIMIT_PER_MIN', 120),
    v1RateLimitPerMin: parseNonNegIntEnv('API_V1_RATE_LIMIT_PER_MIN', 600),
    adminAuthFailLimitPerMin: parseNonNegIntEnv('ADMIN_AUTH_FAIL_LIMIT_PER_MIN', 60),
    lastUsedDebounceSec: parseNonNegIntEnv('ADMIN_TOKEN_LAST_USED_DEBOUNCE_SEC', 60),
    trustProxy: parseBool(process.env.TRUST_PROXY, false),
  }
}
