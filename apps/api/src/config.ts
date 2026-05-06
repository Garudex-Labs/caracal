// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// API service configuration loaded from environment variables.

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { loadEnvFile } from 'node:process'
import { getenv, mustGetenv } from '@caracalai/shared'

function loadEnvChain(): void {
  const seen = new Set<string>()
  const candidates: string[] = []

  if (process.env.CARACAL_ENV_FILE) candidates.push(process.env.CARACAL_ENV_FILE)
  candidates.push(resolve(process.cwd(), '.env'))

  let dir = process.cwd()
  for (let depth = 0; depth < 6; depth++) {
    candidates.push(join(dir, 'infra', 'docker', '.env'))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
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
  databaseUrl: string
  redisUrl: string
  logLevel: string
  bootstrapAdminToken: string | null
  localBootstrapEnabled: boolean
  shutdownTimeoutMs: number
  workerId: string
  outbox: {
    pollIntervalMs: number
    batchSize: number
    lockDurationSec: number
    maxAttempts: number
  }
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

function deriveWorkerId(): string {
  return process.env.CARACAL_WORKER_ID
    ?? `${process.env.HOSTNAME ?? 'api'}:${process.pid}`
}

export function loadConfig(): Config {
  return {
    port: parseIntEnv('PORT', 3000),
    databaseUrl: buildDatabaseUrl(),
    redisUrl: buildRedisUrl(),
    logLevel: getenv('LOG_LEVEL', 'info'),
    bootstrapAdminToken: process.env.CARACAL_ADMIN_TOKEN ?? null,
    localBootstrapEnabled: parseBool(process.env.CARACAL_LOCAL_BOOTSTRAP_ENABLED, false),
    shutdownTimeoutMs: parseIntEnv('CARACAL_SHUTDOWN_TIMEOUT_MS', 15_000),
    workerId: deriveWorkerId(),
    outbox: {
      pollIntervalMs: parseIntEnv('CARACAL_OUTBOX_POLL_MS', 250),
      batchSize: parseIntEnv('CARACAL_OUTBOX_BATCH', 32),
      lockDurationSec: parseIntEnv('CARACAL_OUTBOX_LOCK_SEC', 30),
      maxAttempts: parseIntEnv('CARACAL_OUTBOX_MAX_ATTEMPTS', 100),
    },
  }
}
