// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// V1 façade routes that expose begin/end/exchange/verify over flat HTTP for
// language-neutral integration without an SDK.

import type { FastifyPluginAsync, FastifyRequest, FastifyReply, FastifyInstance } from 'fastify'
import { z } from 'zod'
import { verify, type JwtConfig } from '@caracalai/identity'
import { cfg } from '../config.js'

const BeginBody = z.object({
  zone_id: z.string().min(1),
  application_id: z.string().min(1),
  session_sid: z.string().min(1),
  parent_id: z.string().nullable().default(null),
  capabilities: z.array(z.string()).default([]),
  ttl_seconds: z.number().int().min(1).max(86400).optional(),
})

const EndBody = z.object({
  zone_id: z.string().min(1),
  session_id: z.string().min(1),
  reason: z.string().min(1).max(256).optional(),
})

const ExchangeBody = z.object({
  zone_id: z.string().min(1),
  source_session_id: z.string().min(1),
  target_session_id: z.string().min(1),
  issuer_application_id: z.string().min(1),
  receiver_application_id: z.string().min(1),
  resource_id: z.string().min(1).nullable().default(null),
  scopes: z.array(z.string().min(1)).default([]),
  constraints_json: z.record(z.string(), z.unknown()).default({}),
  expires_at: z.string().datetime(),
})

const VerifyBody = z.object({
  authorization: z.string().min(1).optional(),
  token: z.string().min(1).optional(),
  zone_id: z.string().min(1).optional(),
  required_scope: z.string().min(1).optional(),
  require_agent: z.boolean().optional(),
  require_delegation: z.boolean().optional(),
})

function bearerOf(req: { headers: { authorization?: string } }): string {
  return req.headers.authorization ?? ''
}

function clientIp(req: FastifyRequest): string {
  return (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
    || req.ip
    || 'unknown'
}

async function v1RateLimit(fastify: FastifyInstance, req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (cfg.v1RateLimitPerMin <= 0) return false
  const minute = Math.floor(Date.now() / 60_000)
  const key = `coordinator:v1_rl:${clientIp(req)}:${minute}`
  const count = await fastify.redis.incr(key)
  if (count === 1) await fastify.redis.expire(key, 90)
  if (count > cfg.v1RateLimitPerMin) {
    reply.code(429).send({ error: 'rate_limited' })
    return true
  }
  return false
}

export const v1Routes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/v1/begin', async (req, reply) => {
    if (await v1RateLimit(fastify, req, reply)) return
    const body = BeginBody.parse(req.body)
    const res = await fastify.inject({
      method: 'POST',
      url: `/zones/${encodeURIComponent(body.zone_id)}/agents`,
      headers: { authorization: bearerOf(req), 'content-type': 'application/json' },
      payload: {
        application_id: body.application_id,
        session_sid: body.session_sid,
        parent_id: body.parent_id,
        capabilities: body.capabilities,
        ...(body.ttl_seconds ? { ttl_seconds: body.ttl_seconds } : {}),
      },
    })
    return reply.code(res.statusCode).send(res.json())
  })

  fastify.post('/v1/end', async (req, reply) => {
    if (await v1RateLimit(fastify, req, reply)) return
    const body = EndBody.parse(req.body)
    const reasonQs = body.reason ? `?reason=${encodeURIComponent(body.reason)}` : ''
    const res = await fastify.inject({
      method: 'DELETE',
      url: `/zones/${encodeURIComponent(body.zone_id)}/agents/${encodeURIComponent(body.session_id)}${reasonQs}`,
      headers: { authorization: bearerOf(req) },
    })
    if (res.statusCode === 204) return reply.code(204).send()
    return reply.code(res.statusCode).send(res.json())
  })

  fastify.post('/v1/exchange', async (req, reply) => {
    if (await v1RateLimit(fastify, req, reply)) return
    const body = ExchangeBody.parse(req.body)
    const { zone_id, ...payload } = body
    const res = await fastify.inject({
      method: 'POST',
      url: `/zones/${encodeURIComponent(zone_id)}/delegations`,
      headers: { authorization: bearerOf(req), 'content-type': 'application/json' },
      payload,
    })
    return reply.code(res.statusCode).send(res.json())
  })

  fastify.post('/v1/verify', async (req, reply) => {
    if (cfg.verifyRateLimitPerMin > 0) {
      const minute = Math.floor(Date.now() / 60_000)
      const key = `coordinator:verify_rl:${clientIp(req)}:${minute}`
      const count = await fastify.redis.incr(key)
      if (count === 1) await fastify.redis.expire(key, 90)
      if (count > cfg.verifyRateLimitPerMin) {
        return reply.code(429).send({ valid: false, error: 'rate_limited' })
      }
    }
    const body = VerifyBody.parse(req.body ?? {})
    const raw = body.token
      ?? (body.authorization?.startsWith('Bearer ')
        ? body.authorization.slice(7).trim()
        : body.authorization)
    if (!raw) return reply.code(400).send({ valid: false, error: 'missing_token' })
    const config: JwtConfig = {
      issuer: cfg.issuerUrl,
      audience: cfg.audience,
      ...(body.zone_id ? { zoneId: body.zone_id } : {}),
      ...(body.required_scope ? { requiredScopes: [body.required_scope] } : {}),
      ...(body.require_agent ? { requireAgent: true } : {}),
      ...(body.require_delegation ? { requireDelegation: true } : {}),
    }
    try {
      const claims = await verify(raw, config)
      return { valid: true, claims }
    } catch (err) {
      const name = err instanceof Error ? err.name : 'Error'
      const message = err instanceof Error ? err.message : 'verify_failed'
      return reply.code(401).send({ valid: false, error: name, message })
    }
  })
}
