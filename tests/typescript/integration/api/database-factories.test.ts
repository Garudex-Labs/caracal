// Copyright (C) 2026 Garudex Labs. All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Live disconnect coverage for the other services' checked-out pg connections.

import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../shared/test-utils/typescript/coordinatorEnv.js'
import { buildDB } from '../../../../apps/coordinator/src/db.js'
import { cfg } from '../../../../apps/coordinator/src/config.js'

const url = process.env.CARACAL_TEST_DATABASE_URL
const suite = url ? describe : describe.skip
afterEach(() => {
  vi.unstubAllEnvs()
})

suite('service pool disconnect recovery', () => {
  it.each(['coordinator', 'auth'] as const)('survives a disconnect on a checked-out %s client', async (service) => {
    let pool: pg.Pool
    if (service === 'coordinator') {
      pool = buildDB({ ...cfg, databaseUrl: url!, dbPoolMax: 1 })
    } else {
      vi.stubEnv('NODE_ENV', 'test')
      vi.stubEnv('CARACAL_AUTH_DATABASE_URL', url!)
      vi.stubEnv('CARACAL_AUTH_SECRET', randomBytes(32).toString('hex'))
      vi.stubEnv('CARACAL_AUTH_AUTO_MIGRATE', 'false')
      vi.stubEnv('CARACAL_AUTH_DATABASE_SSL', 'disable')
      const auth = await import('../../../../apps/auth/src/database.ts')
      pool = auth.authDatabase as unknown as pg.Pool
    }
    const control = new pg.Pool({ connectionString: url })
    try {
      const client = await pool.connect()
      try {
        const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        await control.query('SELECT pg_terminate_backend($1)', [pid])
        await new Promise((resolve) => setTimeout(resolve, 30))
        await expect(client.query('SELECT 1')).rejects.toThrow()
      } finally {
        client.release()
      }
      expect((await pool.query('SELECT 1 AS value')).rows[0].value).toBe(1)
    } finally {
      await control.end()
      await pool.end()
    }
  })
})
