// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// caracalAuth Express middleware unit tests: missing token, invalid token, scope check.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Request, Response, NextFunction } from 'express'
import { InMemoryRevocationStore } from '../../../../../packages/revocation/ts/src/inmem.js'
import { caracalAuth } from '../../../../../packages/connectors/express/ts/src/middleware.js'
import type { MandateVerifier } from '../../../../../packages/transport/mcp/ts/src/authenticate.js'
import { authenticate } from '@caracalai/transport-mcp'

vi.mock('@caracalai/transport-mcp', async () => ({
  authenticate: vi.fn().mockResolvedValue({ ok: false, error: { code: 'invalid_token', description: 'Token validation failed' } }),
  httpStatusForAuthError: (code: string) =>
    ['insufficient_scope', 'agent_required', 'delegation_required', 'chain_mismatch', 'hop_count_exceeded'].includes(code) ? 403 : 401,
  extractBearer: (h: string | undefined) => {
    if (h === undefined || h.slice(0, 6).toLowerCase() !== 'bearer') return null
    const value = h.slice(6)
    if (value.length === value.trimStart().length) return null
    const token = value.trim()
    return token === '' ? null : token
  },
}))

function makeMockRes(): Partial<Response> & { statusCode?: number; body?: unknown } {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {}
  res.status = vi.fn().mockReturnValue(res) as unknown as Response['status']
  res.json = vi.fn((body) => {
    res.body = body
    return res
  }) as unknown as Response['json']
  return res
}

describe('caracalAuth middleware', () => {
  const revocations = new InMemoryRevocationStore()

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects request with no Authorization header', async () => {
    const middleware = caracalAuth({ issuer: 'https://sts.zone1', audience: 'resource://api', revocations })
    const req = { headers: {} } as Request
    const res = makeMockRes()
    const next = vi.fn()
    await middleware(req, res as Response, next as unknown as NextFunction)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects request with non-Bearer scheme', async () => {
    const middleware = caracalAuth({ issuer: 'https://sts.zone1', audience: 'resource://api', revocations })
    const req = { headers: { authorization: 'Basic abc' } } as Request
    const res = makeMockRes()
    const next = vi.fn()
    await middleware(req, res as Response, next as unknown as NextFunction)
    expect(res.status).toHaveBeenCalledWith(401)
  })

  it('rejects invalid JWT', async () => {
    const middleware = caracalAuth({ issuer: 'https://sts.zone1', audience: 'resource://api', revocations })
    const req = { headers: { authorization: 'Bearer invalid.jwt.token' } } as Request
    const res = makeMockRes()
    const next = vi.fn()
    await middleware(req, res as Response, next as unknown as NextFunction)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('supports reusable verifier instances and attaches claims aliases', async () => {
    const verifier: MandateVerifier = {
      defaults: { issuer: 'https://sts.zone1', audience: 'resource://api', revocations },
      authenticate: vi.fn().mockResolvedValue({
        ok: true,
        principal: {
          sub: 'user-1',
          zoneId: 'zone-1',
          clientId: 'app-1',
          sid: 'sid-1',
          rootSid: 'root-1',
          use: 'resource',
          subType: 'user',
          jti: 'jti-1',
          issuedAt: 1,
          expiresAt: 2,
          scope: 'tickets:read',
        },
      }),
      authorization: vi.fn(),
      require: vi.fn(),
      warmup: vi.fn(),
    }
    const middleware = caracalAuth({ verifier, bindContext: false }, { requiredScopes: ['tickets:read'] })
    const req = { headers: { authorization: 'Bearer valid.jwt.token' } } as Request
    const res = makeMockRes()
    const next = vi.fn()

    await middleware(req, res as Response, next as unknown as NextFunction)

    expect(verifier.authenticate).toHaveBeenCalledWith('valid.jwt.token', { requiredScopes: ['tickets:read'] })
    expect((req as Request & { caracal?: { sub: string }; caracalClaims?: { sub: string } }).caracal?.sub).toBe('user-1')
    expect((req as Request & { caracal?: { sub: string }; caracalClaims?: { sub: string } }).caracalClaims?.sub).toBe('user-1')
    expect(next).toHaveBeenCalledOnce()
  })

  it('binds a Caracal context using route headers and middleware zone defaults', async () => {
    vi.mocked(authenticate).mockResolvedValueOnce({
      ok: true,
      principal: {
        sub: 'user-1',
        clientId: 'app-1',
        sid: 'sid-1',
        rootSid: 'root-1',
        use: 'resource',
        subType: 'user',
        jti: 'jti-1',
        issuedAt: 1,
        expiresAt: 2,
        scope: 'tickets:read',
      },
    })
    const middleware = caracalAuth({ issuer: 'https://sts.zone1', audience: 'resource://api', zoneId: 'zone-1', revocations })
    const req = {
      headers: {
        authorization: 'Bearer valid.jwt.token',
        baggage: 'caracal.agent_session=agent-header,caracal.delegation_edge=edge-header,caracal.parent_edge=parent-header,caracal.hop=3',
        traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
      },
    } as unknown as Request
    const res = makeMockRes()
    const next = vi.fn()

    await middleware(req, res as Response, next as unknown as NextFunction)

    expect(next).toHaveBeenCalledOnce()
    expect(
      (
        req as Request & {
          caracalContext?: { zoneId: string; agentSessionId: string; delegationEdgeId: string; parentEdgeId: string; hop: number }
        }
      ).caracalContext,
    ).toMatchObject({
      zoneId: 'zone-1',
      agentSessionId: 'agent-header',
      delegationEdgeId: 'edge-header',
      parentEdgeId: 'parent-header',
      hop: 3,
    })
  })

  it('maps insufficient scope and agent/delegation failures to forbidden responses', async () => {
    for (const code of ['insufficient_scope', 'agent_required', 'delegation_required', 'chain_mismatch', 'hop_count_exceeded'] as const) {
      const verifier: MandateVerifier = {
        defaults: { issuer: 'https://sts.zone1', audience: 'resource://api', revocations },
        authenticate: vi.fn().mockResolvedValue({
          ok: false,
          error: { code, description: `${code} description`, hint: 'request broader access' },
        }),
        authorization: vi.fn(),
        require: vi.fn(),
        warmup: vi.fn(),
      }
      const middleware = caracalAuth({ verifier })
      const req = { headers: { authorization: 'Bearer valid.jwt.token' } } as Request
      const res = makeMockRes()

      await middleware(req, res as Response, vi.fn() as unknown as NextFunction)

      expect(res.status).toHaveBeenCalledWith(403)
      expect(res.body).toMatchObject({ error: code, error_description: `${code} description`, error_hint: 'request broader access' })
    }
  })
})
