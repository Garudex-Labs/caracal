// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Express middleware that validates Caracal JWTs at every MCP tool boundary.

import { jwtVerify } from 'jose'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { hasScope } from '@caracalai/shared'
import { getKeySet } from './jwks.js'
import type { RevocationStore } from './revocation.js'

export interface MiddlewareOptions {
  issuer: string
  audience: string
  zoneId?: string
  requiredScopes?: string[]
  revocations?: RevocationStore
}

export interface CaracalRequest extends Request {
  caracalClaims?: {
    sub: string
    zoneId: string
    sid: string
    scope: string
  }
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
    try {
      const keySet = await getKeySet(opts.issuer)
      const { payload } = await jwtVerify(token, keySet, {
        issuer: opts.issuer,
        audience: opts.audience,
      })

      const scope = (payload['scope'] as string | undefined) ?? ''
      const zoneId = payload['zone_id']
      if (typeof zoneId !== 'string' || zoneId === '' || (opts.zoneId && zoneId !== opts.zoneId)) {
        res.status(401).json({ error: 'invalid_token', error_description: 'Token zone validation failed' })
        return
      }
      for (const required of opts.requiredScopes ?? []) {
        if (!hasScope(scope, required)) {
          res.status(403).json({ error: 'insufficient_scope', error_description: `Missing scope: ${required}` })
          return
        }
      }

      const sid = typeof payload['sid'] === 'string' ? (payload['sid'] as string) : ''
      if (opts.revocations && sid && (await opts.revocations.isRevoked(sid))) {
        res.status(401).json({ error: 'invalid_token', error_description: 'Session revoked' })
        return
      }

      req.caracalClaims = { sub: payload.sub ?? '', zoneId, sid, scope }
      next()
    } catch {
      res.status(401).json({ error: 'invalid_token', error_description: 'Token validation failed' })
    }
  }
}
