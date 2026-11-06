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
  // `any` is the row-shape default so callers keep pg's inference at each call site.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    // Server timeouts do not bound a lost TCP response. Allow the server a small
    // grace period to report SQLSTATE 57014 before the client abandons the socket.
    query_timeout: stmt > 0 ? stmt + 1_000 : undefined,
    keepAlive: true,
    // Unlike the connect event, onConnect is awaited before a client is lent out.
    // A failed initialization must discard the session, not serve queries with an unset GUC.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- pg-pool awaits this hook; @types/pg still declares void.
    onConnect: async (client) => {
      // pg emits socket failures on checked-out clients too, when the pool's idle
      // listener is detached. Queries reject normally; don't let EventEmitter crash
      // the process during a transaction or between its queries.
      client.on('error', () => {})
      try {
        await client.query("SELECT set_config('caracal.zone_id', '*', false)")
      } catch (err) {
        options.onZoneGUCError?.(err)
        throw err
      }
    },
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async query<T = any>(text: string, params?: unknown[]): Promise<QueryResultLike<T>> {
      const scope = currentZoneScope()
      if (scope === GLOBAL_ZONE_SCOPE) {
        const result = await pool.query(text, params as unknown[])
        return { rows: result.rows as T[], rowCount: result.rowCount }
      }
      return withTransaction(
        { connect: () => pool.connect() },
        async (client) => {
          const result = await client.query(text, params as unknown[])
          return { rows: result.rows as T[], rowCount: result.rowCount }
        },
        { maxAttempts: 1 },
      )
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
  db: Pick<DB, 'connect'>,
  fn: (client: TxClient) => Promise<T>,
  options: TxOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3)
  const baseDelayMs = Math.max(1, options.baseDelayMs ?? 10)
  for (let attempt = 1; ; attempt++) {
    const client = await db.connect()
    let discard = false
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
      // pg's client-side read timeout does not cancel an already-sent statement.
      // ROLLBACK would queue behind that statement on the same unresponsive
      // socket. Disconnect instead; its transaction outcome must not be retried.
      discard = typeof err === 'object' && err !== null && 'message' in err && err.message === 'Query read timeout'
      if (!discard) {
        try {
          await client.query('ROLLBACK')
        } catch {
          // A failed rollback can leave transaction-local RLS state and locks alive.
          discard = true
        }
      }
      if (err instanceof TxAbort) return err.value as T
      if (discard || attempt >= maxAttempts || !isRetryableTxError(err)) throw err
    } finally {
      if (discard) client.release(true)
      else client.release()
    }
    // Acquire a fresh checkout for each attempt and release BEFORE sleeping;
    // otherwise contention retries themselves can exhaust the pool.
    const backoff = baseDelayMs * 2 ** (attempt - 1)
    await new Promise((resolve) => setTimeout(resolve, backoff + Math.floor(Math.random() * baseDelayMs)))
  }
}
