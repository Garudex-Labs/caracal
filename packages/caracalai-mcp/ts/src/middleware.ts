// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Express middleware that validates Caracal JWTs at every MCP tool boundary.

import type { NextFunction, Request, RequestHandler, Response } from 'express'
import {
  ScopeInsufficientError,
  TokenInvalidError,
  ZoneInvalidError,
  verify,
  type Claims,
} from '@caracalai/identity'
import type { RevocationStore } from '@caracalai/revocation'

export interface MiddlewareOptions {
  issuer: string
  audience: string
  zoneId?: string
  requiredScopes?: string[]
  revocations: RevocationStore
}

export interface CaracalRequest extends Request {
  caracalClaims?: Claims
}

export function caracalAuth(opts: MiddlewareOptions): RequestHandler {
  return async (req: CaracalRequest, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers['authorization']
    if (!authHeader?.startsWith('Bearer ') || authHeader.length <= 7) {
      res.status(401).json({ error: 'invalid_token', error_description: 'Missing bearer token' })
      return
    }

    const token = authHeader.slice(7).trim()
    if (!token) {
      res.status(401).json({ error: 'invalid_token', error_description: 'Missing bearer token' })
      return
    }

    let claims: Claims
    try {
      claims = await verify(token, {
        issuer: opts.issuer,
        audience: opts.audience,
        zoneId: opts.zoneId,
        requiredScopes: opts.requiredScopes,
      })
    } catch (err) {
      if (err instanceof ScopeInsufficientError) {
        res.status(403).json({ error: 'insufficient_scope', error_description: (err as Error).message })
        return
      }
      if (err instanceof ZoneInvalidError) {
        res.status(401).json({ error: 'invalid_token', error_description: 'Token zone validation failed' })
        return
      }
      if (err instanceof TokenInvalidError) {
        res.status(401).json({ error: 'invalid_token', error_description: 'Token validation failed' })
        return
      }
      res.status(401).json({ error: 'invalid_token', error_description: 'Token validation failed' })
      return
    }

    if (claims.sid && (await opts.revocations.isRevoked(claims.sid))) {
      res.status(401).json({ error: 'invalid_token', error_description: 'Session revoked' })
      return
    }

    req.caracalClaims = claims
    next()
  }
}
