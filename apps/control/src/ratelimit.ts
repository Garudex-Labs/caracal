// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Per-subject token-bucket limiter for the control invoke endpoint with idle-bucket eviction.

interface Bucket {
  tokens: number
  lastMs: number
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private readonly capacity: number
  private readonly windowMs: number
  private readonly idleMs: number
  private readonly maxKeys = 10_000

  constructor(capacity: number, windowMs: number) {
    this.capacity = capacity
    this.windowMs = windowMs
    this.idleMs = windowMs * 10
  }

  allow(subject: string): boolean {
    if (!subject) return false
    const now = performance.now()
    this.evict(now)
    const b = this.buckets.get(subject)
    if (!b) {
      if (this.buckets.size >= this.maxKeys) {
        const oldest = this.buckets.keys().next().value
        if (oldest !== undefined) this.buckets.delete(oldest)
      }
      this.buckets.set(subject, { tokens: this.capacity - 1, lastMs: now })
      return true
    }
    this.buckets.delete(subject)
    this.buckets.set(subject, b)
    const elapsed = Math.max(0, now - b.lastMs) / 1000
    const refill = elapsed * (this.capacity / (this.windowMs / 1000))
    b.tokens = Math.min(this.capacity, b.tokens + refill)
    b.lastMs = now
    if (b.tokens < 1) return false
    b.tokens -= 1
    return true
  }

  private evict(now: number): void {
    for (const [k, b] of this.buckets) {
      if (now - b.lastMs > this.idleMs) this.buckets.delete(k)
    }
  }
}
