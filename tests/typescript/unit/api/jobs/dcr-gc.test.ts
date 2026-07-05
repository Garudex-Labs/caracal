// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// DCR garbage collection job unit tests for archived application counts.

import { describe, it, expect, vi } from 'vitest'
import type { DB } from '../../../../../apps/api/src/db.js'
import { runDCRGC } from '../../../../../apps/api/src/jobs/dcr-gc.js'

describe('runDCRGC', () => {
  function makeClient(acquired: boolean, gcResult: Record<string, unknown> = {}) {
    return {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ acquired }] })
        .mockResolvedValueOnce(gcResult)
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
  }

  it('archives expired DCR applications and returns affected row count', async () => {
    const client = makeClient(true, { rowCount: 7 })
    const db = { connect: vi.fn().mockResolvedValueOnce(client) }

    const count = await runDCRGC(db as unknown as DB)

    expect(count).toBe(7)
    expect(client.query.mock.calls[1][0]).toContain("registration_method = 'dcr'")
    expect(client.query.mock.calls[1][0]).toContain('archived_at IS NULL')
    expect(client.query.mock.calls[1][0]).toContain('LIMIT $1')
    expect(client.query.mock.calls[1][1]).toEqual([500])
    expect(client.query.mock.calls[2][0]).toContain('pg_advisory_unlock')
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it('returns zero when the database does not provide rowCount', async () => {
    const client = makeClient(true)
    const db = { connect: vi.fn().mockResolvedValueOnce(client) }

    await expect(runDCRGC(db as unknown as DB)).resolves.toBe(0)
  })

  it('skips the batch when another worker holds the lock', async () => {
    const client = makeClient(false)
    const db = { connect: vi.fn().mockResolvedValueOnce(client) }

    await expect(runDCRGC(db as unknown as DB)).resolves.toBe(0)
    expect(client.query).toHaveBeenCalledTimes(1)
    expect(client.release).toHaveBeenCalledTimes(1)
  })
})
