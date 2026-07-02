// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// PostgreSQL connection pool for the API service.

import pg from 'pg'
import { currentZoneScope, GLOBAL_ZONE_SCOPE } from './zone-context.js'

type QueryParam = string | number | boolean | null | string[]

export interface Queryable {
  query: <T = unknown>(text: string, params?: QueryParam[]) => Promise<{ rows: T[] }>
}

export interface QueryResultLike<T> {
  rows: T[]
  rowCount: number | null
}

// Request-scoped database handle. For zone-scoped actors every query runs with
// the caracal.zone_id RLS GUC bound to the actor's zone so the database enforces
// tenant isolation as a backstop to the application-layer zone checks. Global
// actors and background workers operate with the '*' sentinel (RLS open).
export interface DB {
  query: <T = any>(text: string, params?: unknown[]) => Promise<QueryResultLike<T>>
  connect: () => Promise<TxClient>
}

const ZONE_GUC_SQL = "SELECT set_config('caracal.zone_id', $1, true)"

export interface DBOptions {
  connectionString: string
  max?: number
  statementTimeoutMs?: number
  idleInTxTimeoutMs?: number
  connectionTimeoutMs?: number
  idleTimeoutMs?: number
  applicationName?: string
  onZoneGUCError?: (err: unknown) => void
}

export function newDB(options: DBOptions): pg.Pool {
  const stmt = options.statementTimeoutMs ?? 15_000
  const idleTx = options.idleInTxTimeoutMs ?? 30_000
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 20,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
    application_name: options.applicationName ?? 'caracal-api',
    options: `-c statement_timeout=${stmt} -c idle_in_transaction_session_timeout=${idleTx}`,
  })
  pool.on('connect', (client) => {
    client.query("SELECT set_config('caracal.zone_id', '*', false)").catch((err: unknown) => {
      if (options.onZoneGUCError) {
        options.onZoneGUCError(err)
      }
    })
  })
  // An idle pooled connection can be dropped by Postgres or the network at any time; pg surfaces
  // that as an 'error' event on the pool, which Node treats as fatal and crashes the process
  // unless it is handled. The pool evicts the broken connection and opens a fresh one on the next
  // query, so the error is logged and swallowed rather than taking the service down.
  pool.on('error', (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`caracal-api: idle database connection error: ${message}`)
  })
  return pool
}

// Wraps the raw pool so every db.query honors the request-scoped zone GUC. For a
// specific zone the query runs inside a transaction with a transaction-local
// caracal.zone_id; for the '*' sentinel it uses the pooled connection directly
// (whose session GUC is already '*').
export function scopedDB(pool: pg.Pool): DB {
  return {
    async query<T = any>(text: string, params?: unknown[]): Promise<QueryResultLike<T>> {
      const scope = currentZoneScope()
      if (scope === GLOBAL_ZONE_SCOPE) {
        const result = await pool.query(text, params as unknown[])
        return { rows: result.rows as T[], rowCount: result.rowCount }
      }
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(ZONE_GUC_SQL, [scope])
        const result = await client.query(text, params as unknown[])
        await client.query('COMMIT')
        return { rows: result.rows as T[], rowCount: result.rowCount }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },
    connect() {
      return pool.connect()
    },
  }
}

export type TxClient = pg.PoolClient

// Thrown by a withTransaction callback to roll back and return a business
// response (404/403/409/...) without treating it as a retriable failure.
export class TxAbort<T = unknown> {
  constructor(public readonly value: T) {}
}

// 40001 serialization_failure, 40P01 deadlock_detected. Postgres asks the
// client to retry these from the top, matching the Go services' behavior.
const RETRYABLE_TX_CODES = new Set(['40001', '40P01'])

function isRetryableTxError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false
  return RETRYABLE_TX_CODES.has(String((err as { code?: unknown }).code ?? ''))
}

export interface TxOptions {
  maxAttempts?: number
  baseDelayMs?: number
}

export async function withTransaction<T>(
  db: DB,
  fn: (client: TxClient) => Promise<T>,
  options: TxOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3)
  const baseDelayMs = Math.max(1, options.baseDelayMs ?? 10)
  const client = await db.connect()
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await client.query('BEGIN')
        const scope = currentZoneScope()
        if (scope !== GLOBAL_ZONE_SCOPE) {
          await client.query(ZONE_GUC_SQL, [scope])
        }
        const value = await fn(client)
        await client.query('COMMIT')
        return value
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        if (err instanceof TxAbort) return err.value as T
        if (attempt < maxAttempts && isRetryableTxError(err)) {
          const backoff = baseDelayMs * 2 ** (attempt - 1)
          const delay = backoff + Math.floor(Math.random() * baseDelayMs)
          await new Promise((resolve) => setTimeout(resolve, delay))
          continue
        }
        throw err
      }
    }
  } finally {
    client.release()
  }
}
