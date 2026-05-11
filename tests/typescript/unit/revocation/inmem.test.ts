// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// In-memory revocation store unit tests.

import { describe, expect, it, vi } from 'vitest'
import { InMemoryRevocationStore } from '../../../../packages/revocation/ts/src/inmem.js'

describe('InMemoryRevocationStore', () => {
  it('marks sessions revoked until ttl expiry', () => {
    vi.useFakeTimers()
    try {
      const store = new InMemoryRevocationStore({ defaultTtlMs: 1_000 })
      store.markRevoked('sid-1')
      expect(store.isRevoked('sid-1')).toBe(true)
      vi.advanceTimersByTime(1_001)
      expect(store.isRevoked('sid-1')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds capacity by evicting the oldest entry', () => {
    const store = new InMemoryRevocationStore({ maxEntries: 2 })
    store.markRevoked('sid-1')
    store.markRevoked('sid-2')
    store.markRevoked('sid-3')
    expect(store.isRevoked('sid-1')).toBe(false)
    expect(store.isRevoked('sid-2')).toBe(true)
    expect(store.isRevoked('sid-3')).toBe(true)
  })
})
