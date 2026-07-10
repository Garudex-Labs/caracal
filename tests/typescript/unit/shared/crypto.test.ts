// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for HMAC stream signing.

import { describe, expect, it } from 'vitest'
import { signStream, STREAM_SIG_FIELD } from '../../../../packages/core/ts/src/crypto.js'

describe('signStream', () => {
  const KEY32 = Buffer.alloc(32, 0x11)

  it('produces the same signature for identical inputs', () => {
    const values = { field1: 'a', field2: 42 }
    expect(signStream(KEY32, 'stream', values)).toBe(signStream(KEY32, 'stream', values))
  })

  it('produces different signatures for different field values', () => {
    expect(signStream(KEY32, 'stream', { x: 'a' })).not.toBe(signStream(KEY32, 'stream', { x: 'b' }))
  })

  it('produces different signatures for different stream names', () => {
    const values = { x: 'v' }
    expect(signStream(KEY32, 'stream-a', values)).not.toBe(signStream(KEY32, 'stream-b', values))
  })

  it('ignores the _sig field in canonical form', () => {
    const base = signStream(KEY32, 'stream', { x: 1 })
    const withSig = signStream(KEY32, 'stream', { x: 1, [STREAM_SIG_FIELD]: 'old-sig' })
    expect(base).toBe(withSig)
  })

  it('skips null and undefined values', () => {
    const base = signStream(KEY32, 'stream', { x: 1 })
    const withNulls = signStream(KEY32, 'stream', { x: 1, y: null, z: undefined })
    expect(base).toBe(withNulls)
  })
})
