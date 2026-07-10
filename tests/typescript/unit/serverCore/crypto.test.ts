// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for SHA-256 helpers and stream HMAC key loading.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sha256, sha256Hex, loadStreamsHmacKey } from '../../../../packages/serverCore/ts/src/crypto.js'

describe('sha256 / sha256Hex', () => {
  it('returns consistent bytes for the same input', () => {
    const h1 = sha256('hello')
    const h2 = sha256('hello')
    expect(h1.toString('hex')).toBe(h2.toString('hex'))
  })

  it('sha256Hex matches sha256 hex output', () => {
    const input = 'test input'
    expect(sha256Hex(input)).toBe(sha256(input).toString('hex'))
  })

  it('produces distinct hashes for distinct inputs', () => {
    expect(sha256Hex('a')).not.toBe(sha256Hex('b'))
  })
})

describe('loadStreamsHmacKey', () => {
  let orig: string | undefined
  beforeEach(() => {
    orig = process.env.STREAMS_HMAC_KEY
  })
  afterEach(() => {
    if (orig === undefined) delete process.env.STREAMS_HMAC_KEY
    else process.env.STREAMS_HMAC_KEY = orig
  })

  it('returns null when STREAMS_HMAC_KEY is not set', () => {
    delete process.env.STREAMS_HMAC_KEY
    expect(loadStreamsHmacKey()).toBeNull()
  })

  it('loads a valid hex key of at least 32 bytes', () => {
    process.env.STREAMS_HMAC_KEY = Buffer.alloc(32, 0x42).toString('hex')
    expect(loadStreamsHmacKey()?.length).toBe(32)
  })

  it('throws when the decoded key is under 32 bytes', () => {
    process.env.STREAMS_HMAC_KEY = 'aabb'
    expect(() => loadStreamsHmacKey()).toThrow()
  })
})
