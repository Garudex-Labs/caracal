// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// PostgreSQL connection pool for the API service.

import pg from 'pg'

export type DB = pg.Pool

export interface DBOptions {
  connectionString: string
  max?: number
  statementTimeoutMs?: number
  idleInTxTimeoutMs?: number
  connectionTimeoutMs?: number
  idleTimeoutMs?: number
  applicationName?: string
}

export function newDB(options: DBOptions): DB {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 20,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
    application_name: options.applicationName ?? 'caracal-api',
  })
  const stmt = options.statementTimeoutMs ?? 15_000
  const idleTx = options.idleInTxTimeoutMs ?? 30_000
  pool.on('connect', (client) => {
    void (async () => {
      await client.query(`SET statement_timeout = ${stmt}`)
      await client.query(`SET idle_in_transaction_session_timeout = ${idleTx}`)
    })()
  })
  return pool
}
