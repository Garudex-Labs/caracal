// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the Secret Store: CSS1 envelope, KEK loading, and backend selection.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  kekId,
  loadSecretStoreKek,
  openEnvelope,
  providerSecretConfigRef,
  sealEnvelope,
  secretBackendKind,
} from '../../../../packages/serverCore/ts/src/secretStore/index.js'

const KEK = Buffer.from('8f3d9a712c45e6b0d18f2a4c6e9b3d57a1c4f8020e6a9c3d5b7f1a2c4e6d8b90', 'hex')
const AAD = 'caracal/test/golden'

describe('sealEnvelope / openEnvelope', () => {
  it('round-trips plaintext under the caller AAD', () => {
    const envelope = sealEnvelope(KEK, Buffer.from('hello world'), AAD)
    expect(openEnvelope(KEK, envelope, AAD).toString()).toBe('hello world')
  })

  it('round-trips an empty value', () => {
    const envelope = sealEnvelope(KEK, Buffer.alloc(0), AAD)
    expect(openEnvelope(KEK, envelope, AAD).length).toBe(0)
  })

  it('produces a distinct envelope on each call due to random DEK and nonces', () => {
    const plaintext = Buffer.from('same input')
    const a = sealEnvelope(KEK, plaintext, AAD)
    const b = sealEnvelope(KEK, plaintext, AAD)
    expect(a.toString('hex')).not.toBe(b.toString('hex'))
  })

  it('rejects decryption with the wrong AAD', () => {
    const envelope = sealEnvelope(KEK, Buffer.from('secret'), AAD)
    expect(() => openEnvelope(KEK, envelope, 'caracal/test/other')).toThrow()
  })

  it('rejects decryption with a different KEK by identifier', () => {
    const envelope = sealEnvelope(KEK, Buffer.from('secret'), AAD)
    expect(() => openEnvelope(Buffer.alloc(32, 0x11), envelope, AAD)).toThrow('different KEK')
  })

  it('rejects a tampered value block', () => {
    const envelope = sealEnvelope(KEK, Buffer.from('secret'), AAD)
    envelope[envelope.length - 1] ^= 0xff
    expect(() => openEnvelope(KEK, envelope, AAD)).toThrow()
  })

  it('rejects a tampered data key block', () => {
    const envelope = sealEnvelope(KEK, Buffer.from('secret'), AAD)
    envelope[4 + 8 + 12] ^= 0xff
    expect(() => openEnvelope(KEK, envelope, AAD)).toThrow()
  })

  it('rejects a truncated envelope', () => {
    const envelope = sealEnvelope(KEK, Buffer.from('secret'), AAD)
    expect(() => openEnvelope(KEK, envelope.subarray(0, 50), AAD)).toThrow('too short')
  })

  it('rejects an unknown magic prefix', () => {
    const envelope = sealEnvelope(KEK, Buffer.from('secret'), AAD)
    envelope[0] = 0x58
    expect(() => openEnvelope(KEK, envelope, AAD)).toThrow('unknown format')
  })

  it('rejects sealing with a wrong-size KEK', () => {
    expect(() => sealEnvelope(Buffer.alloc(16), Buffer.from('secret'), AAD)).toThrow('32 bytes')
  })

  it('derives the KEK identifier as a SHA-256 prefix', () => {
    expect(kekId(KEK).length).toBe(8)
    expect(kekId(KEK).equals(kekId(Buffer.from(KEK)))).toBe(true)
  })

  it('opens the pinned golden envelope shared with the Go implementation', () => {
    const golden = Buffer.from(
      '435353318547798a706fba7297f14e4710dbb70cafae5284625e843ff8421f7c39a916393521998fb02c28cb8ed66bd59c3ee433fdb69dbe116f295b047f469dda4e0b18458de702ee430005bce2eb80fa7179ebc2f1703b332eb089df95e40689a592b90f696c8a10b80922d812515ec4db3ff067ccb578a016521c9e815538',
      'hex',
    )
    expect(openEnvelope(KEK, golden, AAD).toString()).toBe('cross-language golden secret')
  })
})

describe('loadSecretStoreKek', () => {
  let orig: string | undefined
  beforeEach(() => {
    orig = process.env.SECRET_STORE_KEK
  })
  afterEach(() => {
    if (orig === undefined) delete process.env.SECRET_STORE_KEK
    else process.env.SECRET_STORE_KEK = orig
  })

  it('loads a strong 32-byte hex key', () => {
    process.env.SECRET_STORE_KEK = KEK.toString('hex')
    expect(loadSecretStoreKek().equals(KEK)).toBe(true)
  })

  it('throws when SECRET_STORE_KEK is absent', () => {
    delete process.env.SECRET_STORE_KEK
    expect(() => loadSecretStoreKek()).toThrow('SECRET_STORE_KEK is required')
  })

  it('throws when SECRET_STORE_KEK decodes to the wrong length', () => {
    process.env.SECRET_STORE_KEK = 'aabbcc'
    expect(() => loadSecretStoreKek()).toThrow('32 bytes')
  })

  it.each([
    ['all zeros', '00'.repeat(32), 'all zeros'],
    ['repeated byte', 'aa'.repeat(32), 'repeat the same byte'],
    ['ascending bytes', Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('hex'), 'sequential byte pattern'],
    ['descending bytes', Buffer.from(Array.from({ length: 32 }, (_, i) => 31 - i)).toString('hex'), 'sequential byte pattern'],
    ['alternating bytes', 'aa55'.repeat(16), 'repeating byte pattern'],
  ])('rejects a weak KEK: %s', (_name, hexValue, message) => {
    process.env.SECRET_STORE_KEK = hexValue
    expect(() => loadSecretStoreKek()).toThrow(message)
  })
})

describe('secretBackendKind', () => {
  let orig: string | undefined
  beforeEach(() => {
    orig = process.env.CARACAL_SECRET_BACKEND
  })
  afterEach(() => {
    if (orig === undefined) delete process.env.CARACAL_SECRET_BACKEND
    else process.env.CARACAL_SECRET_BACKEND = orig
  })

  it('defaults to builtin when unset', () => {
    delete process.env.CARACAL_SECRET_BACKEND
    expect(secretBackendKind()).toBe('builtin')
  })

  it('trims and lowercases the configured kind', () => {
    process.env.CARACAL_SECRET_BACKEND = '  Vault '
    expect(secretBackendKind()).toBe('vault')
  })

  it('rejects an unknown kind', () => {
    process.env.CARACAL_SECRET_BACKEND = 'kms'
    expect(() => secretBackendKind()).toThrow("got 'kms'")
  })
})

describe('providerSecretConfigRef', () => {
  it('derives the ref from zone and provider identifiers', () => {
    expect(providerSecretConfigRef('zone-1', 'provider-1')).toBe('zones/zone-1/providers/provider-1/secretConfig')
  })
})
