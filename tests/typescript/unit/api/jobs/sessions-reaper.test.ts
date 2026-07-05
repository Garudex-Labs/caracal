// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Sessions reaper job unit tests for bounded orphan-session expiration.

import { describe, expect, it, vi } from 'vitest'
import type { DB } from '../../../../../apps/api/src/db.js'
import { runSessionsReap } from '../../../../../apps/api/src/jobs/sessions-reaper.js'

function makeClient(acquired: boolean, rowCount = 0) {
  return {
    query: vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ acquired }] })
      .mockResolvedValueOnce({ rowCount })
      .mockResolvedValueOnce({ rows: [] }),
    release: vi.fn(),
  }
}

describe('runSessionsReap', () => {
  it('skips when another worker holds the lock', async () => {
    const client = makeClient(false)
    const db = { connect: vi.fn().mockResolvedValueOnce(client) }

    await expect(runSessionsReap(db as unknown as DB)).resolves.toBe(0)

    expect(client.query).toHaveBeenCalledTimes(1)
    expect(client.release).toHaveBeenCalled()
  })

  it('expires orphan sessions in bounded batches', async () => {
    const client = makeClient(true, 9)
    const db = { connect: vi.fn().mockResolvedValueOnce(client) }

    await expect(runSessionsReap(db as unknown as DB)).resolves.toBe(9)

    expect(client.query.mock.calls[1][0]).toContain('LIMIT $1')
    expect(client.query.mock.calls[1][1]).toEqual([500])
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_unlock'), ['7163920485318481'])
  })
})
