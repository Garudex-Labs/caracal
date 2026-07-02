// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Message runs reaper job unit tests for bounded deadline enforcement.

import { describe, expect, it, vi } from 'vitest'
import type { DB } from '../../../../../apps/api/src/db.js'
import { runMessageRunsReap } from '../../../../../apps/api/src/jobs/message-runs-reaper.js'

function makeClient(acquired: boolean, rowCount = 0) {
  return {
    query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ acquired }] })
      .mockResolvedValueOnce({ rowCount })
      .mockResolvedValueOnce({ rows: [] }),
    release: vi.fn(),
  }
}

describe('runMessageRunsReap', () => {
  it('skips when another worker holds the lock', async () => {
    const client = makeClient(false)
    const db = { connect: vi.fn().mockResolvedValueOnce(client) }

    await expect(runMessageRunsReap(db as unknown as DB)).resolves.toBe(0)

    expect(client.query).toHaveBeenCalledTimes(1)
    expect(client.release).toHaveBeenCalled()
  })

  it('times out expired runs in bounded batches', async () => {
    const client = makeClient(true, 4)
    const db = { connect: vi.fn().mockResolvedValueOnce(client) }

    await expect(runMessageRunsReap(db as unknown as DB)).resolves.toBe(4)

    const reap = client.query.mock.calls[1][0] as string
    expect(reap).toContain('LIMIT $1')
    expect(reap).toContain("SET state = 'timeout'")
    expect(reap).toContain('deadline_at < now()')
    expect(client.query.mock.calls[1][1]).toEqual([500])
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_unlock'),
      ['7163920485318482'],
    )
  })
})
