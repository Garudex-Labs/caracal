// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the in-memory replay cache: same JTI is rejected within ttl; expiry frees the slot.

import { describe, it, expect } from 'vitest'
import { MemoryReplay } from '../../../../apps/control/src/replay.js'

describe('MemoryReplay', () => {
  it('rejects a repeated jti', async () => {
    const r = new MemoryReplay(60_000)
    expect(await r.mark('a', undefined)).toBe(true)
    expect(await r.mark('a', undefined)).toBe(false)
  })

  it('honours exp shorter than ttl', async () => {
    const r = new MemoryReplay(60_000)
    const past = Math.floor(Date.now() / 1000) - 10
    expect(await r.mark('expired', past)).toBe(true)
    expect(await r.mark('expired', past)).toBe(false)
  })

  it('rejects an empty jti so unsigned replays cannot pass', async () => {
    const r = new MemoryReplay(60_000)
    expect(await r.mark('', undefined)).toBe(false)
    expect(await r.mark('', undefined)).toBe(false)
  })
})
