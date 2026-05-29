// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for per-subject token-bucket rate limiter.

import { describe, it, expect, vi } from 'vitest'
import { RateLimiter } from '../../../../apps/control/src/ratelimit.js'

describe('RateLimiter', () => {
  it('allows up to capacity then rejects', () => {
    const r = new RateLimiter(3, 60_000)
    expect(r.allow('s1')).toBe(true)
    expect(r.allow('s1')).toBe(true)
    expect(r.allow('s1')).toBe(true)
    expect(r.allow('s1')).toBe(false)
  })

  it('isolates buckets per subject', () => {
    const r = new RateLimiter(1, 60_000)
    expect(r.allow('a')).toBe(true)
    expect(r.allow('a')).toBe(false)
    expect(r.allow('b')).toBe(true)
  })

  it('rejects an empty subject', () => {
    const r = new RateLimiter(10, 60_000)
    expect(r.allow('')).toBe(false)
  })

  it('evicts idle buckets after ten windows of inactivity', () => {
    vi.useFakeTimers()
    try {
      const r = new RateLimiter(1, 1_000)
      expect(r.allow('s1')).toBe(true)
      expect(r.allow('s1')).toBe(false)
      vi.advanceTimersByTime(10_001)
      expect(r.allow('s1')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops the oldest bucket when the key ceiling is reached', () => {
    const r = new RateLimiter(5, 60_000)
    for (let i = 0; i < 10_000; i++) r.allow(`s${i}`)
    expect(r.allow('overflow')).toBe(true)
    expect(r.allow('overflow')).toBe(true)
  })
})
