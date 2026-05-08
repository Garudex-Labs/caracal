// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the canonical OAuth scope parser shared across all TS callers.

import { describe, expect, it } from 'vitest'
import { hasScope, parseScope, scopesAllowed } from '../../../../packages/ts-shared/src/scope.js'

describe('parseScope', () => {
  it('returns empty array for null, undefined, or empty string', () => {
    expect(parseScope(null)).toEqual([])
    expect(parseScope(undefined)).toEqual([])
    expect(parseScope('')).toEqual([])
    expect(parseScope('   ')).toEqual([])
  })

  it('splits on any ASCII whitespace and drops empty tokens', () => {
    expect(parseScope('a b c')).toEqual(['a', 'b', 'c'])
    expect(parseScope('a  b   c')).toEqual(['a', 'b', 'c'])
    expect(parseScope('\ta\nb\rc ')).toEqual(['a', 'b', 'c'])
  })

  it('preserves order and deduplicates', () => {
    expect(parseScope('read write read admin write')).toEqual(['read', 'write', 'admin'])
  })

  it('does not match the empty token (regression: split(" ") bug)', () => {
    // The buggy form `'a  b'.split(' ')` yields ['a', '', 'b'] and naive
    // `.includes('')` returned true. The canonical parser drops empties so
    // hasScope('a b', '') is always false.
    expect(parseScope('a  b').includes('')).toBe(false)
  })
})

describe('hasScope', () => {
  it('matches a present scope', () => {
    expect(hasScope('read write', 'read')).toBe(true)
    expect(hasScope('read write', 'write')).toBe(true)
  })

  it('rejects a missing scope', () => {
    expect(hasScope('read', 'write')).toBe(false)
    expect(hasScope('', 'read')).toBe(false)
    expect(hasScope(null, 'read')).toBe(false)
  })

  it('treats empty required as a programming error and never matches', () => {
    expect(hasScope('read write', '')).toBe(false)
    expect(hasScope('a  b', '')).toBe(false)
  })

  it('does not match a scope as a substring of another', () => {
    expect(hasScope('readonly', 'read')).toBe(false)
  })
})

describe('scopesAllowed', () => {
  it('allows when every requested scope is available', () => {
    expect(scopesAllowed(['read'], ['read', 'write'])).toBe(true)
    expect(scopesAllowed(['read', 'write'], ['read', 'write', 'admin'])).toBe(true)
    expect(scopesAllowed([], ['read'])).toBe(true)
  })

  it('rejects when any requested scope is missing', () => {
    expect(scopesAllowed(['admin'], ['read', 'write'])).toBe(false)
    expect(scopesAllowed(['read', 'admin'], ['read', 'write'])).toBe(false)
  })
})
