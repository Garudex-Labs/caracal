// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Fetch-standard Request authentication and error Response unit tests.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authenticateRequest, unauthorizedResponse } from '../../../../packages/verify/ts/src/fetch.js'
import type { AuthDeps } from '../../../../packages/verify/ts/src/authenticate.js'

const revocations = {
  isRevoked: vi.fn(),
  markRevoked: vi.fn(),
  currentDelegationEpoch: vi.fn(),
  markDelegationEpoch: vi.fn(),
}

let issuerId = 0
const jwksByIssuer = new Map<string, JsonWebKey>()

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const issuer = url.replace(/\/\.well-known\/jwks\.json(\?.*)?$/, '')
      const jwk = jwksByIssuer.get(issuer)
      if (!jwk) {
        return new Response(JSON.stringify({ keys: [] }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
})

afterEach(() => {
  revocations.isRevoked.mockReset()
  revocations.currentDelegationEpoch.mockReset()
  jwksByIssuer.clear()
  vi.unstubAllGlobals()
})

async function mintToken(): Promise<{ token: string; deps: AuthDeps }> {
  const issuer = `https://issuer-fetch-${++issuerId}.example.com`
  const audience = 'resource://api'
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const jwk = await crypto.subtle.exportKey('jwk', key.publicKey)
  Object.assign(jwk, { kid: 'kid-1', alg: 'ES256', use: 'sig' })
  jwksByIssuer.set(issuer, jwk)
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: 'kid-1', typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({
      iss: issuer,
      aud: audience,
      sub: 'user-1',
      zone_id: 'zone-1',
      client_id: 'app-1',
      sid: 'sid-1',
      root_sid: 'root-1',
      use: 'resource',
      sub_type: 'user',
      jti: 'jti-1',
      scope: 'mcp:call',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    }),
  )
  const body = `${header}.${payload}`
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, new TextEncoder().encode(body))
  const token = `${body}.${base64url(new Uint8Array(signature))}`
  return { token, deps: { issuer, audience, zoneId: 'zone-1', revocations } }
}

function base64url(value: string | Uint8Array): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

describe('authenticateRequest', () => {
  it('rejects a request without an authorization header', async () => {
    const { deps } = await mintToken()
    const result = await authenticateRequest(new Request('https://api.pipernet.example/tools'), deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('missing_token')
  })

  it('rejects a non-bearer authorization header', async () => {
    const { deps } = await mintToken()
    const request = new Request('https://api.pipernet.example/tools', {
      headers: { authorization: 'Basic abc123' },
    })
    const result = await authenticateRequest(request, deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('missing_token')
  })

  it('accepts a valid bearer mandate', async () => {
    revocations.isRevoked.mockResolvedValue(false)
    revocations.currentDelegationEpoch.mockResolvedValue(null)
    const { token, deps } = await mintToken()
    const request = new Request('https://api.pipernet.example/tools', {
      headers: { authorization: `Bearer ${token}` },
    })
    const result = await authenticateRequest(request, deps)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.principal.sub).toBe('user-1')
  })

  it('rejects a tampered token', async () => {
    revocations.isRevoked.mockResolvedValue(false)
    revocations.currentDelegationEpoch.mockResolvedValue(null)
    const { token, deps } = await mintToken()
    const request = new Request('https://api.pipernet.example/tools', {
      headers: { authorization: `Bearer ${token}x` },
    })
    const result = await authenticateRequest(request, deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_token')
  })
})

describe('unauthorizedResponse', () => {
  it('renders 401 with the canonical JSON body', async () => {
    const response = unauthorizedResponse({ code: 'invalid_token', description: 'Token validation failed' })
    expect(response.status).toBe(401)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.json()).toEqual({
      error: 'invalid_token',
      error_description: 'Token validation failed',
    })
  })

  it('renders 403 for insufficient scope and includes the hint', async () => {
    const response = unauthorizedResponse({
      code: 'insufficient_scope',
      description: 'Required scope is missing',
      hint: 'Grant mcp:call to the application',
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: 'insufficient_scope',
      error_description: 'Required scope is missing',
      error_hint: 'Grant mcp:call to the application',
    })
  })
})
