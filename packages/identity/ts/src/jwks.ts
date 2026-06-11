// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// JWKS cache for mandate signature verification.

import { createLocalJWKSet, type JWTVerifyGetKey } from 'jose'

interface JwksEntry {
  keySet: JWTVerifyGetKey
  fetchedAtMonoMs: number
  revalidating?: Promise<JWTVerifyGetKey>
}

export interface JwksCacheOptions {
  ttlMs?: number
  maxStaleMs?: number
  fetchTimeoutMs?: number
  fetchImpl?: typeof fetch
}

export interface JwksCache {
  getKeySet: (issuer: string) => Promise<JWTVerifyGetKey>
  warm: (issuer: string) => Promise<void>
  clear: (issuer?: string) => void
}

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000
const DEFAULT_MAX_STALE_MS = 10 * 60 * 1000
const DEFAULT_FETCH_TIMEOUT_MS = 5_000

function assertSecureIssuer(issuer: string): void {
  const parsed = new URL(issuer)
  if (parsed.protocol === 'https:') return
  if (parsed.protocol === 'http:') {
    const insecureAllowed =
      isLoopbackHost(parsed.hostname) ||
      (process.env.NODE_ENV ?? 'development') === 'development' ||
      process.env.CARACAL_ALLOW_INSECURE_CONFIG_URLS === 'true'
    if (insecureAllowed) return
    throw new Error('insecure issuer scheme: http requires a loopback host or development mode')
  }
  throw new Error(`unsupported issuer scheme: ${parsed.protocol}`)
}

function isLoopbackHost(host: string): boolean {
  if (host === 'localhost') return true
  if (host === '::1' || host === '[::1]') return true
  return /^127(?:\.\d{1,3}){3}$/.test(host)
}

export function createJwksCache(opts: JwksCacheOptions = {}): JwksCache {
  const ttlMs = opts.ttlMs ?? DEFAULT_CACHE_TTL_MS
  const maxStaleMs = Math.max(opts.maxStaleMs ?? DEFAULT_MAX_STALE_MS, ttlMs)
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  const fetchImpl = opts.fetchImpl
  const cache = new Map<string, JwksEntry>()

  async function getKeySet(issuer: string): Promise<JWTVerifyGetKey> {
    const now = performance.now()
    const entry = cache.get(issuer)
    if (entry) {
      const age = now - entry.fetchedAtMonoMs
      if (age < ttlMs) return entry.keySet
      if (age > maxStaleMs) return fetchAndStore(issuer)
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
    assertSecureIssuer(issuer)
    const url = `${issuer.replace(/\/$/, '')}/.well-known/jwks.json`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs)
    try {
      const res = await (fetchImpl ?? fetch)(url, { signal: controller.signal })
      if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`)
      const body = (await res.json()) as { keys: object[] }
      const keySet = createLocalJWKSet({ keys: body.keys } as Parameters<typeof createLocalJWKSet>[0])
      cache.set(issuer, { keySet, fetchedAtMonoMs: performance.now() })
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
