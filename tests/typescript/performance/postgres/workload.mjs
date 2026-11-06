// Copyright (C) 2026 Garudex Labs. All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Run after build:typescript against a DISPOSABLE migrated database:
// CARACAL_TEST_DATABASE_URL=... node tests/typescript/performance/postgres/workload.mjs
// Optional, destructive restart injection: CARACAL_TEST_PGDATA=/path/to/disposable/pgdata

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { newDB, scopedDB, withTransaction } from '../../../../apps/api/dist/db.js'
import { insertAdminAuditRecord } from '../../../../packages/adminAudit/ts/dist/index.js'
import { postgresProxy } from '../../../shared/test-utils/typescript/postgres-proxy.mjs'

const url = process.env.CARACAL_TEST_DATABASE_URL
if (!url) throw new Error('CARACAL_TEST_DATABASE_URL must name a disposable migrated PostgreSQL database')
const operations = Number(process.env.CARACAL_STRESS_OPERATIONS ?? 1000)
const concurrency = Number(process.env.CARACAL_STRESS_CONCURRENCY ?? 16)
assert(Number.isSafeInteger(operations) && operations > 0 && Number.isSafeInteger(concurrency) && concurrency > 0)
const schema = `stress_${randomUUID().replaceAll('-', '')}`
const zone = `stress-${randomUUID()}`
const control = newDB({ connectionString: url, max: 2 })
const proxy = await postgresProxy(url)
const pool = newDB({ connectionString: proxy.url, max: 8, connectionTimeoutMs: 200, statementTimeoutMs: 1000 })
const db = scopedDB(pool)

function summary(label, durations, elapsed, failures) {
  durations.sort((a, b) => a - b)
  const percentile = (p) => durations[Math.floor(((durations.length - 1) * p) / 100)]
  console.log(
    JSON.stringify({
      label,
      operations: durations.length,
      failures,
      throughput: (durations.length * 1000) / elapsed,
      p50_ms: percentile(50),
      p95_ms: percentile(95),
      p99_ms: percentile(99),
    }),
  )
}

async function parallel(count, task) {
  let next = 0
  const results = await Promise.allSettled(
    Array.from({ length: concurrency }, async () => {
      while (next < count) await task(next++)
    }),
  )
  const failure = results.find((result) => result.status === 'rejected')
  if (failure) throw failure.reason
}

async function atomicWorkload(label, inject) {
  const latencies = []
  let failures = 0
  let committed = 0
  let injected = Promise.resolve()
  let injectionError
  const start = performance.now()
  await parallel(operations, async (i) => {
    const id = `${label}-${i}`
    const at = performance.now()
    for (let retry = 0; ; retry++) {
      try {
        await withTransaction(
          db,
          async (client) => {
            const inserted = await client.query(`INSERT INTO ${schema}.journal (id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id`, [id])
            // Exactly-once application of the logical operation, including ambiguous COMMIT retries.
            if (inserted.rowCount === 0) return
            await client.query("SET LOCAL deadlock_timeout='10ms'")
            const first = i % 2 ? 1 : 2
            await client.query(`UPDATE ${schema}.counters SET value=value+1 WHERE id=$1`, [first])
            await client.query(`UPDATE ${schema}.counters SET value=value+1 WHERE id=$1`, [3 - first])
          },
          { maxAttempts: 5, baseDelayMs: 1 },
        )
        break
      } catch (err) {
        failures++
        // This harness retries logical operations only because the journal makes them idempotent.
        // Production withTransaction intentionally does NOT replay uncertain network commits.
        if (retry >= 100) throw err
        await sleep(10)
      }
    }
    latencies.push(performance.now() - at)
    if (++committed === 40 && inject)
      injected = inject().catch((err) => {
        injectionError = err
      })
  })
  await injected
  if (injectionError) throw injectionError
  const journal = Number((await control.query(`SELECT count(*) AS n FROM ${schema}.journal`)).rows[0].n)
  const counters = (await control.query(`SELECT value FROM ${schema}.counters ORDER BY id`)).rows.map((r) => Number(r.value))
  assert.deepEqual(counters, [journal, journal], 'partial writes or duplicate increments after failure recovery')
  assert.equal(
    (await control.query(`SELECT count(*) AS n FROM ${schema}.journal WHERE id LIKE $1`, [`${label}-%`])).rows[0].n,
    String(operations),
  )
  assert.equal(pool.waitingCount, 0, 'pool acquisition queue leaked')
  if (inject) assert(failures > 0, 'failure injection did not interrupt the workload')
  summary(label, latencies, performance.now() - start, failures)
}

async function adminBenchmark() {
  const durations = []
  const start = performance.now()
  await parallel(operations, async () => {
    const at = performance.now()
    await withTransaction(db, (client) =>
      insertAdminAuditRecord(client, {
        requestId: randomUUID(),
        actorId: null,
        actorName: null,
        actorScope: null,
        action: 'benchmark',
        method: 'POST',
        path: '/benchmark',
        zoneId: zone,
        entityType: null,
        entityId: null,
        statusCode: 200,
      }),
    )
    durations.push(performance.now() - at)
  })
  const invariant = await control.query(
    `SELECT count(*)::int AS n, count(DISTINCT chain_seq)::int AS sequences, min(chain_seq)::int AS first, max(chain_seq)::int AS last FROM admin_audit_events WHERE zone_id=$1`,
    [zone],
  )
  assert.deepEqual(invariant.rows[0], { n: operations, sequences: operations, first: 1, last: operations })
  const broken = await control.query(
    `SELECT count(*) AS n FROM (
    SELECT prev_content_sha256, lag(content_sha256) OVER (ORDER BY chain_seq) AS expected
    FROM admin_audit_events WHERE zone_id=$1
  ) links WHERE prev_content_sha256 IS DISTINCT FROM expected`,
    [zone],
  )
  assert.equal(broken.rows[0].n, '0', 'admin audit chain was broken by concurrent inserts')
  summary('admin-audit', durations, performance.now() - start, 0)
}

try {
  if (process.env.CARACAL_TEST_PGDATA) {
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname), 'restart injection requires a local database')
    const actual = (await control.query('SHOW data_directory')).rows[0].data_directory
    assert.equal(resolve(process.env.CARACAL_TEST_PGDATA), resolve(actual), 'PGDATA does not match the tested PostgreSQL server')
  }
  await control.query(`CREATE SCHEMA ${schema}`)
  await control.query(
    `CREATE TABLE ${schema}.journal (id text PRIMARY KEY); CREATE TABLE ${schema}.counters (id int PRIMARY KEY, value bigint NOT NULL); INSERT INTO ${schema}.counters VALUES (1,0),(2,0)`,
  )
  await atomicWorkload('contention')
  await atomicWorkload('network-reset', async () => {
    proxy.disconnect()
    await sleep(250)
    proxy.restore()
  })
  if (process.env.CARACAL_TEST_PGDATA) {
    await atomicWorkload('database-crash-restart', async () => {
      // Redirect the daemon's log so it doesn't hold execFile's stdout pipe open.
      const result = await promisify(execFile)('pg_ctl', [
        '-D',
        process.env.CARACAL_TEST_PGDATA,
        '-l',
        join(process.env.CARACAL_TEST_PGDATA, 'caracal-stress-postgres.log'),
        '-m',
        'immediate',
        '-w',
        '-t',
        '30',
        'restart',
      ])
      console.log(result.stdout.trim())
    })
  }
  await adminBenchmark()
} finally {
  proxy.disconnect()
  await pool.end()
  await proxy.close()
  await control.query('DELETE FROM admin_audit_events WHERE zone_id=$1', [zone]).catch(() => {})
  await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {})
  await control.end()
}
