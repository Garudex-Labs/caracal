// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// In-memory RevocationStore with per-entry TTLs and bounded capacity.

import type { RevocationStore } from './iface.js'

interface Entry {
  expiresAt: number
}

export class InMemoryRevocationStore implements RevocationStore {
  private readonly entries = new Map<string, Entry>()
  private readonly defaultTtlMs: number
  private readonly maxEntries: number

  constructor(opts: { defaultTtlMs?: number; maxEntries?: number } = {}) {
    this.defaultTtlMs = opts.defaultTtlMs ?? 24 * 60 * 60 * 1000
    this.maxEntries = opts.maxEntries ?? 100_000
  }

  isRevoked(sid: string): boolean {
    const entry = this.entries.get(sid)
    if (!entry) return false
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(sid)
      return false
    }
    return true
  }

  markRevoked(sid: string, ttlMs?: number): void {
    if (this.entries.size >= this.maxEntries) {
      this.reapExpired()
      if (this.entries.size >= this.maxEntries) this.evictOldest()
    }
    this.entries.set(sid, { expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs) })
  }

  size(): number {
    return this.entries.size
  }

  private reapExpired(): void {
    const now = Date.now()
    for (const [sid, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(sid)
    }
  }

  private evictOldest(): void {
    const it = this.entries.keys().next()
    if (!it.done) this.entries.delete(it.value)
  }
}
