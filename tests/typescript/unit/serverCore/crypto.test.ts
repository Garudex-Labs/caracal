// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for ChaCha20-Poly1305 seal/open, SHA-256, and key loading.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { open, seal, sha256, sha256Hex, loadStreamsHmacKey, loadZoneKek } from '../../../../packages/serverCore/ts/src/crypto.js'

const KEY = Buffer.alloc(32, 0x42)

describe('seal / open', () => {
  it('round-trips plaintext', () => {
    const plaintext = Buffer.from('hello world')
    const sealed = seal(KEY, plaintext)
    expect(open(KEY, sealed).toString()).toBe('hello world')
  })

  it('produces a distinct ciphertext on each call due to random nonce', () => {
    const plaintext = Buffer.from('same input')
    const a = seal(KEY, plaintext)
    const b = seal(KEY, plaintext)
    expect(a.ciphertext.toString('hex')).not.toBe(b.ciphertext.toString('hex'))
  })

  it('rejects decryption with the wrong key', () => {
    const sealed = seal(KEY, Buffer.from('secret'))
    expect(() => open(Buffer.alloc(32, 0x11), sealed)).toThrow()
  })

  it('rejects a truncated ciphertext', () => {
    const sealed = seal(KEY, Buffer.from('secret'))
    expect(() => open(KEY, { ciphertext: Buffer.alloc(4), nonce: sealed.nonce })).toThrow()
  })
})

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

describe('loadZoneKek', () => {
  let orig: string | undefined
  beforeEach(() => {
    orig = process.env.ZONE_KEK
  })
  afterEach(() => {
    if (orig === undefined) delete process.env.ZONE_KEK
    else process.env.ZONE_KEK = orig
  })

  it('loads a valid 32-byte hex key', () => {
    process.env.ZONE_KEK = Buffer.alloc(32, 0x42).toString('hex')
    expect(loadZoneKek().length).toBe(32)
  })

  it('throws when ZONE_KEK is absent', () => {
    delete process.env.ZONE_KEK
    expect(() => loadZoneKek()).toThrow('ZONE_KEK is required')
  })

  it('throws when ZONE_KEK decodes to wrong length', () => {
    process.env.ZONE_KEK = 'aabbcc'
    expect(() => loadZoneKek()).toThrow()
  })

  it('throws when ZONE_KEK is all zeros', () => {
    process.env.ZONE_KEK = '00'.repeat(32)
    expect(() => loadZoneKek()).toThrow('all zeros')
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
