// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// TypeScript identity JWKS cache unit tests for fetch and cache behavior.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearJwksCache, createJwksCache, getKeySet } from '../../../../packages/identity/ts/src/jwks.js'

const TTL_MS = 5 * 60 * 1000

describe('getKeySet', () => {
  afterEach(() => {
    clearJwksCache()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('fetches zone-scoped JWKS from the issuer well-known endpoint', async () => {
    const issuer = 'https://issuer-one.example/'
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ keys: [] }) })
    vi.stubGlobal('fetch', fetchMock)

    const keySet = await getKeySet(issuer, 'zone1')

    expect(typeof keySet).toBe('function')
    expect(fetchMock).toHaveBeenCalledWith('https://issuer-one.example/.well-known/jwks.json?zone_id=zone1', {
      signal: expect.any(AbortSignal),
    })
  })

  it('reuses cached key sets for the same issuer and zone', async () => {
    const issuer = 'https://issuer-two.example'
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ keys: [] }) })
    vi.stubGlobal('fetch', fetchMock)

    const first = await getKeySet(issuer, 'zone1')
    const second = await getKeySet(issuer, 'zone1')

    expect(first).toBe(second)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('restricts http issuers to loopback hosts or the explicit override', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ keys: [] }) })
    vi.stubGlobal('fetch', fetchMock)

    await expect(getKeySet('http://sts.internal:8080', 'zone1')).rejects.toThrow('insecure issuer scheme')
    await expect(getKeySet('http://127.0.0.1:8080', 'zone1')).resolves.toBeTypeOf('function')

    vi.stubEnv('CARACAL_ALLOW_INSECURE_CONFIG_URLS', 'true')
    await expect(getKeySet('http://sts.internal:8080', 'zone1')).resolves.toBeTypeOf('function')
  })

  it('rejects key set lookups without a zone', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(getKeySet('https://issuer-nozone.example', '')).rejects.toThrow('zone_id required')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('caches key sets per zone', async () => {
    const issuer = 'https://issuer-zones.example'
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ keys: [] }) })
    vi.stubGlobal('fetch', fetchMock)

    await getKeySet(issuer, 'zone1')
    await getKeySet(issuer, 'zone2')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledWith('https://issuer-zones.example/.well-known/jwks.json?zone_id=zone2', {
      signal: expect.any(AbortSignal),
    })
  })

  it('rejects failed JWKS fetches', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))

    await expect(getKeySet('https://issuer-three.example', 'zone1')).rejects.toThrow('JWKS fetch failed: 503')
  })

  it('returns stale key set and triggers background revalidation after TTL', async () => {
    vi.useFakeTimers()
    const issuer = 'https://issuer-stale.example'
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ keys: [] }) })
    vi.stubGlobal('fetch', fetchMock)

    const stale = await getKeySet(issuer, 'zone1')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(TTL_MS + 1)

    const returned = await getKeySet(issuer, 'zone1')
    expect(returned).toBe(stale)

    await vi.runAllTimersAsync()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('resets revalidating flag when background refresh fails', async () => {
    vi.useFakeTimers()
    const issuer = 'https://issuer-stale-fail.example'
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ keys: [] }) })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ keys: [] }) })
    vi.stubGlobal('fetch', fetchMock)

    await getKeySet(issuer, 'zone1')

    vi.advanceTimersByTime(TTL_MS + 1)
    await getKeySet(issuer, 'zone1')
    await vi.runAllTimersAsync()

    vi.advanceTimersByTime(TTL_MS + 1)
    await getKeySet(issuer, 'zone1')
    await vi.runAllTimersAsync()

    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('fails closed when cached keys exceed max stale', async () => {
    const issuer = 'https://issuer-max-stale.example'
    let calls = 0
    const cache = createJwksCache({
      ttlMs: 0,
      maxStaleMs: 10,
      fetchImpl: async () => {
        calls++
        if (calls === 1) return new Response(JSON.stringify({ keys: [] }), { status: 200 })
        return new Response('unavailable', { status: 503 })
      },
    })

    await cache.getKeySet(issuer, 'zone1')
    await cache.getKeySet(issuer, 'zone1')
    await new Promise((resolve) => setTimeout(resolve, 15))
    await expect(cache.getKeySet(issuer, 'zone1')).rejects.toThrow('JWKS fetch failed: 503')
  })
})
