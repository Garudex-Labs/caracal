// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Retention cleaner unit tests covering lock gating and Console row pruning.

import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../../../shared/test-utils/typescript/coordinatorEnv.js'
import {
  retentionCleanerStats,
  runRetentionCleanup,
  startRetentionCleaner,
} from '../../../../../../apps/coordinator/src/jobs/retention-cleaner.js'

function clientWithRows(rows: Array<{ rowCount?: number; rows?: unknown[] }>) {
  return {
    query: vi.fn(async () => rows.shift() ?? { rows: [], rowCount: 0 }),
    release: vi.fn(),
  }
}

describe('runRetentionCleanup', () => {
  it('prunes only published outbox rows so dead rows remain recoverable', async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ acquired: true }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rowCount: 0 })
        .mockResolvedValueOnce({ rowCount: 0 })
        .mockResolvedValueOnce({ rowCount: 0 })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    const db = { connect: vi.fn().mockResolvedValue(client) }

    await runRetentionCleanup(db as never)

    const outboxQuery = client.query.mock.calls.find(([sql]) => String(sql).includes('DELETE FROM caracal_outbox'))
    expect(String(outboxQuery?.[0])).toContain("status = 'published'")
    expect(String(outboxQuery?.[0])).not.toContain("'dead'")
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('skips cleanup when another replica holds the lock', async () => {
    const client = clientWithRows([{ rows: [] }, { rows: [{ acquired: false }] }, { rows: [] }])
    const db = { connect: vi.fn().mockResolvedValueOnce(client) }
    await expect(runRetentionCleanup(db as never)).resolves.toEqual({
      expiredEdges: 0,
      deletedEdges: 0,
      deletedOutbox: 0,
      deletedIdempotencyReceipts: 0,
    })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining('DELETE FROM delegation_edges'), expect.anything())
  })

  it('expires active edges, invalidates delegation caches, and prunes Console rows', async () => {
    const client = clientWithRows([
      { rows: [] },
      { rows: [{ acquired: true }] },
      {
        rows: [
          { id: 'edge-1', zone_id: 'z1', source_session_id: 's1', target_session_id: 's2' },
          { id: 'edge-2', zone_id: 'z1', source_session_id: 's2', target_session_id: 's3' },
        ],
      },
      { rows: [{ epoch: '7' }] },
      { rows: [] },
      { rowCount: 3 },
      { rowCount: 4 },
      { rowCount: 5 },
      { rows: [] },
    ])
    const db = { connect: vi.fn().mockResolvedValueOnce(client) }
    await expect(runRetentionCleanup(db as never)).resolves.toEqual({
      expiredEdges: 2,
      deletedEdges: 3,
      deletedOutbox: 4,
      deletedIdempotencyReceipts: 5,
    })
    const edgeDelete = client.query.mock.calls.find((call) => String(call[0]).includes('DELETE FROM delegation_edges'))
    expect(String(edgeDelete?.[0])).toContain('child.parent_edge_id = delegation_edges.id')

    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("status = 'expired'"), [500])
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("pg_advisory_xact_lock(hashtext('delegation:' || zone_id))"), [500])
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('RETURNING epoch'), ['z1'])
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO caracal_outbox'),
      expect.arrayContaining([
        'caracal.delegations.invalidate',
        'edge_expire:z1:7',
        expect.objectContaining({
          event: 'edge_expire',
          zone_id: 'z1',
          affected_edges: 2,
          edge_ids: ['edge-1', 'edge-2'],
          epoch: 7,
        }),
      ]),
    )
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM delegation_edges d'), [90, 500])
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM caracal_outbox o'), [7, 500])
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM coordinator_idempotency_receipts r'), [500])
    expect(client.query.mock.calls.some((call) => String(call[0]).includes('UPDATE sessions'))).toBe(false)
    expect(client.query).toHaveBeenCalledWith('COMMIT')
  })

  it('rolls back and releases when expiration fails', async () => {
    const err = new Error('expire failed')
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ acquired: true }] })
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    const db = { connect: vi.fn().mockResolvedValueOnce(client) }

    await expect(runRetentionCleanup(db as never)).rejects.toThrow(err)

    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('updates start-helper stats and logs interval failures', async () => {
    vi.useFakeTimers()
    const beforeRuns = retentionCleanerStats.runs
    const beforeFailures = retentionCleanerStats.failures
    const err = new Error('connect failed')
    const log = { error: vi.fn() }
    const db = { connect: vi.fn().mockRejectedValue(err) }
    const handle = startRetentionCleaner(db as never, { intervalMs: 10, log })

    await vi.advanceTimersByTimeAsync(10)
    await handle.stop()

    expect(retentionCleanerStats.runs).toBe(beforeRuns + 1)
    expect(retentionCleanerStats.failures).toBe(beforeFailures + 1)
    expect(log.error).toHaveBeenCalledWith({ err }, 'retention_cleanup_failed')
  })
})
