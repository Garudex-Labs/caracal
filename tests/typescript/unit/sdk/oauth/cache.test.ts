// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// InMemoryTokenCache unit tests.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { InMemoryTokenCache } from '../../../../../packages/oauth/ts/src/cache.js'
import type { TokenExchangeResponse } from '../../../../../packages/oauth/ts/src/types.js'

function makeToken(expiresIn: number, issuedAt?: number): TokenExchangeResponse {
  return {
    accessToken: 'tok-' + Math.random().toString(36).slice(2),
    tokenType: 'Bearer',
    expiresIn,
    issuedAt: issuedAt ?? Math.floor(Date.now() / 1000),
  }
}

describe('InMemoryTokenCache', () => {
  let cache: InMemoryTokenCache

  beforeEach(() => {
    cache = new InMemoryTokenCache()
  })

  it('returns undefined for unknown key', () => {
    expect(cache.get('subject-a', 'resource://api')).toBeUndefined()
  })

  it('returns stored token before expiry', () => {
    const token = makeToken(900)
    cache.set('subject-a', 'resource://api', token)
    expect(cache.get('subject-a', 'resource://api')).toBe(token)
  })

  it('evicts expired token', () => {
    const expired = makeToken(1, Math.floor(Date.now() / 1000) - 10)
    cache.set('subject-a', 'resource://api', expired)
    expect(cache.get('subject-a', 'resource://api')).toBeUndefined()
  })

  it('does not cross subject identities', () => {
    const tokenA = makeToken(900)
    const tokenB = makeToken(900)
    cache.set('subject-a', 'resource://api', tokenA)
    cache.set('subject-b', 'resource://api', tokenB)
    expect(cache.get('subject-a', 'resource://api')).toBe(tokenA)
    expect(cache.get('subject-b', 'resource://api')).toBe(tokenB)
    expect(cache.get('subject-a', 'resource://api')).not.toBe(tokenB)
  })

  it('does not cross resource identities for same subject', () => {
    const tokenR1 = makeToken(900)
    const tokenR2 = makeToken(900)
    cache.set('subject-a', 'resource://r1', tokenR1)
    cache.set('subject-a', 'resource://r2', tokenR2)
    expect(cache.get('subject-a', 'resource://r1')).toBe(tokenR1)
    expect(cache.get('subject-a', 'resource://r2')).toBe(tokenR2)
  })

  it('overwrites previous entry on re-set', () => {
    const first = makeToken(900)
    const second = makeToken(900)
    cache.set('subject-a', 'resource://api', first)
    cache.set('subject-a', 'resource://api', second)
    expect(cache.get('subject-a', 'resource://api')).toBe(second)
  })

  it('does not store raw subject tokens in cache keys', () => {
    const token = makeToken(900)
    cache.set('sensitive-subject-token', 'resource://api', token)
    const keys = [...(cache as unknown as { map: Map<string, unknown> }).map.keys()]
    expect(keys).toHaveLength(1)
    expect(keys[0]).not.toContain('sensitive-subject-token')
    expect(keys[0]).not.toContain('resource://api')
  })
})
