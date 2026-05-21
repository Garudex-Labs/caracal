// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for JWT verify(), verifyChainContains(), and all identity error classes.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  verify,
  verifyChainContains,
  AgentIdentityRequiredError,
  DelegationRequiredError,
  HopCountExceededError,
  TokenInvalidError,
  ZoneInvalidError,
} from '../../../../packages/identity/ts/src/verify.js'

let issuerId = 0

async function mintToken(
  claims: Record<string, unknown> = {},
  scopes = 'read write',
): Promise<{ token: string; issuer: string }> {
  const issuer = `https://issuer-${++issuerId}.example.com`
  const key = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', key.publicKey)
  Object.assign(jwk, { kid: 'kid-1', alg: 'ES256', use: 'sig' })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })),
  )
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: 'kid-1', typ: 'JWT' }))
  const now = Math.floor(Date.now() / 1000)
  const payload = b64url(JSON.stringify({
    iss: issuer,
    aud: 'resource://api',
    sub: 'user-1',
    zone_id: 'zone-1',
      client_id: 'app-1',
      sid: 'sid-1',
      root_sid: 'root-1',
      use: 'per_call',
    jti: 'jti-1',
    scope: scopes,
    iat: now,
    exp: now + 300,
    ...claims,
  }))
  const body = `${header}.${payload}`
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key.privateKey,
    new TextEncoder().encode(body),
  )
  return { token: `${body}.${b64url(new Uint8Array(sig))}`, issuer }
}

function b64url(value: string | Uint8Array): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

describe('verify', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('accepts a valid token and returns all claims', async () => {
    const { token, issuer } = await mintToken({
      agent_session_id: 'agent-1',
      delegation_edge_id: 'edge-1',
      source_session_id: 'src-1',
      target_session_id: 'tgt-1',
      delegation_path: ['edge-0', 'edge-1'],
      delegation_chain: [{ application_id: 'app-parent', agent_session_id: 's1', delegation_edge_id: 'e1' }],
      hop_count: 2,
      delegation_graph_epoch: 7,
    })
    const claims = await verify(token, { issuer, audience: 'resource://api' })
    expect(claims.sub).toBe('user-1')
    expect(claims.zoneId).toBe('zone-1')
    expect(claims.clientId).toBe('app-1')
    expect(claims.sid).toBe('sid-1')
    expect(claims.rootSid).toBe('root-1')
    expect(claims.issuedAt).toBeGreaterThan(0)
    expect(claims.expiresAt).toBeGreaterThan(claims.issuedAt)
    expect(claims.agentSessionId).toBe('agent-1')
    expect(claims.delegationEdgeId).toBe('edge-1')
    expect(claims.sourceSessionId).toBe('src-1')
    expect(claims.targetSessionId).toBe('tgt-1')
    expect(claims.hopCount).toBe(2)
    expect(claims.graphEpoch).toBe(7)
    expect(claims.delegationPath).toEqual(['edge-0', 'edge-1'])
    expect(claims.delegationChain?.[0]).toMatchObject({ applicationId: 'app-parent', agentSessionId: 's1', delegationEdgeId: 'e1' })
  })

  it('throws TokenInvalidError for a malformed token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ keys: [] }) }))
    await expect(
      verify('not.a.jwt', { issuer: 'https://issuer.example.com', audience: 'resource://api' }),
    ).rejects.toBeInstanceOf(TokenInvalidError)
  })

  it('throws ZoneInvalidError when zone_id is absent', async () => {
    const { token, issuer } = await mintToken({ zone_id: undefined })
    await expect(verify(token, { issuer, audience: 'resource://api' })).rejects.toBeInstanceOf(ZoneInvalidError)
  })

  it('throws TokenInvalidError when exp is absent', async () => {
    const { token, issuer } = await mintToken({ exp: undefined })
    await expect(verify(token, { issuer, audience: 'resource://api' })).rejects.toBeInstanceOf(TokenInvalidError)
  })

  it('throws TokenInvalidError when sid is absent', async () => {
    const { token, issuer } = await mintToken({ sid: undefined })
    await expect(verify(token, { issuer, audience: 'resource://api' })).rejects.toBeInstanceOf(TokenInvalidError)
  })

  it('throws TokenInvalidError when required use does not match', async () => {
    const { token, issuer } = await mintToken({ use: 'ambient' })
    await expect(
      verify(token, { issuer, audience: 'resource://api', requiredUse: 'per_call' }),
    ).rejects.toBeInstanceOf(TokenInvalidError)
  })

  it('throws ZoneInvalidError when zone_id does not match config', async () => {
    const { token, issuer } = await mintToken()
    await expect(
      verify(token, { issuer, audience: 'resource://api', zoneId: 'zone-99' }),
    ).rejects.toBeInstanceOf(ZoneInvalidError)
  })

  it('throws ScopeInsufficientError for a missing required scope', async () => {
    const { token, issuer } = await mintToken({}, 'read')
    await expect(
      verify(token, { issuer, audience: 'resource://api', requiredScopes: ['admin'] }),
    ).rejects.toMatchObject({ name: 'ScopeInsufficientError', missingScope: 'admin' })
  })

  it('throws AgentIdentityRequiredError when agent is required but absent', async () => {
    const { token, issuer } = await mintToken()
    await expect(
      verify(token, { issuer, audience: 'resource://api', requireAgent: true }),
    ).rejects.toBeInstanceOf(AgentIdentityRequiredError)
  })

  it('throws DelegationRequiredError when delegation is required but absent', async () => {
    const { token, issuer } = await mintToken()
    await expect(
      verify(token, { issuer, audience: 'resource://api', requireDelegation: true }),
    ).rejects.toBeInstanceOf(DelegationRequiredError)
  })

  it('throws HopCountExceededError when hop_count exceeds the limit', async () => {
    const { token, issuer } = await mintToken({ hop_count: 5 })
    await expect(
      verify(token, { issuer, audience: 'resource://api', maxHopCount: 3 }),
    ).rejects.toBeInstanceOf(HopCountExceededError)
  })

  it('throws ChainMismatchError when required application is absent from the chain', async () => {
    const { token, issuer } = await mintToken({ delegation_chain: [{ application_id: 'app-child' }] })
    await expect(
      verify(token, { issuer, audience: 'resource://api', requireChainContains: ['app-parent'] }),
    ).rejects.toMatchObject({ name: 'ChainMismatchError', missingApplicationId: 'app-parent' })
  })

  it('rejects malformed delegation chain keys', async () => {
    const { token, issuer } = await mintToken({
      delegation_chain: [{ app: 'app-child', session: 's1', edge: 'e1' }],
    })
    await expect(
      verify(token, {
        issuer,
        audience: 'resource://api',
        requireChainContains: ['app-child'],
      }),
    ).rejects.toBeInstanceOf(TokenInvalidError)
  })

  it('rejects malformed agent claim types', async () => {
    const { token, issuer } = await mintToken({ agent_session_id: ['agent-1'] })
    await expect(
      verify(token, {
        issuer,
        audience: 'resource://api',
        requireAgent: true,
      }),
    ).rejects.toBeInstanceOf(TokenInvalidError)
  })

  it('ignores legacy graph_epoch claim', async () => {
    const { token, issuer } = await mintToken({ graph_epoch: 42 })
    const claims = await verify(token, { issuer, audience: 'resource://api' })
    expect(claims.graphEpoch).toBeUndefined()
  })
})

describe('verifyChainContains', () => {
  it('matches by clientId', () => {
    expect(verifyChainContains(
      { sub: '', zoneId: '', clientId: 'app-1', sid: '', use: 'per_call', jti: 'jti-1', scope: '' },
      'app-1',
    )).toBe(true)
  })

  it('matches by delegation chain hop', () => {
    expect(verifyChainContains(
      { sub: '', zoneId: '', clientId: 'other', sid: '', use: 'per_call', jti: 'jti-1', scope: '', delegationChain: [{ applicationId: 'app-parent' }] },
      'app-parent',
    )).toBe(true)
  })

  it('returns false when the application is absent', () => {
    expect(verifyChainContains(
      { sub: '', zoneId: '', clientId: 'app-1', sid: '', use: 'per_call', jti: 'jti-1', scope: '', delegationChain: [{ applicationId: 'app-parent' }] },
      'app-unknown',
    )).toBe(false)
  })
})
