// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// PostgreSQL database handle for the Community Edition authentication service.

import type { BetterAuthOptions } from 'better-auth'
import pg from 'pg'

import { loadConfig, type PostgresSsl } from './config.ts'

const cfg = loadConfig()

function sslOption(ssl: PostgresSsl): pg.PoolConfig['ssl'] {
  if (ssl === 'disable') return undefined
  return { rejectUnauthorized: ssl === 'require' }
}

function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// Tolerate Postgres still coming up: the migration job and a fresh local stack can both start
// before the database accepts connections. Bounded retries mirror the SQL migrator so both
// provisioning paths behave identically. A non-positive retry budget means "try once".
const CONNECT_RETRIES = Math.max(0, Number(process.env.MIGRATION_CONNECT_RETRIES ?? 30))
const CONNECT_SLEEP_MS = Math.max(0, Number(process.env.MIGRATION_CONNECT_SLEEP_SECONDS ?? 1)) * 1000

// Better Auth runs the table migrations, but the database itself must exist first. Create it
// idempotently through a maintenance connection so a fresh local stack, a post-purge run, or the
// dedicated migration job comes up without manual provisioning. The connection phase is retried
// so a not-yet-ready Postgres does not fail the run; a failure to create the database (already
// present, or insufficient privilege) is non-fatal because the schema step that follows surfaces
// any real problem loudly.
async function ensureDatabaseExists(url: string, ssl: PostgresSsl): Promise<void> {
  const name = databaseName(url)
  if (!name) return
  const maintenance = new URL(url)
  maintenance.pathname = '/postgres'
  for (let attempt = 0; ; attempt++) {
    const client = new pg.Client({ connectionString: maintenance.toString(), ssl: sslOption(ssl) })
    let connected = false
    try {
      await client.connect()
      connected = true
      const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
      if (existing.rowCount === 0) {
        await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`)
      }
      return
    } catch (err) {
      if (!connected && attempt < CONNECT_RETRIES) {
        await sleep(CONNECT_SLEEP_MS)
        continue
      }
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`caracal-auth: could not ensure database "${name}" exists: ${message}`)
      return
    } finally {
      await client.end().catch(() => {})
    }
  }
}

// Provision the auth database for the configured backend. The dedicated migration entrypoint
// calls this unconditionally; local development invokes it on boot so a single node self-hosts
// without manual setup. Production serving replicas leave it gated off and rely on the job.
export const ensureAuthDatabase = (): Promise<void> => ensureDatabaseExists(cfg.databaseUrl, cfg.ssl)

if (cfg.autoProvisionDatabase) {
  await ensureAuthDatabase()
}

// Bounded pool so the session store cannot exhaust shared Postgres, recycles idle connections,
// and fails fast instead of hanging when the database is unreachable. Knobs mirror the API and
// coordinator pools through the shared DB_* env family.
const poolMax = Math.max(1, Number(process.env.DB_POOL_MAX ?? 20))
const connectionTimeoutMs = Math.max(0, Number(process.env.DB_CONNECTION_TIMEOUT_MS ?? 5_000))
const idleTimeoutMs = Math.max(0, Number(process.env.DB_IDLE_TIMEOUT_MS ?? 30_000))
const statementTimeoutMs = Math.max(1, Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 15_000))
const idleInTxTimeoutMs = Math.max(1, Number(process.env.DB_IDLE_IN_TX_TIMEOUT_MS ?? 30_000))

const pool = new pg.Pool({
  connectionString: cfg.databaseUrl,
  ssl: sslOption(cfg.ssl),
  max: poolMax,
  connectionTimeoutMillis: connectionTimeoutMs,
  idleTimeoutMillis: idleTimeoutMs,
  application_name: 'caracal-auth',
  options: `-c statement_timeout=${statementTimeoutMs} -c idle_in_transaction_session_timeout=${idleInTxTimeoutMs}`,
})

// An idle pooled connection can be dropped by Postgres or the network at any time; pg surfaces
// that as an 'error' event on the pool, which Node treats as fatal and crashes the process unless
// it is handled. The pool evicts the broken connection and opens a fresh one on the next query, so
// the error is logged and swallowed rather than taking the service down.
pool.on('error', (err) => {
  const message = err instanceof Error ? err.message : String(err)
  console.warn(`caracal-auth: idle database connection error: ${message}`)
})

// Better Auth detects the Postgres dialect from the pg.Pool's structural shape.
export const authDatabase = pool as unknown as BetterAuthOptions['database']
export const closeAuthDatabase = (): Promise<void> => pool.end()

// Readiness probe dependency: confirms the session store is reachable before the BFF accepts
// traffic. A failure here means session validation would fail, so the pod must report not-ready.
export async function pingAuthDatabase(): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('SELECT 1')
  } finally {
    client.release()
  }
}
