// Copyright (C) 2026 Garudex Labs. All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Exercises the real migration executable on an isolated disposable database.

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const url = process.env.CARACAL_TEST_DATABASE_URL
const suite = url && process.platform !== 'win32' ? describe : describe.skip
const run = promisify(execFile)
const script = resolve(import.meta.dirname, '../../../../infra/postgres/scripts/migrate.sh')
let admin: pg.Pool
let db: pg.Pool
let name: string
let directory: string
let env: NodeJS.ProcessEnv

beforeEach(async () => {
  if (!url || process.platform === 'win32') return
  name = `migration_${randomUUID().replaceAll('-', '')}`
  admin = new pg.Pool({ connectionString: url, application_name: `${name}_control` })
  await admin.query(`CREATE DATABASE ${name}`)
  const endpoint = new URL(url)
  endpoint.pathname = `/${name}`
  db = new pg.Pool({ connectionString: endpoint.href, application_name: `${name}_checks` })
  // DROP DATABASE FORCE can race the final idle socket's closure after pool.end.
  // Only that intentional administrative termination is expected during cleanup.
  db.on('error', (err) => {
    if (!('code' in err) || err.code !== '57P01') throw err
  })
  directory = await mkdtemp(join(tmpdir(), 'caracal migration space '))
  env = {
    ...process.env,
    PGHOST: endpoint.hostname,
    PGPORT: endpoint.port || '5432',
    PGUSER: decodeURIComponent(endpoint.username),
    PGDATABASE: name,
    PGPASSWORD: decodeURIComponent(endpoint.password) || 'test',
    MIGRATIONS_DIR: directory,
    PGAPPNAME: name,
  }
  delete env.PGPASSWORD_FILE
  delete env.PGPASSFILE
})

afterEach(async () => {
  if (!admin) return
  await db.end()
  await admin.query(`DROP DATABASE ${name} WITH (FORCE)`)
  await admin.end()
  await rm(directory, { recursive: true, force: true })
})

function migrate() {
  return run('sh', [script], { env, timeout: 20_000 })
}

suite('PostgreSQL migration crash and first-start recovery', () => {
  it('serializes twelve first-start migrators before schema_migrations exists', async () => {
    await writeFile(
      join(directory, '0001_probe.up.sql'),
      'CREATE TABLE migration_probe (id int PRIMARY KEY); INSERT INTO migration_probe VALUES (1);',
    )
    const results = await Promise.allSettled(Array.from({ length: 12 }, migrate))
    for (const result of results) expect(result.status, result.status === 'rejected' ? String(result.reason) : '').toBe('fulfilled')
    expect((await db.query('SELECT * FROM migration_probe')).rows).toEqual([{ id: 1 }])
    expect((await db.query('SELECT version FROM schema_migrations')).rows).toEqual([{ version: '0001_probe' }])
  }, 25_000)

  it('rolls back failed migrations and resumes without repeating already-committed files', async () => {
    await writeFile(
      join(directory, '0001_probe.up.sql'),
      'CREATE TABLE migration_probe (id int PRIMARY KEY); INSERT INTO migration_probe VALUES (1);',
    )
    await writeFile(join(directory, '0002_probe.up.sql'), 'CREATE TABLE partial_write (id int); SELECT 1/0;')
    await expect(migrate()).rejects.toThrow()
    expect((await db.query("SELECT to_regclass('partial_write') AS relation")).rows[0].relation).toBeNull()
    expect((await db.query('SELECT version FROM schema_migrations')).rows).toEqual([{ version: '0001_probe' }])
    await writeFile(join(directory, '0002_probe.up.sql'), 'CREATE TABLE partial_write (id int); INSERT INTO partial_write VALUES (2);')
    await migrate()
    await migrate()
    expect((await db.query('SELECT * FROM migration_probe')).rows).toEqual([{ id: 1 }])
    expect((await db.query('SELECT * FROM partial_write')).rows).toEqual([{ id: 2 }])
  })

  it('does not leave partial DDL or a version marker after a migration backend is interrupted', async () => {
    await writeFile(join(directory, '0001_probe.up.sql'), 'CREATE TABLE partial_write (id int); SELECT pg_sleep(30);')
    // Attach rejection handling immediately, before killing its PostgreSQL backend.
    const outcome = migrate().then(
      () => null,
      (err: unknown) => err,
    )
    let pid: number | undefined
    for (let i = 0; i < 500; i++) {
      const { rows } = await admin.query<{ pid: number }>(
        "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND query LIKE '%SELECT pg_sleep(30)%'",
        [name],
      )
      if (rows[0]) {
        pid = rows[0].pid
        break
      }
      await sleep(20)
    }
    try {
      expect(pid, 'migration did not reach the interrupted statement').toBeDefined()
      await admin.query('SELECT pg_terminate_backend($1)', [pid])
      expect(await outcome).not.toBeNull()
      expect((await db.query("SELECT to_regclass('partial_write') AS relation")).rows[0].relation).toBeNull()
      expect((await db.query('SELECT * FROM schema_migrations')).rows).toEqual([])
      await writeFile(join(directory, '0001_probe.up.sql'), 'CREATE TABLE partial_write (id int);')
      await migrate()
      expect((await db.query('SELECT version FROM schema_migrations')).rows).toEqual([{ version: '0001_probe' }])
    } finally {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1', [name]).catch(() => {})
      await outcome
    }
  }, 25_000)
})
