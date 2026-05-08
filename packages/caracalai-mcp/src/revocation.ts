// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Revocation store contract and in-memory implementation for resource servers
// that want to honor caracal.sessions.revoke without rolling their own cache.

export interface RevocationStore {
  isRevoked: (sid: string) => boolean | Promise<boolean>
  markRevoked: (sid: string, ttlMs?: number) => void
}

interface Entry {
  expiresAt: number
}

// InMemoryRevocationStore keeps a Set of revoked session ids with per-entry
// TTLs so memory stays bounded even when a feed publishes more revocations
// than the resource server expects. Resource servers populate it from their
// own caracal.sessions.revoke consumer; the middleware then denies any token
// whose sid is present.
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
    if (this.entries.size >= this.maxEntries) this.evictOldest()
    this.entries.set(sid, { expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs) })
  }

  size(): number {
    return this.entries.size
  }

  private evictOldest(): void {
    const it = this.entries.keys().next()
    if (!it.done) this.entries.delete(it.value)
  }
}
