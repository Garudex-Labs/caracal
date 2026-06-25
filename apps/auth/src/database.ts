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

// Better Auth runs the table migrations, but the database itself must exist first. Create it
// idempotently through a maintenance connection so a fresh local stack — or a post-purge run —
// comes up without manual provisioning. This is gated to local development: production runs N
// replicas and provisions the schema once through the dedicated migration job, so no replica
// performs DDL on boot.
async function ensureDatabaseExists(url: string, ssl: PostgresSsl): Promise<void> {
  const name = databaseName(url)
  if (!name) return
  const maintenance = new URL(url)
  maintenance.pathname = '/postgres'
  const client = new pg.Client({ connectionString: maintenance.toString(), ssl: sslOption(ssl) })
  try {
    await client.connect()
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
    if (existing.rowCount === 0) {
      await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`caracal-auth: could not ensure database "${name}" exists: ${message}`)
  } finally {
    await client.end().catch(() => {})
  }
}

if (cfg.autoProvisionDatabase) {
  await ensureDatabaseExists(cfg.databaseUrl, cfg.ssl)
}

const pool = new pg.Pool({ connectionString: cfg.databaseUrl, ssl: sslOption(cfg.ssl) })

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
