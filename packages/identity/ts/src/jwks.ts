// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// JWKS cache for mandate signature verification.

import { createLocalJWKSet, type JWTVerifyGetKey } from 'jose'

interface JwksEntry {
  keySet: JWTVerifyGetKey
  fetchedAt: number
  revalidating?: Promise<JWTVerifyGetKey>
}

export interface JwksCacheOptions {
  ttlMs?: number
  fetchTimeoutMs?: number
  fetchImpl?: typeof fetch
}

export interface JwksCache {
  getKeySet: (issuer: string) => Promise<JWTVerifyGetKey>
  warm: (issuer: string) => Promise<void>
  clear: (issuer?: string) => void
}

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000
const DEFAULT_FETCH_TIMEOUT_MS = 5_000

export function createJwksCache(opts: JwksCacheOptions = {}): JwksCache {
  const ttlMs = opts.ttlMs ?? DEFAULT_CACHE_TTL_MS
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  const fetchImpl = opts.fetchImpl
  const cache = new Map<string, JwksEntry>()

  async function getKeySet(issuer: string): Promise<JWTVerifyGetKey> {
    const now = Date.now()
    const entry = cache.get(issuer)
    if (entry) {
      const age = now - entry.fetchedAt
      if (age < ttlMs) return entry.keySet
      if (!entry.revalidating) {
        entry.revalidating = fetchAndStore(issuer)
          .catch(() => entry.keySet)
          .finally(() => {
            const current = cache.get(issuer)
            if (current) current.revalidating = undefined
          })
      }
      return entry.keySet
    }
    return fetchAndStore(issuer)
  }

  async function fetchAndStore(issuer: string): Promise<JWTVerifyGetKey> {
    const url = `${issuer.replace(/\/$/, '')}/.well-known/jwks.json`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs)
    try {
      const res = await (fetchImpl ?? fetch)(url, { signal: controller.signal })
      if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`)
      const body = (await res.json()) as { keys: object[] }
      const keySet = createLocalJWKSet({ keys: body.keys } as Parameters<typeof createLocalJWKSet>[0])
      cache.set(issuer, { keySet, fetchedAt: Date.now() })
      return keySet
    } finally {
      clearTimeout(timeout)
    }
  }

  return {
    getKeySet,
    async warm(issuer: string): Promise<void> {
      await getKeySet(issuer)
    },
    clear(issuer?: string): void {
      if (issuer) {
        cache.delete(issuer)
        return
      }
      cache.clear()
    },
  }
}

const defaultCache = createJwksCache()

export async function getKeySet(issuer: string): Promise<JWTVerifyGetKey> {
  return defaultCache.getKeySet(issuer)
}

export async function warmJwks(issuer: string): Promise<void> {
  await defaultCache.warm(issuer)
}

export function clearJwksCache(issuer?: string): void {
  defaultCache.clear(issuer)
}
