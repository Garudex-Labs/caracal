// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for Control bearer-token verification: signature checks, zone validation, JWKS refresh, and claim extraction.

import { describe, expect, it } from 'vitest'
import { Authenticator, AuthError } from '../../../../../apps/api/src/control/auth.js'

const ISSUER = 'http://sts:8080'
const AUDIENCE = 'caracal-control'

interface Minted {
  token: string
  jwk: Record<string, unknown>
}

async function mint(
  payloadOverrides: Record<string, unknown> = {},
  opts: { kid?: string; alg?: string } = {},
): Promise<Minted> {
  const kid = opts.kid ?? 'kid-1'
  const key = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  const jwk = (await crypto.subtle.exportKey('jwk', key.publicKey)) as Record<string, unknown>
  Object.assign(jwk, { kid, alg: opts.alg ?? 'ES256', use: 'sig' })

  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'ES256', kid, typ: 'JWT' }))
  const payload = b64url(JSON.stringify({
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'user-1',
    jti: 'jti-1',
    zone_id: 'zone-1',
    client_id: 'app-1',
    scope: 'agent:lifecycle',
    iat: now,
    exp: now + 300,
    ...payloadOverrides,
  }))
  const body = `${header}.${payload}`
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key.privateKey,
    new TextEncoder().encode(body),
  )
  return { token: `${body}.${b64url(new Uint8Array(sig))}`, jwk }
}

function b64url(value: string | Uint8Array): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function jwksResponse(keys: object[]): () => Promise<Response> {
  return async () => new Response(JSON.stringify({ keys }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function authWith(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}): Authenticator {
  return new Authenticator({
    jwksUrl: 'http://sts:8080/.well-known/jwks.json',
    issuer: ISSUER,
    audience: AUDIENCE,
    fetchImpl,
    ...overrides,
  })
}

describe('Authenticator.verify happy path', () => {
  it('returns claims for a valid token', async () => {
    const { token, jwk } = await mint()
    const auth = authWith(jwksResponse([jwk]) as unknown as typeof fetch)
    const claims = await auth.verify(`Bearer ${token}`)
    expect(claims).toMatchObject({
      sub: 'user-1',
      jti: 'jti-1',
      zoneId: 'zone-1',
      clientId: 'app-1',
      scope: 'agent:lifecycle',
    })
    expect(typeof claims.exp).toBe('number')
  })

  it('defaults missing optional claims to empty strings', async () => {
    const { token, jwk } = await mint({ client_id: undefined, scope: undefined })
    const auth = authWith(jwksResponse([jwk]) as unknown as typeof fetch)
    const claims = await auth.verify(`Bearer ${token}`)
    expect(claims.clientId).toBe('')
    expect(claims.scope).toBe('')
  })
})

describe('Authenticator.verify header and zone validation', () => {
  it('rejects a missing authorization header', async () => {
    const auth = authWith(jwksResponse([]) as unknown as typeof fetch)
    await expect(auth.verify(undefined)).rejects.toBeInstanceOf(AuthError)
  })

  it('rejects a non-bearer scheme', async () => {
    const auth = authWith(jwksResponse([]) as unknown as typeof fetch)
    await expect(auth.verify('Basic abc')).rejects.toThrow(/bearer/)
  })

  it('rejects an empty bearer token', async () => {
    const auth = authWith(jwksResponse([]) as unknown as typeof fetch)
    await expect(auth.verify('Bearer    ')).rejects.toThrow(/bearer/)
  })

  it('rejects a token that is not three segments', async () => {
    const auth = authWith(jwksResponse([]) as unknown as typeof fetch)
    await expect(auth.verify('Bearer a.b')).rejects.toThrow(/malformed/)
  })

  it('rejects a token whose payload is not valid base64 JSON', async () => {
    const auth = authWith(jwksResponse([]) as unknown as typeof fetch)
    await expect(auth.verify('Bearer aaa.!!!.ccc')).rejects.toThrow(/malformed token payload/)
  })

  it('rejects a token with no zone_id', async () => {
    const { token, jwk } = await mint({ zone_id: undefined })
    const auth = authWith(jwksResponse([jwk]) as unknown as typeof fetch)
    await expect(auth.verify(`Bearer ${token}`)).rejects.toThrow(/missing zone_id/)
  })

  it('rejects a syntactically invalid zone_id', async () => {
    const { token, jwk } = await mint({ zone_id: 'bad zone!' })
    const auth = authWith(jwksResponse([jwk]) as unknown as typeof fetch)
    await expect(auth.verify(`Bearer ${token}`)).rejects.toThrow(/invalid zone_id/)
  })
})

describe('Authenticator.verify signature and JWKS handling', () => {
  it('rejects when the JWKS endpoint returns a non-200', async () => {
    const { token } = await mint()
    const fetchImpl = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
    const auth = authWith(fetchImpl)
    await expect(auth.verify(`Bearer ${token}`)).rejects.toThrow(/jwks status 503/)
  })

  it('rejects when the JWKS body is malformed', async () => {
    const { token } = await mint()
    const fetchImpl = (async () => new Response(JSON.stringify({ keys: 'oops' }), { status: 200 })) as unknown as typeof fetch
    const auth = authWith(fetchImpl)
    await expect(auth.verify(`Bearer ${token}`)).rejects.toThrow(/jwks: malformed/)
  })

  it('rejects a token signed by a key absent from the JWKS', async () => {
    const { token } = await mint()
    const { jwk: otherJwk } = await mint({}, { kid: 'kid-1' })
    const auth = authWith(jwksResponse([otherJwk]) as unknown as typeof fetch)
    await expect(auth.verify(`Bearer ${token}`)).rejects.toThrow(/invalid token/)
  })

  it('forces a JWKS refresh when the first key set misses the kid', async () => {
    const { token, jwk } = await mint({}, { kid: 'kid-2' })
    let call = 0
    const fetchImpl = (async () => {
      call += 1
      const keys = call === 1 ? [{ ...jwk, kid: 'stale' }] : [jwk]
      return new Response(JSON.stringify({ keys }), { status: 200 })
    }) as unknown as typeof fetch
    const auth = authWith(fetchImpl)
    const claims = await auth.verify(`Bearer ${token}`)
    expect(claims.zoneId).toBe('zone-1')
    expect(call).toBe(2)
  })

  it('rejects when even the refreshed key set cannot verify the token', async () => {
    const { token, jwk } = await mint({}, { kid: 'kid-2' })
    const fetchImpl = (async () => new Response(
      JSON.stringify({ keys: [{ ...jwk, kid: 'stale' }] }),
      { status: 200 },
    )) as unknown as typeof fetch
    const auth = authWith(fetchImpl)
    await expect(auth.verify(`Bearer ${token}`)).rejects.toThrow(/invalid token/)
  })
})

describe('Authenticator zone cache eviction', () => {
  it('evicts the oldest zone once maxZones is exceeded', async () => {
    const a = await mint({ zone_id: 'zone-a' })
    const b = await mint({ zone_id: 'zone-b' })
    const byZone: Record<string, object> = { 'zone-a': a.jwk, 'zone-b': b.jwk }
    let calls = 0
    const fetchImpl = (async (url: string) => {
      calls += 1
      const zone = new URL(url).searchParams.get('zone_id') ?? ''
      return new Response(JSON.stringify({ keys: [byZone[zone]] }), { status: 200 })
    }) as unknown as typeof fetch
    const auth = authWith(fetchImpl, { maxZones: 1 })

    await auth.verify(`Bearer ${a.token}`)
    await auth.verify(`Bearer ${b.token}`)
    await auth.verify(`Bearer ${a.token}`)
    expect(calls).toBe(3)
  })
})

describe('Authenticator negative cache', () => {
  it('serves unknown-zone from the negative cache without re-fetching', async () => {
    const { token } = await mint({ zone_id: 'zone-x' })
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      throw new Error('network down')
    }) as unknown as typeof fetch
    const auth = authWith(fetchImpl, { negativeTtlMs: 60_000 })
    await expect(auth.verify(`Bearer ${token}`)).rejects.toThrow()
    await expect(auth.verify(`Bearer ${token}`)).rejects.toThrow(/unknown zone/)
    expect(calls).toBe(1)
  })
})
