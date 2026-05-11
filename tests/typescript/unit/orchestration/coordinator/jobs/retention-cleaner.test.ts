// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Retention cleaner unit tests covering lock gating and terminal row pruning.

import { beforeAll, describe, expect, it, vi } from 'vitest'
import { runRetentionCleanup } from '../../../../../../apps/coordinator/src/jobs/retention-cleaner.js'

beforeAll(() => {
  process.env.ISSUER_URL ??= 'http://issuer.test'
  process.env.AGENT_COORDINATOR_AUDIENCE ??= 'coord.test'
  process.env.STS_URL ??= 'http://sts.test'
  process.env.AGENT_COORDINATOR_SCOPE ??= 'coordinator.use'
  process.env.DATABASE_URL ??= 'postgres://x'
  process.env.REDIS_URL ??= 'redis://x'
  process.env.DELEGATION_RETENTION_DAYS ??= '90'
  process.env.OUTBOX_RETENTION_DAYS ??= '7'
  process.env.RETENTION_CLEANUP_BATCH_SIZE ??= '500'
})

function clientWithRows(rows: Array<{ rowCount?: number; rows?: unknown[] }>) {
  return {
    query: vi.fn(async () => rows.shift() ?? { rows: [], rowCount: 0 }),
    release: vi.fn(),
  }
}

describe('runRetentionCleanup', () => {
  it('skips cleanup when another replica holds the lock', async () => {
    const client = clientWithRows([
      { rows: [] },
      { rows: [{ acquired: false }] },
      { rows: [] },
    ])
    const db = { connect: vi.fn().mockResolvedValueOnce(client) }
    await expect(runRetentionCleanup(db as never)).resolves.toEqual({
      expiredEdges: 0,
      deletedEdges: 0,
      deletedOutbox: 0,
    })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining('DELETE FROM delegation_edges'), expect.anything())
  })

  it('expires active edges and prunes terminal rows', async () => {
    const client = clientWithRows([
      { rows: [] },
      { rows: [{ acquired: true }] },
      { rowCount: 2 },
      { rowCount: 3 },
      { rowCount: 4 },
      { rows: [] },
    ])
    const db = { connect: vi.fn().mockResolvedValueOnce(client) }
    await expect(runRetentionCleanup(db as never)).resolves.toEqual({
      expiredEdges: 2,
      deletedEdges: 3,
      deletedOutbox: 4,
    })
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("status = 'expired'"))
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM delegation_edges d'), [90, 500])
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM caracal_outbox o'), [7, 500])
    expect(client.query).toHaveBeenCalledWith('COMMIT')
  })
})
