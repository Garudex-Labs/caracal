// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Language-neutral mandate verification endpoint.

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { verify, type JwtConfig } from '@caracalai/identity'
import { cfg } from '../config.js'
import { redisMinuteBucket } from '../redis.js'

const VerifyBody = z
  .object({
    authorization: z.string().min(1).optional(),
    token: z.string().min(1).optional(),
    zone_id: z.string().min(1),
    required_scope: z.string().min(1).optional(),
    require_session: z.boolean().optional(),
    require_delegation: z.boolean().optional(),
  })
  .strict()

function clientIp(req: FastifyRequest): string {
  return req.ip || 'unknown'
}

export const verifyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/v1/verify', async (req, reply) => {
    if (cfg.verifyRateLimitPerMin > 0) {
      const minute = await redisMinuteBucket(fastify.redis)
      const key = `coordinator:verify_rl:${clientIp(req)}:${minute}`
      const count = await fastify.redis.incr(key)
      if (count === 1) await fastify.redis.expire(key, 90)
      if (count > cfg.verifyRateLimitPerMin) {
        return reply.code(429).send({ valid: false, error: 'rate_limited' })
      }
    }
    const parsed = VerifyBody.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ valid: false, error: 'invalid_request' })
    const body = parsed.data
    const raw = body.token ?? (body.authorization?.startsWith('Bearer ') ? body.authorization.slice(7).trim() : body.authorization)
    if (!raw) return reply.code(400).send({ valid: false, error: 'missing_token' })
    const config: JwtConfig = {
      issuer: cfg.issuerUrl,
      audience: cfg.audience,
      zoneId: body.zone_id,
      ...(body.required_scope ? { requiredScopes: [body.required_scope] } : {}),
      ...(body.require_session ? { requireSession: true } : {}),
      ...(body.require_delegation ? { requireDelegation: true } : {}),
    }
    try {
      const claims = await verify(raw, config)
      return { valid: true, claims }
    } catch (err) {
      req.log.warn({ err }, 'token_verification_failed')
      return reply.code(401).send({ valid: false, error: 'token_invalid' })
    }
  })
}
