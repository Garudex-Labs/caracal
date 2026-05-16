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
  })
  return pool
}
