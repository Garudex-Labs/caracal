// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared resolution of the web console auth service's PostgreSQL store and signing secret.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { devSecretsHome } from '@caracalai/server-core'
import { OPERATOR_ALLOWLIST_DIR, OPERATOR_ALLOWLIST_FILE } from '@caracalai/engine'

// The auth service keeps operator identity in its own dedicated database, isolated from the
// control-plane schema so neither side's migrations or table names can collide.
export const AUTH_DATABASE_NAME = 'caracal_auth'

const DEV_HOST = 'localhost'
const DEV_PORT = 5432

function readDevSecret(file: string): string | undefined {
  const path = join(devSecretsHome(), file)
  if (!existsSync(path)) return undefined
  const value = readFileSync(path, 'utf8').trim()
  return value.length > 0 ? value : undefined
}

function postgresUser(): string {
  return process.env.POSTGRES_USER ?? 'caracal'
}

function postgresMaintenanceDb(): string {
  return process.env.POSTGRES_DB ?? 'caracal'
}

// Build a host-facing connection string for one database from the generated dev password.
// `caracal up` publishes Postgres on localhost:5432, so the locally launched auth process
// reaches the same database the containers use. Returns undefined when no dev stack secret
// is present (e.g. the stack was never started).
function devUrl(dbName: string): string | undefined {
  const password = readDevSecret('postgresPassword')
  if (!password) return undefined
  const user = encodeURIComponent(postgresUser())
  return `postgres://${user}:${encodeURIComponent(password)}@${DEV_HOST}:${DEV_PORT}/${dbName}`
}

// The auth service database URL for a local `caracal web` session.
export function devAuthDatabaseUrl(): string | undefined {
  return devUrl(AUTH_DATABASE_NAME)
}

// The Console sign-in allowlist a local `caracal web` session enforces, defaulting to the
// same file `caracal allowlist` writes so host-side admission changes apply without wiring.
export function devAllowlistFile(): string {
  return join(devSecretsHome(), OPERATOR_ALLOWLIST_DIR, OPERATOR_ALLOWLIST_FILE)
}

// Returns the auth database name, derived from an explicitly configured URL when present so
// purge targets the database the operator actually runs, otherwise the dev default.
export function configuredAuthDatabaseName(): string {
  const url = process.env.CARACAL_AUTH_DATABASE_URL ?? process.env.DATABASE_URL
  if (url) {
    try {
      const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
      if (name) return name
    } catch {
      /* fall through to the default */
    }
  }
  return AUTH_DATABASE_NAME
}

// A connection string to a maintenance database on the same server, used to create or drop
// the auth database (which cannot be the connection's own database). Derived from an explicit
// auth URL when configured, otherwise from the dev stack credentials.
export function authMaintenanceUrl(): string | undefined {
  const explicit = process.env.CARACAL_AUTH_DATABASE_URL ?? process.env.DATABASE_URL
  if (explicit) {
    try {
      const url = new URL(explicit)
      url.pathname = `/${postgresMaintenanceDb()}`
      return url.toString()
    } catch {
      return undefined
    }
  }
  return devUrl(postgresMaintenanceDb())
}

// The session-signing secret for the auth service. Generated once and reused so dev sessions
// survive restarts, and provisioned automatically - operators never set a secret by hand for
// local development.
export function devAuthSecret(): string {
  const existing = readDevSecret('authSecret')
  if (existing) return existing
  const dir = devSecretsHome()
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'authSecret')
  const value = randomBytes(32).toString('hex')
  try {
    writeFileSync(path, value, { mode: 0o600, flag: 'wx' })
    return value
  } catch {
    // A concurrent launcher may have created it first; prefer the persisted value.
    return readDevSecret('authSecret') ?? value
  }
}
