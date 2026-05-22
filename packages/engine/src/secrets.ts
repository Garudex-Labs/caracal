// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Single-source-of-truth credential bootstrap for dev and runtime stacks.

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const isPosix = process.platform !== 'win32'

export interface SecretFile {
  envKey: string
  fileName: string
  bytes: number
}

export const SECRET_FILES: readonly SecretFile[] = [
  { envKey: 'POSTGRES_PASSWORD', fileName: 'postgresPassword', bytes: 24 },
  { envKey: 'REDIS_PASSWORD', fileName: 'redisPassword', bytes: 24 },
  { envKey: 'CARACAL_ADMIN_TOKEN', fileName: 'caracalAdminToken', bytes: 32 },
  { envKey: 'CARACAL_COORDINATOR_TOKEN', fileName: 'caracalCoordinatorToken', bytes: 32 },
  { envKey: 'ZONE_KEK', fileName: 'zoneKek', bytes: 32 },
  { envKey: 'AUDIT_HMAC_KEY', fileName: 'auditHmacKey', bytes: 32 },
  { envKey: 'STREAMS_HMAC_KEY', fileName: 'streamsHmacKey', bytes: 32 },
  { envKey: 'GATEWAY_STS_HMAC_KEY', fileName: 'gatewayStsHmacKey', bytes: 32 },
] as const

// DerivedSecrets are composite secret files (e.g. fully formed URLs) materialised
// from primary credentials. They are rewritten on every bootstrap so changes to
// the source credentials propagate without manual intervention.
interface DerivedSecret {
  fileName: string
  render: (values: Record<string, string>) => string
}

const DERIVED_SECRETS: readonly DerivedSecret[] = [
  {
    fileName: 'databaseUrl',
    render: (v) =>
      `postgres://${v.POSTGRES_USER ?? 'caracal'}:${v.POSTGRES_PASSWORD}@postgres:5432/${v.POSTGRES_DB ?? 'caracal'}`,
  },
  {
    fileName: 'redisUrl',
    render: (v) => `redis://:${v.REDIS_PASSWORD}@redis:6379`,
  },
] as const

export interface BootstrapPaths {
  secretsDir: string
  // Postgres role / db name materialised into derived URLs. Read from the env
  // schema defaults; callers pass the resolved values explicitly so this module
  // stays decoupled from any specific override layer.
  postgresUser?: string
  postgresDb?: string
}

export interface BootstrapReport {
  filesCreated: string[]
}

function chmodSafe(path: string, mode: number): void {
  if (!isPosix) return
  try {
    chmodSync(path, mode)
  } catch {
    // permissions may be unsupported on some filesystems
  }
}

function readOrCreateSecretFile(path: string, bytes: number): { value: string; created: boolean } {
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim()
    if (existing.length > 0) {
      chmodSafe(path, 0o444)
      return { value: existing, created: false }
    }
  }
  const value = randomBytes(bytes).toString('hex')
  writeFileSync(path, value, { mode: 0o444 })
  chmodSafe(path, 0o444)
  return { value, created: true }
}

export function bootstrapSecrets(paths: BootstrapPaths): BootstrapReport {
  mkdirSync(paths.secretsDir, { recursive: true })
  chmodSafe(paths.secretsDir, 0o700)

  const filesCreated: string[] = []
  const values: Record<string, string> = {
    POSTGRES_USER: paths.postgresUser ?? 'caracal',
    POSTGRES_DB: paths.postgresDb ?? 'caracal',
  }
  for (const spec of SECRET_FILES) {
    const filePath = resolve(paths.secretsDir, spec.fileName)
    const { value, created } = readOrCreateSecretFile(filePath, spec.bytes)
    values[spec.envKey] = value
    if (created) filesCreated.push(spec.fileName)
  }

  for (const derived of DERIVED_SECRETS) {
    const filePath = resolve(paths.secretsDir, derived.fileName)
    const rendered = derived.render(values)
    const existing = existsSync(filePath) ? readFileSync(filePath, 'utf8').trim() : ''
    if (existing !== rendered) {
      if (existing) chmodSafe(filePath, 0o600)
      writeFileSync(filePath, rendered, { mode: 0o444 })
      chmodSafe(filePath, 0o444)
      if (!existing) filesCreated.push(derived.fileName)
    }
  }

  return { filesCreated }
}

export function devBootstrapPaths(repoRoot: string): BootstrapPaths {
  return {
    secretsDir: resolve(repoRoot, 'infra', 'secrets', 'files'),
  }
}

export function runtimeBootstrapPaths(home: string): BootstrapPaths {
  return {
    secretsDir: resolve(home, 'secrets'),
  }
}
