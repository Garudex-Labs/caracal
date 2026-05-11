// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Transport MCP authentication unit tests.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { authenticate, extractBearer } from '../../../../packages/transport/mcp/ts/src/authenticate.js'

const revocations = {
  isRevoked: vi.fn(),
  markRevoked: vi.fn(),
}

let issuerId = 0

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
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })))
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: 'kid-1', typ: 'JWT' }))
  const payload = base64url(JSON.stringify({
    iss: issuer,
    aud: audience,
    sub: 'user-1',
    zone_id: 'zone-1',
    client_id: 'app-1',
    sid: 'sid-1',
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
    vi.unstubAllGlobals()
  })

  it('extracts bearer tokens', () => {
    expect(extractBearer('Bearer token-1')).toBe('token-1')
    expect(extractBearer('bearer token-1')).toBeNull()
    expect(extractBearer('Bearer   ')).toBeNull()
    expect(extractBearer(undefined)).toBeNull()
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
      delegation_chain: [{ app: 'app-parent' }],
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
    [{ requiredScopes: ['admin:call'] }, {}, 'insufficient_scope', 'Missing scope: admin:call'],
    [{ requireAgent: true }, {}, 'agent_required', 'Agent identity required'],
    [{ requireDelegation: true }, {}, 'delegation_required', 'Delegation required'],
    [{ requireChainContains: ['app-parent'] }, { delegation_chain: [{ app: 'app-child' }] }, 'chain_mismatch', 'Delegation chain missing application: app-parent'],
    [{ maxHopCount: 1 }, { hop_count: 2 }, 'hop_count_exceeded', 'Hop count exceeded'],
    [{ zoneId: 'zone-2' }, {}, 'invalid_zone', 'Token zone validation failed'],
  ])('maps identity verification failure to %s', async (deps, claims, code, description) => {
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
