// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// caracalAuth Express middleware unit tests: missing token, invalid token, scope check.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Request, Response, NextFunction } from 'express'
import { InMemoryRevocationStore } from '../../../../../packages/revocation/ts/src/inmem.js'
import { caracalAuth } from '../../../../../packages/connectors/express/ts/src/middleware.js'

vi.mock('@caracalai/transport-mcp', async () => ({
  authenticate: vi.fn().mockResolvedValue({ ok: false, error: { code: 'invalid_token', description: 'Token validation failed' } }),
  extractBearer: (h: string | undefined) => h?.match(/^Bearer\s+(.+)$/i)?.[1].trim() ?? null,
}))

function makeMockRes(): Partial<Response> & { statusCode?: number; body?: unknown } {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {}
  res.status = vi.fn().mockReturnValue(res) as unknown as Response['status']
  res.json = vi.fn((body) => { res.body = body; return res }) as unknown as Response['json']
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
})
