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
    options: `-c statement_timeout=${config.dbStatementTimeoutMs}`,
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
