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
  idempotencyStats,
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
    const queries: string[] = []
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        queries.push(sql)
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
    expect(queries.some((sql) => sql.includes('coordinator_idempotency_receipts') && sql.includes('FOR UPDATE'))).toBe(false)
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

describe('skip unnecessary expiry deletes', () => {
  const input = {
    operation: 'session.start.v2',
    zoneId: 'z1',
    scopeId: 'app1',
    key: 'operation-1',
    request: {},
    hmacKeys: [Buffer.alloc(32, 1)],
    maxReceiptsPerScope: 10,
  }

  it('reads after a separate lock and does not delete or count for a live replay', async () => {
    const queries: string[] = []
    const db = {
      query: async (sql: string) => {
        queries.push(sql)
        if (sql.includes('SELECT request_digest'))
          return {
            rows: [
              { live: true, request_digest: requestDigest({}), response_status: 201, response_json: { id: 'one' }, resource_id: 'one' },
            ],
          }
        return { rows: [], rowCount: 0 }
      },
    }
    expect(await startIdempotency(db, input)).toMatchObject({ outcome: 'replayed', response: { id: 'one' } })
    expect(queries).toHaveLength(2)
    expect(queries[0]).toContain('pg_advisory_xact_lock')
    expect(queries[1]).not.toContain('pg_advisory_xact_lock')
    expect(queries[1]).toContain('expires_at > now() AS live')
  })

  it('does not issue an expiry DELETE for a new key', async () => {
    const queries: string[] = []
    const db = {
      query: async (sql: string) => {
        queries.push(sql)
        return { rows: sql.includes('SELECT COUNT') ? [{ n: '0' }] : [], rowCount: 0 }
      },
    }
    expect(await startIdempotency(db, input)).toMatchObject({ outcome: 'new' })
    expect(queries).toHaveLength(3)
    expect(queries.some((sql) => sql.includes('DELETE'))).toBe(false)
  })

  it('cleans expired rows, rereads after cleanup, and retains the live-receipt limit', async () => {
    const queries: string[] = []
    let reads = 0
    const db = {
      query: async (sql: string) => {
        queries.push(sql)
        if (sql.includes('SELECT request_digest'))
          return { rows: reads++ === 0 ? [{ live: false, request_digest: requestDigest({}) }] : [] }
        if (sql.includes('DELETE')) return { rows: [], rowCount: 1 }
        if (sql.includes('SELECT COUNT')) return { rows: [{ n: '10' }] }
        return { rows: [], rowCount: 0 }
      },
    }
    const expiredBefore = idempotencyStats.expired
    expect(await startIdempotency(db, input)).toEqual({ outcome: 'limit' })
    expect(idempotencyStats.expired).toBe(expiredBefore + 1)
    expect(queries).toHaveLength(5)
    expect(queries[2]).toContain('expires_at <= now()')
    expect(queries[3]).toContain('SELECT request_digest')
  })
})
