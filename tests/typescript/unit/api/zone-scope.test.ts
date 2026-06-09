// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the request-scoped zone GUC backstop in scopedDB and withTransaction.

import { describe, it, expect, vi } from 'vitest'
import { scopedDB, withTransaction } from '../../../../apps/api/src/db.js'
import { bindRequestZoneScope, GLOBAL_ZONE_SCOPE } from '../../../../apps/api/src/zone-context.js'

function makePool() {
  const clientQuery = vi.fn().mockResolvedValue({ rows: [{ ok: 1 }], rowCount: 1 })
  const release = vi.fn()
  const client = { query: clientQuery, release }
  const poolQuery = vi.fn().mockResolvedValue({ rows: [{ ok: 1 }], rowCount: 1 })
  const pool = { query: poolQuery, connect: vi.fn().mockResolvedValue(client) }
  return { pool, poolQuery, clientQuery, client, release }
}

describe('scopedDB zone backstop', () => {
  it('uses the pooled connection directly for the global sentinel', async () => {
    const { pool, poolQuery } = makePool()
    bindRequestZoneScope(GLOBAL_ZONE_SCOPE)

    const db = scopedDB(pool as never)
    const res = await db.query('SELECT 1', [])

    expect(res.rows).toEqual([{ ok: 1 }])
    expect(poolQuery).toHaveBeenCalledOnce()
    expect(pool.connect).not.toHaveBeenCalled()
  })

  it('binds caracal.zone_id in a transaction for a zone-scoped actor', async () => {
    const { pool, clientQuery, poolQuery, release } = makePool()
    bindRequestZoneScope('zone-a')

    const db = scopedDB(pool as never)
    const res = await db.query('SELECT 1', [])

    expect(res.rows).toEqual([{ ok: 1 }])
    expect(poolQuery).not.toHaveBeenCalled()
    const calls = clientQuery.mock.calls
    expect(calls[0][0]).toBe('BEGIN')
    expect(calls[1][0]).toContain("set_config('caracal.zone_id'")
    expect(calls[1][1]).toEqual(['zone-a'])
    expect(calls[2][0]).toBe('SELECT 1')
    expect(calls[3][0]).toBe('COMMIT')
    expect(release).toHaveBeenCalledOnce()

    // restore for subsequent tests in this worker
    bindRequestZoneScope(GLOBAL_ZONE_SCOPE)
  })

  it('rolls back and releases when the scoped query fails', async () => {
    const { pool, clientQuery, release } = makePool()
    clientQuery.mockImplementation((sql: string) => {
      if (sql === 'SELECT boom') return Promise.reject(new Error('boom'))
      return Promise.resolve({ rows: [], rowCount: 0 })
    })
    bindRequestZoneScope('zone-b')

    const db = scopedDB(pool as never)
    await expect(db.query('SELECT boom', [])).rejects.toThrow('boom')

    const calls = clientQuery.mock.calls.map((c) => c[0])
    expect(calls).toContain('ROLLBACK')
    expect(release).toHaveBeenCalledOnce()

    bindRequestZoneScope(GLOBAL_ZONE_SCOPE)
  })
})

describe('withTransaction zone GUC', () => {
  it('sets the zone GUC after BEGIN for a zone-scoped actor', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const release = vi.fn()
    const client = { query, release }
    const db = { connect: vi.fn().mockResolvedValue(client) } as never
    bindRequestZoneScope('zone-c')

    await withTransaction(db, async () => 'ok')

    const calls = query.mock.calls
    expect(calls[0][0]).toBe('BEGIN')
    expect(calls[1][0]).toContain("set_config('caracal.zone_id'")
    expect(calls[1][1]).toEqual(['zone-c'])
    expect(calls[2][0]).toBe('COMMIT')

    bindRequestZoneScope(GLOBAL_ZONE_SCOPE)
  })

  it('omits the zone GUC for the global sentinel', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const release = vi.fn()
    const client = { query, release }
    const db = { connect: vi.fn().mockResolvedValue(client) } as never
    bindRequestZoneScope(GLOBAL_ZONE_SCOPE)

    await withTransaction(db, async () => 'ok')

    const calls = query.mock.calls.map((c) => c[0])
    expect(calls).toEqual(['BEGIN', 'COMMIT'])
  })
})
