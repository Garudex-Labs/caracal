// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// PostgreSQL pool factory for the coordinator.

import pg from 'pg'
import { cfg } from './config.js'

export function buildPool(): pg.Pool {
  const pool = new pg.Pool({
    connectionString: cfg.databaseUrl,
    max: cfg.dbPoolMax,
    idleTimeoutMillis: cfg.dbIdleTimeoutMs,
    connectionTimeoutMillis: cfg.dbConnectionTimeoutMs,
    statement_timeout: cfg.dbStatementTimeoutMs,
  })
  return pool
}

export const db = buildPool()
