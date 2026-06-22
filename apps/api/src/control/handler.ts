// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// /v1/control/invoke handler: rate-limits, authenticates, blocks JTI replay, and dispatches through the shared engine.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { dispatch, DispatchError, type DispatchContext, type FlagMap, type Principal } from '@caracalai/engine'
import { Authenticator, AuthError } from './auth.js'
import { newRequestId, type EventSink } from './audit.js'
import type { Replay } from './replay.js'
import type { RateLimiter } from './ratelimit.js'
import type { ControlGate } from './gate.js'
import { redisMinuteBucket, type RedisClient } from '../redis.js'

const MAX_BODY_BYTES = 64 * 1024

interface InvokeBody {
  command?: unknown
  subcommand?: unknown
  flags?: unknown
}

export interface InvokeDeps {
  auth: Authenticator
  replay: Replay
  rate: RateLimiter
  sink: EventSink
  ctx: DispatchContext
  gate: ControlGate
  redis: RedisClient
  // Pre-authentication per-IP request ceiling that throttles unauthenticated
  // floods before they reach JWT verification and JWKS fetches. 0 disables it.
  ipRateLimitPerMin: number
}

export function registerInvokeRoute(app: FastifyInstance, deps: InvokeDeps): void {
  app.post(
    '/v1/control/invoke',
    {
      bodyLimit: MAX_BODY_BYTES,
      config: { rawBody: false },
    },
    (req, reply) => handle(req, reply, deps),
  )
}

async function handle(req: FastifyRequest, reply: FastifyReply, deps: InvokeDeps): Promise<void> {
  const requestId = newRequestId()
  reply.header('x-request-id', requestId)
  if (!deps.gate.enabled()) {
    await deps.sink.emit({
      at: new Date(),
      subject: 'anonymous',
      jti: '',
      decision: 'deny',
      reason: 'control disabled',
      requestId,
    })
    return reply.code(503).send({ error: 'control disabled' })
  }

  if (await ipRateExceeded(deps.redis, req.ip, deps.ipRateLimitPerMin)) {
    await deps.sink.emit({
      at: new Date(),
      subject: 'anonymous',
      jti: '',
      decision: 'deny',
      reason: 'ip rate limited',
      requestId,
    })
    return reply.code(429).send({ error: 'rate limited' })
  }

  let claims
  try {
    claims = await deps.auth.verify(req.headers.authorization)
  } catch (err) {
    await deps.sink.emit({
      at: new Date(),
      subject: 'anonymous',
      jti: '',
      decision: 'deny',
      reason: 'auth: ' + describe(err),
      requestId,
    })
    return reply.code(401).send({ error: 'unauthorized' })
  }

  if (!(await deps.replay.mark(claims.jti, claims.exp))) {
    await deps.sink.emit({
      at: new Date(),
      zoneId: claims.zoneId,
      clientId: claims.clientId,
      subject: claims.sub,
      jti: claims.jti,
      decision: 'deny',
      reason: 'replay',
      requestId,
    })
    return reply.code(401).send({ error: 'token replay' })
  }
  if (!deps.rate.allow(claims.sub)) {
    await deps.sink.emit({
      at: new Date(),
      zoneId: claims.zoneId,
      clientId: claims.clientId,
      subject: claims.sub,
      jti: claims.jti,
      decision: 'deny',
      reason: 'rate limited',
      requestId,
    })
    return reply.code(429).send({ error: 'rate limited' })
  }

  const body = req.body as InvokeBody | null
  const command = typeof body?.command === 'string' ? body.command : ''
  const subcommand = typeof body?.subcommand === 'string' ? body.subcommand : ''
  const flags = body?.flags && typeof body.flags === 'object' && !Array.isArray(body.flags) ? (body.flags as FlagMap) : undefined
  const idempotencyKey = typeof flags?.['idempotency-key'] === 'string' ? (flags['idempotency-key'] as string) : undefined

  const principal: Principal = {
    kind: 'remote',
    subject: claims.sub,
    zoneId: claims.zoneId,
    clientId: claims.clientId,
    scopes: claims.scope.split(/\s+/).filter((s) => s.length > 0),
  }

  try {
    const result = await dispatch({ command, subcommand, flags }, principal, deps.ctx)
    await deps.sink.emit({
      at: new Date(),
      zoneId: claims.zoneId,
      clientId: claims.clientId,
      subject: claims.sub,
      jti: claims.jti,
      command,
      subcommand,
      decision: 'allow',
      requestId,
      idempotencyKey,
    })
    return reply.code(200).send({ ok: true, result })
  } catch (err) {
    const reason = describe(err)
    await deps.sink.emit({
      at: new Date(),
      zoneId: claims.zoneId,
      clientId: claims.clientId,
      subject: claims.sub,
      jti: claims.jti,
      command,
      subcommand,
      decision: 'deny',
      reason,
      requestId,
      idempotencyKey,
    })
    if (err instanceof DispatchError) {
      const status = STATUS_FOR_CODE[err.code] ?? 400
      return reply.code(status).send({ ok: false, error: errorBody(err.code, reason, err.remediation) })
    }
    req.log.error({ command }, 'upstream error: ' + reason)
    return reply.code(502).send({ ok: false, error: errorBody('upstream', 'upstream error') })
  }
}

const STATUS_FOR_CODE: Record<string, number> = {
  denied: 403,
  invalid: 400,
  unsupported: 501,
  zone_mismatch: 409,
  conflict: 409,
  not_found: 404,
  upstream: 502,
}

function errorBody(code: string, reason: string, remediation?: string): Record<string, string> {
  return remediation ? { code, reason, remediation } : { code, reason }
}

function describe(err: unknown): string {
  if (err instanceof AuthError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}

async function ipRateExceeded(redis: RedisClient, ip: string, limitPerMin: number): Promise<boolean> {
  if (limitPerMin <= 0) return false
  const minute = await redisMinuteBucket(redis)
  const key = `api:control_invoke_ip:${ip}:${minute}`
  const count = await redis.incr(key)
  if (count === 1) await redis.expire(key, 90)
  return count > limitPerMin
}
