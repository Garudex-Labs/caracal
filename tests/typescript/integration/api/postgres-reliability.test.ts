// Copyright (C) 2026 Garudex Labs. All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Real PostgreSQL regressions for transaction cleanup, contention, and outbox lease fencing.

import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newDB, scopedDB, withTransaction, type DB, type TxClient } from '../../../../apps/api/src/db.js'
import { bindRequestZoneScope, GLOBAL_ZONE_SCOPE } from '../../../../apps/api/src/zone-context.js'
import { enqueueOutbox, OutboxDispatcher } from '../../../../apps/api/src/outbox.js'
import type { RedisClient } from '../../../../apps/api/src/redis.js'
import { postgresProxy } from '../../../shared/test-utils/typescript/postgres-proxy.mjs'

const databaseUrl = process.env.CARACAL_TEST_DATABASE_URL
const suite = databaseUrl ? describe : describe.skip
let pool: pg.Pool
let schema: string

beforeEach(async () => {
  if (!databaseUrl) return
  vi.stubEnv('CARACAL_MODE', 'dev')
  bindRequestZoneScope(GLOBAL_ZONE_SCOPE)
  schema = `reliability_${randomUUID().replaceAll('-', '')}`
  pool = newDB({ connectionString: databaseUrl, max: 1 })
  await pool.query(`CREATE SCHEMA ${schema}`)
  await pool.query(`CREATE TABLE ${schema}.writes (id int PRIMARY KEY, value int NOT NULL)`)
})

afterEach(async () => {
  bindRequestZoneScope(GLOBAL_ZONE_SCOPE)
  vi.unstubAllEnvs()
  if (!pool) return
  // Also cleans the broken baseline's leaked transaction when a regression fails.
  try {
    await pool.query('ROLLBACK').catch(() => {})
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  } finally {
    await pool.end()
  }
})

function failRollback(client: TxClient): TxClient {
  return {
    query: (sql: string, params?: unknown[]) =>
      sql === 'ROLLBACK' ? Promise.reject(new Error('injected rollback failure')) : client.query(sql, params),
    release: client.release.bind(client),
  } as TxClient
}

suite('PostgreSQL transaction reliability', () => {
  it('supports both head and ascending search null ordering without sacrificing either index', async () => {
    const { rows } = await pool.query(`SELECT c.relname AS name,
      (i.indoption[1] & 1) <> 0 AS descending,
      (i.indoption[1] & 2) <> 0 AS nulls_first
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      WHERE c.relnamespace='public'::regnamespace
        AND c.relname IN ('audit_events_zone_chain', 'audit_events_zone_chain_head')
      ORDER BY c.relname`)
    expect(rows).toEqual([
      { name: 'audit_events_zone_chain', descending: true, nulls_first: true },
      { name: 'audit_events_zone_chain_head', descending: true, nulls_first: false },
    ])
  })
  it('evicts a client after failed rollback rather than exposing partial writes and zone state', async () => {
    const db = { connect: async () => failRollback(await pool.connect()) } as DB
    bindRequestZoneScope('zone-a')
    await expect(
      withTransaction(db, async (client) => {
        await client.query(`INSERT INTO ${schema}.writes VALUES (1, 10)`)
        throw new Error('business failure')
      }),
    ).rejects.toThrow('business failure')
    bindRequestZoneScope(GLOBAL_ZONE_SCOPE)
    expect((await pool.query(`SELECT * FROM ${schema}.writes`)).rows).toEqual([])
    expect((await pool.query("SELECT current_setting('caracal.zone_id') AS zone")).rows[0].zone).toBe('*')
  })

  it('evicts a scoped query client when cleanup cannot reset its transaction', async () => {
    const db = scopedDB({
      connect: async () => failRollback(await pool.connect()),
    } as pg.Pool)
    bindRequestZoneScope('zone-b')
    await expect(db.query('SELECT 1/0')).rejects.toMatchObject({ code: '22012' })
    bindRequestZoneScope(GLOBAL_ZONE_SCOPE)
    expect((await pool.query('SELECT 1 AS value')).rows[0].value).toBe(1)
  })

  it('returns its connection during retry backoff so unrelated work is not starved', async () => {
    const released = new Promise<void>((resolve) => {
      pool.once('release', () => resolve())
    })
    let attempts = 0
    const work = withTransaction(
      scopedDB(pool),
      async () => {
        if (++attempts === 1) {
          throw Object.assign(new Error('serialization failure'), { code: '40001' })
        }
        return 'committed'
      },
      { baseDelayMs: 500 },
    )
    try {
      await released
      // Verify ordering, not a fragile wall-clock threshold on an overloaded test host.
      expect(attempts).toBe(1)
      expect((await pool.query('SELECT 1 AS value')).rows[0].value).toBe(1)
    } finally {
      await work
    }
  })

  it('bounds acquisition waits and recovers after pool exhaustion', async () => {
    const client = await pool.connect()
    try {
      await expect(pool.query('SELECT 1')).rejects.toThrow(/timeout/i)
    } finally {
      client.release()
    }
    expect((await pool.query('SELECT 1 AS value')).rows[0].value).toBe(1)
    expect(pool.waitingCount).toBe(0)
  }, 10_000)

  it('bounds a blackholed transaction and rolls back its server-side writes', async () => {
    const proxy = await postgresProxy(databaseUrl!)
    const throughProxy = newDB({ connectionString: proxy.url, max: 1, statementTimeoutMs: 30 })
    let transaction: Promise<unknown> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    let signal!: () => void
    const injected = new Promise<void>((resolve) => {
      signal = resolve
    })
    try {
      transaction = withTransaction(scopedDB(throughProxy), async (client) => {
        proxy.blackholeResponses()
        signal()
        await client.query(`INSERT INTO ${schema}.writes VALUES (1, 10)`)
      })
      // Start the watchdog only after connection setup and BEGIN have completed.
      await Promise.race([injected, transaction])
      await expect(
        Promise.race([
          transaction,
          new Promise((_, reject) => {
            deadline = setTimeout(() => reject(new Error('read deadline not enforced')), 2_500)
          }),
        ]),
      ).rejects.toThrow('Query read timeout')
      proxy.restore()
      expect((await throughProxy.query(`SELECT * FROM ${schema}.writes`)).rows).toEqual([])
    } finally {
      clearTimeout(deadline)
      proxy.disconnect()
      await transaction?.catch(() => {})
      await throughProxy.end()
      await proxy.close()
    }
  }, 15_000)

  it('survives a backend disconnect between transaction queries and recovers without partial writes', async () => {
    const control = new pg.Pool({ connectionString: databaseUrl, max: 1 })
    try {
      await expect(
        withTransaction(scopedDB(pool), async (client) => {
          await client.query(`INSERT INTO ${schema}.writes VALUES (1, 10)`)
          const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
          await control.query('SELECT pg_terminate_backend($1)', [pid])
          await new Promise((resolve) => setTimeout(resolve, 30))
          await client.query('SELECT 1')
        }),
      ).rejects.toThrow()
      expect((await pool.query(`SELECT * FROM ${schema}.writes`)).rows).toEqual([])
    } finally {
      await control.end()
    }
  })

  it('rolls back both writes after a server-side statement timeout', async () => {
    await expect(
      withTransaction(scopedDB(pool), async (client) => {
        await client.query(`INSERT INTO ${schema}.writes VALUES (1, 10)`)
        await client.query("SET LOCAL statement_timeout='30ms'")
        await client.query('SELECT pg_sleep(1)')
      }),
    ).rejects.toMatchObject({ code: '57014' })
    expect((await pool.query(`SELECT * FROM ${schema}.writes`)).rows).toEqual([])
  })

  it('retries actual deadlocks without losing committed increments', async () => {
    const other = newDB({ connectionString: databaseUrl!, max: 1 })
    await pool.query(`INSERT INTO ${schema}.writes VALUES (1, 0), (2, 0)`)
    let arrivals = 0
    let both!: () => void
    const barrier = new Promise<void>((resolve) => {
      both = resolve
    })
    const update = (db: DB, first: number, second: number) => {
      let attempt = 0
      return withTransaction(db, async (client) => {
        await client.query("SET LOCAL deadlock_timeout='30ms'")
        await client.query(`UPDATE ${schema}.writes SET value=value+1 WHERE id=$1`, [first])
        if (++attempt === 1) {
          if (++arrivals === 2) both()
          await barrier
        }
        await client.query(`UPDATE ${schema}.writes SET value=value+1 WHERE id=$1`, [second])
      })
    }
    try {
      await Promise.all([update(scopedDB(pool), 1, 2), update(scopedDB(other), 2, 1)])
      expect((await pool.query(`SELECT value FROM ${schema}.writes ORDER BY id`)).rows).toEqual([{ value: 2 }, { value: 2 }])
    } finally {
      await other.end()
    }
  })
})

suite('PostgreSQL outbox lease recovery', () => {
  it.each(['success', 'retry', 'abandon'] as const)('fences a stale worker after lease reclamation (%s)', async (outcome) => {
    const id = await enqueueOutbox(scopedDB(pool), { streamName: 'reliability', payload: { n: 1 } })
    let entered!: () => void
    const claimed = new Promise<void>((resolve) => {
      entered = resolve
    })
    let finish!: () => void
    let fail!: (err: Error) => void
    const pending = new Promise<string>((resolve, reject) => {
      finish = () => resolve('1-0')
      fail = reject
    })
    const options = {
      db: scopedDB(pool),
      workerId: 'same-worker-id',
      batchSize: 1,
      redis: {
        xadd: () => {
          entered()
          return pending
        },
      } as unknown as RedisClient,
      maxAttempts: outcome === 'abandon' ? 1 : 100,
      log: () => {},
    }
    // Keep the test's claim isolated from other integration workloads in this database.
    const db = {
      ...scopedDB(pool),
      query: (sql: string, params?: unknown[]) =>
        scopedDB(pool).query(sql.replace('WHERE dispatched_at IS NULL', `WHERE id='${id}' AND dispatched_at IS NULL`), params),
    }
    const isolated = new OutboxDispatcher({ ...options, db })
    const tick = isolated.tick()
    try {
      await claimed
      // Emulate the claim of a replacement process with the SAME configured worker id.
      await pool.query(
        `UPDATE event_outbox SET attempts=attempts+1, locked_until=now()+interval '30 seconds', last_error='new owner' WHERE id=$1`,
        [id],
      )
      if (outcome === 'success') finish()
      else fail(new Error('old owner failed'))
      await tick
      const { rows } = await pool.query(
        'SELECT dispatched_at, attempts, last_error, locked_until, available_at FROM event_outbox WHERE id=$1',
        [id],
      )
      expect(rows[0]).toMatchObject({ dispatched_at: null, attempts: 2, last_error: 'new owner' })
      expect(rows[0].locked_until).not.toBeNull()
      expect(rows[0].available_at).toBeInstanceOf(Date)
    } finally {
      finish()
      await tick
      await pool.query('DELETE FROM event_outbox WHERE id=$1', [id])
    }
  })
})
