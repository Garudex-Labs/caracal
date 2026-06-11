// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// In-memory RevocationStore with per-entry TTLs and bounded capacity.

import type { RevocationStore } from './iface.js'

interface Entry {
  expiresAtMonoMs: number
}

export class InMemoryRevocationStore implements RevocationStore {
  private readonly entries = new Map<string, Entry>()
  private readonly delegationEpochs = new Map<string, Entry & { epoch: number }>()
  private readonly defaultTtlMs: number
  private readonly maxEntries: number

  constructor(opts: { defaultTtlMs?: number; maxEntries?: number } = {}) {
    this.defaultTtlMs = opts.defaultTtlMs ?? 24 * 60 * 60 * 1000
    this.maxEntries = opts.maxEntries ?? 100_000
  }

  isRevoked(sid: string): boolean {
    const entry = this.entries.get(sid)
    if (!entry) return false
    if (entry.expiresAtMonoMs <= performance.now()) {
      this.entries.delete(sid)
      return false
    }
    return true
  }

  markRevoked(sid: string, ttlMs?: number): void {
    if (this.entries.size >= this.maxEntries) {
      this.reapExpired()
      if (this.entries.size >= this.maxEntries) throw new Error('Revocation store capacity exceeded')
    }
    this.entries.set(sid, { expiresAtMonoMs: performance.now() + (ttlMs ?? this.defaultTtlMs) })
  }

  currentDelegationEpoch(zoneId: string): number {
    const entry = this.delegationEpochs.get(zoneId)
    if (!entry) return 0
    if (entry.expiresAtMonoMs <= performance.now()) {
      this.delegationEpochs.delete(zoneId)
      return 0
    }
    return entry.epoch
  }

  markDelegationEpoch(zoneId: string, epoch: number, ttlMs?: number): void {
    const current = this.currentDelegationEpoch(zoneId)
    if (epoch <= current) return
    this.delegationEpochs.set(zoneId, {
      epoch,
      expiresAtMonoMs: performance.now() + (ttlMs ?? this.defaultTtlMs),
    })
  }

  size(): number {
    return this.entries.size
  }

  private reapExpired(): void {
    const now = performance.now()
    for (const [sid, entry] of this.entries) {
      if (entry.expiresAtMonoMs <= now) this.entries.delete(sid)
    }
  }

}
