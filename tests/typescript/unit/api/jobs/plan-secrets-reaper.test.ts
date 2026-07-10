// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Plan secrets reaper job unit tests for bounded expired-credential deletion.

import { describe, expect, it, vi } from 'vitest'
import type { DB } from '../../../../../apps/api/src/db.js'
import { runPlanSecretsReap } from '../../../../../apps/api/src/jobs/plan-secrets-reaper.js'

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

describe('runPlanSecretsReap', () => {
  it('skips when another worker holds the lock', async () => {
    const client = makeClient(false)
    const db = { connect: vi.fn().mockResolvedValueOnce(client) }

    await expect(runPlanSecretsReap(db as unknown as DB)).resolves.toBe(0)

    expect(client.query).toHaveBeenCalledTimes(1)
    expect(client.release).toHaveBeenCalled()
  })

  it('deletes expired plan secrets in bounded batches', async () => {
    const client = makeClient(true, 7)
    const db = { connect: vi.fn().mockResolvedValueOnce(client) }

    await expect(runPlanSecretsReap(db as unknown as DB)).resolves.toBe(7)

    expect(client.query.mock.calls[1][0]).toContain('expires_at < now()')
    expect(client.query.mock.calls[1][0]).toContain('LIMIT $1')
    expect(client.query.mock.calls[1][1]).toEqual([500])
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_unlock'), ['7163920485318483'])
  })
})
