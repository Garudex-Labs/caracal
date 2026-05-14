// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// DCR garbage collection job unit tests for archived application counts.

import { describe, it, expect, vi } from 'vitest'
import type { DB } from '../../../../../apps/api/src/db.js'
import { runDCRGC } from '../../../../../apps/api/src/jobs/dcr-gc.js'

describe('runDCRGC', () => {
  it('archives expired DCR applications and returns affected row count', async () => {
    const db = { query: vi.fn().mockResolvedValueOnce({ rowCount: 7 }) }

    const count = await runDCRGC(db as unknown as DB)

    expect(count).toBe(7)
    expect(db.query.mock.calls[0][0]).toContain("registration_method = 'dcr'")
    expect(db.query.mock.calls[0][0]).toContain('archived_at IS NULL')
  })

  it('returns zero when the database does not provide rowCount', async () => {
    const db = { query: vi.fn().mockResolvedValueOnce({}) }

    await expect(runDCRGC(db as unknown as DB)).resolves.toBe(0)
  })
})