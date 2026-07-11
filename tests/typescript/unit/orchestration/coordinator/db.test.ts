// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the coordinator's startup schema-compatibility probe.

import '../../../../shared/test-utils/typescript/coordinatorEnv.js'
import { describe, it, expect, vi } from 'vitest'
import { assertSchemaCompatible } from '../../../../../apps/coordinator/src/db.js'

describe('assertSchemaCompatible', () => {
  it('passes when the session columns resolve and the DELETE grant holds', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ can_delete: true }] })
    await expect(assertSchemaCompatible({ query })).resolves.toBeUndefined()
    expect(query).toHaveBeenCalledWith(expect.stringContaining('lease_generation'))
  })

  it('names the missing column when the schema predates this build', async () => {
    const query = vi.fn().mockRejectedValueOnce(new Error('column "lease_generation" does not exist'))
    await expect(assertSchemaCompatible({ query })).rejects.toThrow(/schema incompatible.*lease_generation.*baseline migration/s)
  })

  it('fails when the retention DELETE grant is missing', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ can_delete: false }] })
    await expect(assertSchemaCompatible({ query })).rejects.toThrow(/sessions DELETE grant/)
  })
})
