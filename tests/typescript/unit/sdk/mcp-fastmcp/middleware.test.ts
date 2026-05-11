// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// FastMCP authentication adaptor unit tests.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FastMcpAuthError,
  verifyFastMcpToken,
} from '../../../../../packages/connectors/fastmcp/ts/src/middleware.js'

const revocations = {
  isRevoked: vi.fn(),
  markRevoked: vi.fn(),
}

let issuerId = 0

async function mintToken(claims: Record<string, unknown> = {}): Promise<{ token: string; issuer: string; audience: string }> {
  const issuer = `https://fastmcp-issuer-${++issuerId}.example.com`
  const audience = 'resource://mcp'
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
    scope: 'tool:call',
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
  return { token: `${body}.${base64url(new Uint8Array(signature))}`, issuer, audience }
}

function base64url(value: string | Uint8Array): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

describe('verifyFastMcpToken', () => {
  afterEach(() => {
    revocations.isRevoked.mockReset()
    revocations.markRevoked.mockReset()
    vi.unstubAllGlobals()
  })

  it('returns the FastMCP context after transport verification succeeds', async () => {
    const { token, issuer, audience } = await mintToken({
      agent_session_id: 'agent-1',
      delegation_edge_id: 'edge-1',
      delegation_chain: [{ app: 'app-parent' }],
      hop_count: 2,
    })
    revocations.isRevoked.mockResolvedValue(false)

    await expect(verifyFastMcpToken(token, {
      issuer,
      audience,
      zoneId: 'zone-1',
      requiredScopes: ['tool:call'],
      revocations,
      requireAgent: true,
      requireDelegation: true,
      requireChainContains: ['app-parent'],
      maxHopCount: 3,
    })).resolves.toEqual({
      sub: 'user-1',
      zoneId: 'zone-1',
      scope: 'tool:call',
    })
    expect(revocations.isRevoked).toHaveBeenCalledWith('sid-1')
  })

  it('raises FastMcpAuthError with the transport error code', async () => {
    const { token, issuer, audience } = await mintToken({
      delegation_chain: [{ app: 'app-child' }],
    })

    await expect(verifyFastMcpToken(token, {
      issuer,
      audience,
      revocations,
      requireChainContains: ['app-parent'],
    })).rejects.toMatchObject({
      name: 'FastMcpAuthError',
      code: 'chain_mismatch',
      message: 'Delegation chain missing application: app-parent',
    } satisfies Partial<FastMcpAuthError>)
  })
})
