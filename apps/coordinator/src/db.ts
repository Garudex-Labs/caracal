// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// PostgreSQL pool factory for the coordinator.

import pg from 'pg'
import { cfg, type Cfg } from './config.js'

export function buildDB(config: Cfg = cfg): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    idleTimeoutMillis: config.dbIdleTimeoutMs,
    connectionTimeoutMillis: config.dbConnectionTimeoutMs,
    statement_timeout: config.dbStatementTimeoutMs,
    // The coordinator reads sessions and zones across zones by design, so every
    // session carries the RLS sentinel; row-level security stays a backstop for
    // the per-request zone scoping in the control plane.
    options: `-c statement_timeout=${config.dbStatementTimeoutMs} -c caracal.zone_id=*`,
  })
  // An idle pooled connection can be dropped by Postgres or the network at any time; pg surfaces
  // that as an 'error' event on the pool, which Node treats as fatal and crashes the process
  // unless it is handled. The pool evicts the broken connection and opens a fresh one on the next
  // query, so the error is logged and swallowed rather than taking the service down.
  pool.on('error', (err) => {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`caracal-coordinator: idle database connection error: ${message}`)
  })
  return pool
}

// Proves the connected database carries the schema this build's SQL depends on. A
// coordinator rolled against a database missing these columns or privileges would
// otherwise boot cleanly and fail on first use with opaque runtime errors, so the
// probe turns schema drift into a named startup failure.
export async function assertSchemaCompatible(db: { query: (text: string) => Promise<unknown> }): Promise<void> {
  try {
    await db.query(
      'SELECT id, lifecycle, lease_generation, last_heartbeat_at, heartbeat_deadline_at, termination_reason FROM sessions LIMIT 0',
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`coordinator schema incompatible with this build: ${message}; apply the current baseline migration before starting`)
  }
  const grants = (await db.query("SELECT has_table_privilege(current_user, 'sessions', 'DELETE') AS can_delete")) as {
    rows?: Array<{ can_delete?: boolean }>
  }
  if (grants.rows?.[0]?.can_delete !== true) {
    throw new Error(
      'coordinator role lacks the sessions DELETE grant its retention cleaner requires; apply the current baseline migration grants before starting',
    )
  }
}
