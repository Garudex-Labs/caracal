// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// JWT bearer verification against STS JWKS endpoint.

import { pathOnly } from '@caracalai/core'
import { timingSafeEqual } from 'node:crypto'
import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose'
import type { FastifyRequest, FastifyReply } from 'fastify'
import { cfg } from './config.js'
import { CoordinatorIdPattern } from './routes/params.js'

// Per-zone JWKS resolvers. STS exposes one signing keyset per zone so a single
// document never reveals every zone's keys; callers must pass ?zone_id=. Each
// resolver enforces a hard cacheMaxAge so a sustained STS outage fails closed
// instead of accepting tokens against indefinitely stale keys. The map is
// bounded so an attacker who can mint zone ids cannot exhaust memory.
type JwksResolver = ReturnType<typeof createRemoteJWKSet>
const jwksByZone = new Map<string, JwksResolver>()

function jwksForZone(zoneId: string): JwksResolver {
  const existing = jwksByZone.get(zoneId)
  if (existing) {
    jwksByZone.delete(zoneId)
    jwksByZone.set(zoneId, existing)
    return existing
  }
  const url = new URL(`${cfg.stsUrl}/.well-known/jwks.json`)
  url.searchParams.set('zone_id', zoneId)
  const resolver = createRemoteJWKSet(url, {
    cooldownDuration: 30_000,
    cacheMaxAge: 600_000,
    timeoutDuration: 5_000,
  })
  jwksByZone.set(zoneId, resolver)
  while (jwksByZone.size > cfg.jwksCacheMax) {
    const oldest = jwksByZone.keys().next().value
    if (oldest === undefined) break
    jwksByZone.delete(oldest)
  }
  return resolver
}

declare module 'fastify' {
  interface FastifyRequest {
    caracalAuth?: {
      zoneId: string
      scopes: string[]
      subject: string
      clientId: string
      agentSessionId?: string
      delegationEdgeId?: string
      sessionId?: string
    }
  }
}

export function requireScope(req: FastifyRequest, scope: string): boolean {
  return req.caracalAuth?.scopes.includes(scope) ?? false
}

export function ownsApplication(req: FastifyRequest, applicationId: string): boolean {
  return req.caracalAuth?.clientId === applicationId
}

const PUBLIC_PATHS = new Set(['/health', '/ready', '/v1/verify'])
const OPERATOR_TOKEN_PATHS = new Set(['/metrics', '/stats'])
const BEARER_PREFIX = 'Bearer '
const MAX_BEARER_BYTES = 4096

function classifyError(err: unknown): string {
  const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined
  switch (code) {
    case 'ERR_JWT_EXPIRED': return 'token_expired'
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED': return 'claim_invalid'
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED': return 'signature_invalid'
    case 'ERR_JOSE_ALG_NOT_ALLOWED': return 'algorithm_not_allowed'
    case 'ERR_JWKS_NO_MATCHING_KEY': return 'jwks_no_matching_key'
    case 'ERR_JWKS_TIMEOUT': return 'jwks_timeout'
    default: return typeof code === 'string' && code.startsWith('ERR_JOSE_') ? 'jose_error' : 'unknown_error'
  }
}

function matchesOperatorToken(token: string): boolean {
  if (!cfg.coordinatorToken) return false
  const actual = Buffer.from(token)
  const expected = Buffer.from(cfg.coordinatorToken)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export async function verifyBearer(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const path = pathOnly(req.url)
  if (PUBLIC_PATHS.has(path)) return

  const auth = req.headers.authorization
  if (typeof auth !== 'string' || !auth.startsWith(BEARER_PREFIX)) {
    reply.code(401).send({ error: 'missing_token' })
    return
  }
  const token = auth.slice(BEARER_PREFIX.length).trim()
  if (!token || token.length > MAX_BEARER_BYTES) {
    reply.code(401).send({ error: 'missing_token' })
    return
  }
  if (OPERATOR_TOKEN_PATHS.has(path) && matchesOperatorToken(token)) return
  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload']
  let tokenZone: string
  try {
    const claims = decodeJwt(token)
    const zoneClaim = claims['zone_id']
    if (typeof zoneClaim !== 'string' || !CoordinatorIdPattern.test(zoneClaim)) {
      reply.code(401).send({ error: 'invalid_token' })
      return
    }
    tokenZone = zoneClaim
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

  const zoneId = payload['zone_id']
  if (typeof zoneId !== 'string' || zoneId === '' || zoneId !== tokenZone) {
    req.log.warn('jwt_zone_claim_mismatch')
    reply.code(401).send({ error: 'invalid_token' })
    return
  }
  const subject = payload.sub
  if (typeof subject !== 'string' || subject === '') {
    reply.code(401).send({ error: 'invalid_token' })
    return
  }
  const scopes = typeof payload.scope === 'string' ? payload.scope.split(/\s+/).filter(Boolean) : []
  if (!scopes.includes(cfg.requiredScope)) {
    reply.code(403).send({ error: 'missing_scope' })
    return
  }
  const params = req.params as { zoneId?: string } | undefined
  if (params?.zoneId && params.zoneId !== zoneId) {
    reply.code(403).send({ error: 'zone_mismatch' })
    return
  }
  const clientId = typeof payload['client_id'] === 'string' ? payload['client_id'] : ''
  if (clientId === '') {
    reply.code(401).send({ error: 'invalid_token' })
    return
  }
  const agentSessionId = typeof payload['agent_session_id'] === 'string' ? payload['agent_session_id'] : undefined
  const delegationEdgeId = typeof payload['delegation_edge_id'] === 'string' ? payload['delegation_edge_id'] : undefined
  const sessionId = typeof payload['sid'] === 'string' ? payload['sid'] : undefined
  req.caracalAuth = { zoneId, scopes, subject, clientId, agentSessionId, delegationEdgeId, sessionId }
}
