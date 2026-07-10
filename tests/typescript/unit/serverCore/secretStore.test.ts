// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the Secret Store: CSS1 envelope, KEK loading, and backend selection.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CustomBackend,
  SealedBackend,
  kekId,
  loadSecretStoreKek,
  loadSecretStoreKeks,
  openEnvelope,
  openSecretEnvelope,
  providerSecretConfigRef,
  sealEnvelope,
  sealSecretEnvelope,
  secretBackendKind,
  type SecretBackend,
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

const PREVIOUS_KEK = Buffer.from('d1c4f8020e6a9c3d5b7f1a2c4e6d8b908f3d9a712c45e6b0d18f2a4c6e9b3d57', 'hex')

describe('keyring rotation', () => {
  let origCurrent: string | undefined
  let origPrevious: string | undefined
  beforeEach(() => {
    origCurrent = process.env.SECRET_STORE_KEK
    origPrevious = process.env.SECRET_STORE_KEK_PREVIOUS
    process.env.SECRET_STORE_KEK = KEK.toString('hex')
    delete process.env.SECRET_STORE_KEK_PREVIOUS
  })
  afterEach(() => {
    if (origCurrent === undefined) delete process.env.SECRET_STORE_KEK
    else process.env.SECRET_STORE_KEK = origCurrent
    if (origPrevious === undefined) delete process.env.SECRET_STORE_KEK_PREVIOUS
    else process.env.SECRET_STORE_KEK_PREVIOUS = origPrevious
  })

  it('loads the current key alone when no previous key is set', () => {
    const keys = loadSecretStoreKeks()
    expect(keys).toHaveLength(1)
    expect(keys[0].equals(KEK)).toBe(true)
  })

  it('loads current and previous keys in order', () => {
    process.env.SECRET_STORE_KEK_PREVIOUS = PREVIOUS_KEK.toString('hex')
    const keys = loadSecretStoreKeks()
    expect(keys).toHaveLength(2)
    expect(keys[0].equals(KEK)).toBe(true)
    expect(keys[1].equals(PREVIOUS_KEK)).toBe(true)
  })

  it('validates the previous key under its own name', () => {
    process.env.SECRET_STORE_KEK_PREVIOUS = 'aa'.repeat(32)
    expect(() => loadSecretStoreKeks()).toThrow('SECRET_STORE_KEK_PREVIOUS must not repeat the same byte')
  })

  it('opens envelopes sealed under the previous key during a rotation window', () => {
    const envelope = sealEnvelope(PREVIOUS_KEK, Buffer.from('rotate me'), AAD)
    expect(() => openSecretEnvelope(envelope, AAD)).toThrow('different KEK')
    process.env.SECRET_STORE_KEK_PREVIOUS = PREVIOUS_KEK.toString('hex')
    expect(openSecretEnvelope(envelope, AAD).toString()).toBe('rotate me')
  })

  it('always seals under the current key', () => {
    process.env.SECRET_STORE_KEK_PREVIOUS = PREVIOUS_KEK.toString('hex')
    const envelope = sealSecretEnvelope(Buffer.from('fresh'), AAD)
    expect(() => openEnvelope(PREVIOUS_KEK, envelope, AAD)).toThrow('different KEK')
    expect(openEnvelope(KEK, envelope, AAD).toString()).toBe('fresh')
  })
})

class MapBackend implements SecretBackend {
  readonly kind = 'custom' as const
  readonly stored = new Map<string, Buffer>()
  async put(ref: string, value: Buffer): Promise<void> {
    this.stored.set(ref, Buffer.from(value))
  }
  async get(ref: string): Promise<Buffer | null> {
    const value = this.stored.get(ref)
    return value ? Buffer.from(value) : null
  }
  async delete(ref: string): Promise<void> {
    this.stored.delete(ref)
  }
}

describe('SealedBackend', () => {
  let orig: string | undefined
  beforeEach(() => {
    orig = process.env.SECRET_STORE_KEK
    process.env.SECRET_STORE_KEK = KEK.toString('hex')
  })
  afterEach(() => {
    if (orig === undefined) delete process.env.SECRET_STORE_KEK
    else process.env.SECRET_STORE_KEK = orig
  })

  const ref = providerSecretConfigRef('z1', 'p1')

  it('stores only sealed envelopes in the inner backend', async () => {
    const inner = new MapBackend()
    const sealed = new SealedBackend(inner)
    await sealed.put(ref, Buffer.from('plaintext credential'))
    const stored = inner.stored.get(ref)!
    expect(stored.subarray(0, 4).toString('ascii')).toBe('CSS1')
    expect(stored.includes(Buffer.from('plaintext credential'))).toBe(false)
    expect((await sealed.get(ref))!.toString()).toBe('plaintext credential')
  })

  it('rejects an envelope served for a different ref', async () => {
    const inner = new MapBackend()
    const sealed = new SealedBackend(inner)
    await sealed.put(ref, Buffer.from('secret'))
    inner.stored.set(providerSecretConfigRef('z1', 'p2'), inner.stored.get(ref)!)
    await expect(sealed.get(providerSecretConfigRef('z1', 'p2'))).rejects.toThrow()
  })

  it('passes through missing refs and deletes', async () => {
    const inner = new MapBackend()
    const sealed = new SealedBackend(inner)
    expect(await sealed.get(ref)).toBeNull()
    await sealed.put(ref, Buffer.from('secret'))
    await sealed.delete(ref)
    expect(inner.stored.has(ref)).toBe(false)
    expect(sealed.kind).toBe('custom')
  })
})

describe('external backend TLS enforcement', () => {
  let origUrl: string | undefined
  let origToken: string | undefined
  beforeEach(() => {
    origUrl = process.env.CARACAL_CUSTOM_SECRETS_URL
    origToken = process.env.CARACAL_CUSTOM_SECRETS_TOKEN
    process.env.CARACAL_CUSTOM_SECRETS_TOKEN = 'tok'
  })
  afterEach(() => {
    if (origUrl === undefined) delete process.env.CARACAL_CUSTOM_SECRETS_URL
    else process.env.CARACAL_CUSTOM_SECRETS_URL = origUrl
    if (origToken === undefined) delete process.env.CARACAL_CUSTOM_SECRETS_TOKEN
    else process.env.CARACAL_CUSTOM_SECRETS_TOKEN = origToken
  })

  it('rejects a plain-http endpoint on a routable host', () => {
    process.env.CARACAL_CUSTOM_SECRETS_URL = 'http://secrets.internal.example'
    expect(() => new CustomBackend()).toThrow('must be an https URL')
  })

  it('rejects an unparseable endpoint', () => {
    process.env.CARACAL_CUSTOM_SECRETS_URL = 'not a url'
    expect(() => new CustomBackend()).toThrow('must be a valid URL')
  })

  it.each([
    ['https', 'https://secrets.internal.example'],
    ['loopback http', 'http://127.0.0.1:9200'],
    ['localhost http', 'http://localhost:9200'],
  ])('accepts a %s endpoint', (_name, url) => {
    process.env.CARACAL_CUSTOM_SECRETS_URL = url
    expect(() => new CustomBackend()).not.toThrow()
  })
})
