// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// JWT bearer verification against STS JWKS endpoint.

import { createRemoteJWKSet, decodeJwt, jwtVerify, errors as joseErrors } from 'jose'
import type { FastifyRequest, FastifyReply } from 'fastify'
import { cfg } from './config.js'

// Per-zone JWKS resolvers. STS exposes one signing keyset per zone so a single
// document never reveals every zone's keys; callers must pass ?zone_id=. Each
// resolver enforces a hard cacheMaxAge so a sustained STS outage fails closed
// instead of accepting tokens against indefinitely stale keys.
const jwksByZone = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

function jwksForZone(zoneId: string): ReturnType<typeof createRemoteJWKSet> {
  let resolver = jwksByZone.get(zoneId)
  if (resolver) return resolver
  const url = new URL(`${cfg.stsUrl}/.well-known/jwks.json`)
  url.searchParams.set('zone_id', zoneId)
  resolver = createRemoteJWKSet(url, {
    cooldownDuration: 30_000,
    cacheMaxAge: 600_000,
    timeoutDuration: 5_000,
  })
  jwksByZone.set(zoneId, resolver)
  return resolver
}

declare module 'fastify' {
  interface FastifyRequest {
    caracalAuth?: {
      zoneId: string
      scopes: string[]
      subject: string
    }
  }
}

const PUBLIC_PATHS = new Set(['/health'])

function classifyError(err: unknown): string {
  if (err instanceof joseErrors.JWTExpired) return 'token_expired'
  if (err instanceof joseErrors.JWTClaimValidationFailed) return 'claim_invalid'
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) return 'signature_invalid'
  if (err instanceof joseErrors.JOSEAlgNotAllowed) return 'algorithm_not_allowed'
  if (err instanceof joseErrors.JWKSNoMatchingKey) return 'jwks_no_matching_key'
  if (err instanceof joseErrors.JWKSTimeout) return 'jwks_timeout'
  if (err instanceof joseErrors.JOSEError) return 'jose_error'
  return 'unknown_error'
}

function pathOnly(url: string): string {
  const q = url.indexOf('?')
  return q === -1 ? url : url.slice(0, q)
}

export async function verifyBearer(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const path = pathOnly(req.url)
  if (PUBLIC_PATHS.has(path)) return

  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'missing_token' })
    return
  }
  const token = auth.slice(7).trim()
  if (!token) {
    reply.code(401).send({ error: 'missing_token' })
    return
  }
  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload']
  try {
    const claims = decodeJwt(token)
    const tokenZone = claims['zone_id']
    if (typeof tokenZone !== 'string' || tokenZone === '') {
      reply.code(401).send({ error: 'invalid_token' })
      return
    }
    const verified = await jwtVerify(token, jwksForZone(tokenZone), {
      issuer: cfg.issuerUrl,
      audience: cfg.audience,
      algorithms: ['ES256'],
    })
    payload = verified.payload
  } catch (err) {
    req.log.warn({ errorClass: classifyError(err) }, 'jwt_verify_failed')
    reply.code(401).send({ error: 'invalid_token' })
    return
  }

  const scopes = typeof payload.scope === 'string' ? payload.scope.split(/\s+/) : []
  if (!scopes.includes(cfg.requiredScope)) {
    reply.code(403).send({ error: 'missing_scope' })
    return
  }
  const zoneId = payload['zone_id']
  const subject = payload.sub
  if (typeof zoneId !== 'string' || zoneId === '') {
    req.log.warn('jwt_missing_zone_claim')
    reply.code(401).send({ error: 'invalid_token' })
    return
  }
  if (typeof subject !== 'string' || subject === '') {
    reply.code(401).send({ error: 'invalid_token' })
    return
  }

  const params = req.params as { zoneId?: string } | undefined
  if (params?.zoneId && params.zoneId !== zoneId) {
    reply.code(403).send({ error: 'zone_mismatch' })
    return
  }
  req.caracalAuth = { zoneId, scopes, subject }
}
