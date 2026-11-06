// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the withTransaction helper: commit, abort, retry, and release.

import { describe, it, expect, vi } from 'vitest'
import type { DB } from '../../../../apps/api/src/db.js'
import { withTransaction, TxAbort } from '../../../../apps/api/src/db.js'

function makeDb(query: ReturnType<typeof vi.fn>) {
  const release = vi.fn()
  const client = { query, release }
  const db = { connect: vi.fn().mockResolvedValue(client) } as unknown as DB
  return { db, client, release }
}

describe('withTransaction', () => {
  it('discards a read-timed-out session without queuing rollback or replaying the transaction', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const { db, release } = makeDb(query)
    const fn = vi.fn(async () => {
      throw new Error('Query read timeout')
    })
    await expect(withTransaction(db, fn)).rejects.toThrow('Query read timeout')
    expect(query.mock.calls.map((c) => c[0])).toEqual(['BEGIN'])
    expect(release).toHaveBeenCalledWith(true)
    expect(fn).toHaveBeenCalledOnce()
  })
  it('commits and returns the callback value on success', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const { db, release } = makeDb(query)

    const result = await withTransaction(db, async () => 'ok')

    expect(result).toBe('ok')
    const calls = query.mock.calls.map((c) => c[0])
    expect(calls).toEqual(['BEGIN', 'COMMIT'])
    expect(release).toHaveBeenCalledOnce()
  })

  it('rolls back and returns the carried value on TxAbort without retrying', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const { db, release } = makeDb(query)
    const fn = vi.fn(async () => {
      throw new TxAbort('aborted')
    })

    const result = await withTransaction(db, fn)

    expect(result).toBe('aborted')
    expect(fn).toHaveBeenCalledOnce()
    const calls = query.mock.calls.map((c) => c[0])
    expect(calls).toEqual(['BEGIN', 'ROLLBACK'])
    expect(release).toHaveBeenCalledOnce()
  })

  it('retries on a serialization failure then commits', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const { db, release } = makeDb(query)
    let attempts = 0
    const fn = vi.fn(async () => {
      attempts += 1
      if (attempts === 1) throw { code: '40001' }
      return 'second'
    })

    const result = await withTransaction(db, fn, { baseDelayMs: 1 })

    expect(result).toBe('second')
    expect(fn).toHaveBeenCalledTimes(2)
    const calls = query.mock.calls.map((c) => c[0])
    expect(calls).toEqual(['BEGIN', 'ROLLBACK', 'BEGIN', 'COMMIT'])
    expect(release).toHaveBeenCalledTimes(2)
  })

  it('retries on a deadlock then exhausts attempts and rethrows', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const { db, release } = makeDb(query)
    const fn = vi.fn(async () => {
      throw { code: '40P01' }
    })

    await expect(withTransaction(db, fn, { maxAttempts: 2, baseDelayMs: 1 })).rejects.toMatchObject({ code: '40P01' })

    expect(fn).toHaveBeenCalledTimes(2)
    expect(release).toHaveBeenCalledTimes(2)
  })

  it('does not retry a non-retryable error', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const { db, release } = makeDb(query)
    const fn = vi.fn(async () => {
      throw { code: '23505' }
    })

    await expect(withTransaction(db, fn)).rejects.toMatchObject({ code: '23505' })

    expect(fn).toHaveBeenCalledOnce()
    const calls = query.mock.calls.map((c) => c[0])
    expect(calls).toEqual(['BEGIN', 'ROLLBACK'])
    expect(release).toHaveBeenCalledOnce()
  })

  it('releases the client even when ROLLBACK itself fails', async () => {
    const query = vi.fn().mockImplementation((sql: string) => {
      if (sql === 'ROLLBACK') return Promise.reject(new Error('rollback failed'))
      if (sql === 'BEGIN') return Promise.reject({ code: '23505' })
      return Promise.resolve({ rows: [] })
    })
    const { db, release } = makeDb(query)

    await expect(withTransaction(db, async () => 'never')).rejects.toMatchObject({ code: '23505' })

    expect(release).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledWith(true)
  })
})
