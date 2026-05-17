// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Transport MCP authentication unit tests.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authenticate, extractBearer } from '../../../../packages/transport/mcp/ts/src/authenticate.js'

const revocations = {
  isRevoked: vi.fn(),
  markRevoked: vi.fn(),
}

let issuerId = 0
const jwksByIssuer = new Map<string, JsonWebKey>()

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const issuer = url.replace(/\/\.well-known\/jwks\.json$/, '')
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
  }))
})

async function mintToken(
  claims: Record<string, unknown> = {},
  scopes = 'mcp:call',
): Promise<{ token: string; issuer: string; audience: string }> {
  const issuer = `https://issuer-${++issuerId}.example.com`
  const audience = 'resource://api'
  const key = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', key.publicKey)
  Object.assign(jwk, { kid: 'kid-1', alg: 'ES256', use: 'sig' })
  jwksByIssuer.set(issuer, jwk)
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: 'kid-1', typ: 'JWT' }))
  const payload = base64url(JSON.stringify({
    iss: issuer,
    aud: audience,
    sub: 'user-1',
    zone_id: 'zone-1',
    client_id: 'app-1',
    sid: 'sid-1',
    use: 'per_call',
    jti: 'jti-1',
    scope: scopes,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    ...claims,
  }))
  const body = `${header}.${payload}`
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key.privateKey,
    new TextEncoder().encode(body),
  )
  const token = `${body}.${base64url(new Uint8Array(signature))}`
  return { token, issuer, audience }
}

function base64url(value: string | Uint8Array): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

describe('transport-mcp authentication', () => {
  afterEach(() => {
    revocations.isRevoked.mockReset()
    revocations.markRevoked.mockReset()
    jwksByIssuer.clear()
    vi.unstubAllGlobals()
  })

  it('extracts bearer tokens', () => {
    expect(extractBearer('Bearer token-1')).toBe('token-1')
    expect(extractBearer('bearer token-1')).toBe('token-1')
    expect(extractBearer('BEARER token-1')).toBe('token-1')
    expect(extractBearer(`Bearer\t token-1  `)).toBe('token-1')
    expect(extractBearer('Bearer   ')).toBeNull()
    expect(extractBearer(undefined)).toBeNull()
  })

  it('extracts bearer tokens from long whitespace headers in linear time', () => {
    expect(extractBearer(`Bearer ${' '.repeat(100_000)}token-1`)).toBe('token-1')
    expect(extractBearer(`Bearer ${' '.repeat(100_000)}`)).toBeNull()
  })

  it('rejects missing tokens without verification', async () => {
    const result = await authenticate('', {
      issuer: 'https://issuer.example.com',
      audience: 'resource://api',
      revocations,
    })
    expect(result).toEqual({
      ok: false,
      error: { code: 'missing_token', description: 'Missing bearer token' },
    })
    expect(revocations.isRevoked).not.toHaveBeenCalled()
  })

  it('returns the verified principal and checks session revocation', async () => {
    const { token, issuer, audience } = await mintToken({
      agent_session_id: 'agent-1',
      delegation_edge_id: 'edge-1',
      delegation_chain: [{ application_id: 'app-parent' }],
      hop_count: 2,
    })
    revocations.isRevoked.mockResolvedValue(false)

    const result = await authenticate(token, {
      issuer,
      audience,
      zoneId: 'zone-1',
      requiredScopes: ['mcp:call'],
      requireAgent: true,
      requireDelegation: true,
      requireChainContains: ['app-parent'],
      maxHopCount: 4,
      revocations,
    })

    expect(result).toMatchObject({
      ok: true,
      principal: {
        sub: 'user-1',
        zoneId: 'zone-1',
        clientId: 'app-1',
        sid: 'sid-1',
        scope: 'mcp:call',
        agentSessionId: 'agent-1',
        delegationEdgeId: 'edge-1',
        hopCount: 2,
      },
    })
    expect(revocations.isRevoked).toHaveBeenCalledWith('sid-1')
  })

  it('authenticates tokens from multiple issuers minted in one test', async () => {
    const first = await mintToken({ sid: 'sid-1' })
    const second = await mintToken({ sid: 'sid-2' })
    revocations.isRevoked.mockResolvedValue(false)

    await expect(authenticate(first.token, {
      issuer: first.issuer,
      audience: first.audience,
      revocations,
    })).resolves.toMatchObject({ ok: true, principal: { sid: 'sid-1' } })
    await expect(authenticate(second.token, {
      issuer: second.issuer,
      audience: second.audience,
      revocations,
    })).resolves.toMatchObject({ ok: true, principal: { sid: 'sid-2' } })
  })

  it('rejects revoked sessions after successful verification', async () => {
    const { token, issuer, audience } = await mintToken()
    revocations.isRevoked.mockResolvedValue(true)

    await expect(authenticate(token, {
      issuer,
      audience,
      revocations,
    })).resolves.toEqual({
      ok: false,
      error: { code: 'session_revoked', description: 'Session revoked' },
    })
  })

  it.each([
    ['missing required scope', { requiredScopes: ['admin:call'] }, {}, 'insufficient_scope', 'Missing scope: admin:call'],
    ['agent identity required', { requireAgent: true }, {}, 'agent_required', 'Agent identity required'],
    ['delegation required', { requireDelegation: true }, {}, 'delegation_required', 'Delegation required'],
    ['delegation chain mismatch', { requireChainContains: ['app-parent'] }, { delegation_chain: [{ application_id: 'app-child' }] }, 'chain_mismatch', 'Delegation chain missing application: app-parent'],
    ['hop count exceeded', { maxHopCount: 1 }, { hop_count: 2 }, 'hop_count_exceeded', 'Hop count exceeded'],
    ['invalid zone', { zoneId: 'zone-2' }, {}, 'invalid_zone', 'Token zone validation failed'],
  ])('maps identity verification failure: %s', async (_label, deps, claims, code, description) => {
    const { token, issuer, audience } = await mintToken(claims)

    await expect(authenticate(token, {
      issuer,
      audience,
      revocations,
      ...deps,
    })).resolves.toEqual({
      ok: false,
      error: { code, description },
    })
  })

  it('maps malformed tokens to invalid_token', async () => {
    await expect(authenticate('invalid.jwt.token', {
      issuer: 'https://issuer.example.com',
      audience: 'resource://api',
      revocations,
    })).resolves.toEqual({
      ok: false,
      error: { code: 'invalid_token', description: 'Token validation failed' },
    })
  })
})
