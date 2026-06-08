// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// JTI replay cache: in-memory implementation for single-replica deployments; Redis-backed implementation for multi-replica deployments.

import type { Redis } from 'ioredis'

export interface Replay {
  mark(jti: string, expEpochSec: number | undefined): Promise<boolean>
  ping(): Promise<void>
}

interface MemoryEntry {
  keepUntilMonoMs: number
}

export class MemoryReplay implements Replay {
  private readonly seen = new Map<string, MemoryEntry>()
  private readonly ttlMs: number
  private readonly maxKeys = 100_000

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs
  }

  async mark(jti: string, expEpochSec: number | undefined): Promise<boolean> {
    if (!jti) return false
    const nowMono = performance.now()
    this.evict(nowMono)
    if (this.seen.has(jti)) return false
    if (this.seen.size >= this.maxKeys) {
      const oldest = this.seen.keys().next().value
      if (oldest !== undefined) this.seen.delete(oldest)
    }
    let ttlMs = this.ttlMs
    if (expEpochSec) {
      const delta = expEpochSec * 1000 - Date.now()
      if (delta <= 0) return false
      if (delta < ttlMs) ttlMs = delta
    }
    if (ttlMs <= 0) return false
    this.seen.set(jti, { keepUntilMonoMs: nowMono + ttlMs })
    return true
  }

  async ping(): Promise<void> {}

  private evict(now: number): void {
    for (const [k, e] of this.seen) {
      if (e.keepUntilMonoMs <= now) this.seen.delete(k)
    }
  }
}

const REDIS_KEY_PREFIX = 'caracal:control:jti:'

export class RedisReplay implements Replay {
  private readonly client: Redis
  private readonly maxTtlMs: number

  constructor(client: Redis, maxTtlMs: number) {
    this.client = client
    this.maxTtlMs = maxTtlMs
  }

  async mark(jti: string, expEpochSec: number | undefined): Promise<boolean> {
    if (!jti) return false
    const now = await this.redisNowMs()
    let ttlMs = this.maxTtlMs
    if (expEpochSec) {
      const delta = expEpochSec * 1000 - now
      if (delta <= 0) return false
      if (delta < ttlMs) ttlMs = delta
    }
    if (ttlMs <= 0) return false
    try {
      const res = await this.client.set(REDIS_KEY_PREFIX + jti, '1', 'PX', ttlMs, 'NX')
      return res === 'OK'
    } catch {
      // Fail closed: if Redis is unreachable we cannot prove non-replay.
      return false
    }
  }

  async ping(): Promise<void> {
    await this.client.ping()
  }

  private async redisNowMs(): Promise<number> {
    try {
      const parts = await this.client.time()
      const seconds = Number(parts[0])
      const micros = Number(parts[1])
      if (Number.isFinite(seconds) && Number.isFinite(micros)) {
        return seconds * 1000 + Math.floor(micros / 1000)
      }
    } catch {
      return Date.now()
    }
    return Date.now()
  }
}
