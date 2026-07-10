// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Durable Coordinator idempotency contract tests.

import { describe, expect, it } from 'vitest'
import {
  IDEMPOTENCY_KEY_MAX_BYTES,
  IdempotencyKeyError,
  canonicalJson,
  keyDigest,
  parseIdempotencyKey,
  requestDigest,
  startIdempotency,
} from '../../../../../apps/coordinator/src/idempotency.js'

describe('idempotency key validation', () => {
  it('accepts opaque identifiers without normalizing them', () => {
    expect(parseIdempotencyKey('ticket-queue:v1:PP-8412')).toBe('ticket-queue:v1:PP-8412')
  })

  it.each([
    ['', 'idempotency_key_invalid'],
    [' key', 'idempotency_key_invalid'],
    ['key ', 'idempotency_key_invalid'],
    ['key\nvalue', 'idempotency_key_invalid'],
    ['x'.repeat(IDEMPOTENCY_KEY_MAX_BYTES + 1), 'idempotency_key_invalid'],
  ])('rejects unsafe key %#', (key, code) => {
    expect(() => parseIdempotencyKey(key)).toThrowError(IdempotencyKeyError)
    try {
      parseIdempotencyKey(key)
    } catch (err) {
      expect((err as IdempotencyKeyError).code).toBe(code)
    }
  })

  it('rejects duplicate header values instead of choosing one', () => {
    expect(() => parseIdempotencyKey(['one', 'two'])).toThrow('exactly once')
  })
})

describe('canonical request fingerprints', () => {
  it('is stable across object key order and sensitive to semantic changes', () => {
    expect(canonicalJson({ b: 2, a: { y: true, x: ['one'] } })).toBe(canonicalJson({ a: { x: ['one'], y: true }, b: 2 }))
    expect(requestDigest({ task: 'one' }).equals(requestDigest({ task: 'two' }))).toBe(false)
  })

  it('rejects values JSON cannot safely represent', () => {
    expect(() => canonicalJson({ value: Number.NaN })).toThrow('non-finite')
    expect(() => canonicalJson({ value: undefined })).toThrow('unsupported')
  })
})

describe('key storage digest', () => {
  it('is deterministic for one key, separated by the HMAC key, and never plaintext', () => {
    const one = Buffer.alloc(32, 1)
    const two = Buffer.alloc(32, 2)
    const a = keyDigest('delivery-42', one)
    expect(a).toHaveLength(32)
    expect(a.equals(keyDigest('delivery-42', one))).toBe(true)
    expect(a.equals(keyDigest('delivery-42', two))).toBe(false)
    expect(a.includes(Buffer.from('delivery-42'))).toBe(false)
  })
})

describe('rotation serialization', () => {
  it('uses one per-key lock across old, new, and overlap key configurations', async () => {
    const locks: string[] = []
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('pg_advisory_xact_lock')) locks.push(String(params?.[0]))
        if (sql.includes('SELECT COUNT')) return { rows: [{ n: '0' }] }
        return { rows: [], rowCount: 0 }
      },
    }
    const one = Buffer.alloc(32, 1)
    const two = Buffer.alloc(32, 2)
    for (const hmacKeys of [[one], [two, one], [two]]) {
      await startIdempotency(db, {
        operation: 'session.start.v2',
        zoneId: 'z1',
        scopeId: 'app1',
        key: 'operation-1',
        request: {},
        hmacKeys,
        maxReceiptsPerScope: 10,
      })
    }
    expect(new Set(locks)).toHaveLength(1)
    expect(locks[0]).toMatch(/^session\.start\.v2:z1:app1:[a-f0-9]{64}$/)
  })

  it('does not serialize unrelated idempotency keys in one scope', async () => {
    const locks: string[] = []
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('pg_advisory_xact_lock')) locks.push(String(params?.[0]))
        if (sql.includes('SELECT COUNT')) return { rows: [{ n: '0' }] }
        return { rows: [], rowCount: 0 }
      },
    }
    for (const key of ['operation-1', 'operation-2']) {
      await startIdempotency(db, {
        operation: 'session.start.v2',
        zoneId: 'z1',
        scopeId: 'app1',
        key,
        request: {},
        hmacKeys: [Buffer.alloc(32, 1)],
        maxReceiptsPerScope: 10,
      })
    }
    expect(new Set(locks).size).toBe(2)
  })
})
