// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for Control API bearer-token authentication.

import { describe, expect, it } from 'vitest'
import { Authenticator } from '../../../../apps/control/src/auth.js'

type KeySetLoader = { keySet(zoneId: string, force: boolean): Promise<unknown> }

describe('control auth', () => {
  it('refreshes JWKS immediately when verification requests a forced reload', async () => {
    let calls = 0
    const auth = new Authenticator({
      jwksUrl: 'http://sts:8080/.well-known/jwks.json',
      issuer: 'http://sts:8080',
      audience: 'caracal-control',
      refreshFloorMs: 30_000,
      fetchImpl: async () => {
        calls++
        return new Response(JSON.stringify({ keys: [] }), { status: 200 })
      },
    }) as Authenticator & KeySetLoader

    await auth.keySet('zone-1', false)
    await auth.keySet('zone-1', false)
    expect(calls).toBe(1)
    await auth.keySet('zone-1', true)
    expect(calls).toBe(2)
  })

  it('serves stale JWKS only within the max-stale window', async () => {
    let calls = 0
    const auth = new Authenticator({
      jwksUrl: 'http://sts:8080/.well-known/jwks.json',
      issuer: 'http://sts:8080',
      audience: 'caracal-control',
      jwksTtlMs: 0,
      maxStaleMs: 10,
      fetchImpl: async () => {
        calls++
        if (calls === 1) return new Response(JSON.stringify({ keys: [] }), { status: 200 })
        return new Response('unavailable', { status: 503 })
      },
    }) as Authenticator & KeySetLoader

    await auth.keySet('zone-1', false)
    await auth.keySet('zone-1', false)
    await new Promise((resolve) => setTimeout(resolve, 15))
    await expect(auth.keySet('zone-1', false)).rejects.toThrow('jwks status 503')
  })
})
