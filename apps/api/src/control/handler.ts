// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// /v1/control/invoke handler: rate-limits, authenticates, blocks JTI replay, and dispatches through the shared engine.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { dispatch, DispatchError, type DispatchContext, type FlagMap, type Principal } from '@caracalai/engine'
import { Authenticator, AuthError } from './auth.js'
import type { AuditEvent, EventSink } from './audit.js'
import type { Replay } from './replay.js'
import type { RateLimiter } from './ratelimit.js'
import type { ControlGate } from './gate.js'
import { redisMinuteBucket, type RedisClient } from '../redis.js'
import { AUTHORIZED_BY_HEADER, CREATED_VIA_HEADER } from '../attribution.js'

const MAX_BODY_BYTES = 64 * 1024

// The header the in-process Operator stamps to act in a tenant zone's live state. The token is
// minted in the Operator's own (system) zone; this names the zone the command targets. The
// boundary is default-deny and enforced here: the caller must be a reserved Operator identity,
// and the target zone must exist, be unarchived, be neither reserved nor isolated, and carry an
// explicit operator-administration grant. Any request that stamps the header without satisfying
// every check is refused and audited - it is never silently narrowed to the token's own zone.
const ZONE_SCOPE_HEADER = 'x-caracal-zone-scope'

// The shape a zone-scope header value must have before it is honored. Zone ids are opaque
// url-safe identifiers; anything else (path separators, encodings, control characters) is
// refused so the value can never alter the internal admin request paths it is spliced into.
const ZONE_SCOPE_PATTERN = /^[A-Za-z0-9-]{1,64}$/

interface InvokeBody {
  command?: unknown
  subcommand?: unknown
  flags?: unknown
  authorized_by?: unknown
  co_author_operator?: unknown
}

export interface ZoneScopeTarget {
  reserved: boolean
  archived: boolean
  operatorGoverned: boolean
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
  // The application ids of the reserved Operator role identities, or null when self-governance
  // is not configured or its credentials have expired. Only these subjects may stamp the
  // zone-scope header or the attribution fields; the set is resolved lazily because the
  // identities are provisioned after the server is listening and rotate while it runs.
  resolveOperatorSubjects?: () => ReadonlySet<string> | null
  // Authoritative lookup of a zone-scope target: whether the zone exists, is archived, is in
  // the reserved caracal.sys namespace, and carries the explicit operator-administration grant.
  // Null when the zone does not exist. Absent when no zone authority is wired, in which case
  // every zone-scope request is refused.
  lookupZoneScopeTarget?: (zoneId: string) => Promise<ZoneScopeTarget | null>
  // Zones isolated from Operator administration by deployment policy.
  isolatedZones?: ReadonlySet<string>
}

interface ZoneScopeDecision {
  zone?: string
  denied?: string
}

// Authorizes the zone a request acts in, default-deny. A request without the zone-scope header
// (or naming the token's own zone) acts in the token's zone. A cross-zone request must pass
// every check - reserved Operator subject, well-formed target, zone exists and is unarchived,
// not reserved, not isolated, and explicitly granted for operator administration - or it is
// refused outright rather than silently re-scoped.
async function resolveEffectiveZone(
  req: FastifyRequest,
  deps: InvokeDeps,
  claims: { sub: string; zoneId?: string },
  operatorSubjects: ReadonlySet<string> | null,
): Promise<ZoneScopeDecision> {
  const requested = req.headers[ZONE_SCOPE_HEADER]
  const target = typeof requested === 'string' ? requested.trim() : ''
  if (!target || target === claims.zoneId) return { zone: claims.zoneId }
  if (!ZONE_SCOPE_PATTERN.test(target)) return { denied: 'zone scope: malformed zone id' }
  if (!operatorSubjects?.has(claims.sub)) return { denied: 'zone scope: subject is not a reserved operator identity' }
  if (!deps.lookupZoneScopeTarget) return { denied: 'zone scope: no zone authority configured' }
  const zone = await deps.lookupZoneScopeTarget(target)
  if (!zone) return { denied: 'zone scope: zone does not exist' }
  if (zone.archived) return { denied: 'zone scope: zone is archived' }
  if (zone.reserved) return { denied: 'zone scope: reserved zone' }
  if (deps.isolatedZones?.has(target)) return { denied: 'zone scope: isolated zone' }
  if (!zone.operatorGoverned) return { denied: 'zone scope: zone has not granted operator administration' }
  return { zone: target }
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
  // The request id is Fastify's, which honors a well-formed inbound x-request-id, so every
  // audit event this invoke emits correlates with the caller's own trace instead of starting
  // a fresh chain at the control boundary.
  const requestId = req.id
  reply.header('x-request-id', requestId)
  // A refusal is already the safe outcome, so an audit failure on a deny path never converts
  // the response; the sink has durably queued or loudly logged the loss either way.
  const emitDeny = async (ev: AuditEvent): Promise<void> => {
    try {
      await deps.sink.emit(ev)
    } catch (err) {
      req.log.error({ err, requestId }, 'control deny audit could not be recorded')
    }
  }
  if (!deps.gate.enabled()) {
    await emitDeny({
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
    await emitDeny({
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
    await emitDeny({
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
    await emitDeny({
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
    await emitDeny({
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
  // Attribution asserts the authority the caller acted on behalf of and operator
  // co-authorship of the objects it creates. Both fields are honored only when the
  // authenticated subject is a reserved Operator identity; any other caller's values are
  // discarded, because attribution must derive from the authenticated identity - a tenant
  // control key can never stamp operator provenance onto what it creates.
  const operatorSubjects = deps.resolveOperatorSubjects?.() ?? null
  const isOperatorSubject = operatorSubjects?.has(claims.sub) === true
  const authorizedBy =
    isOperatorSubject && typeof body?.authorized_by === 'string' && body.authorized_by.length <= 256 ? body.authorized_by : undefined
  const coAuthorOperator = isOperatorSubject && body?.co_author_operator === true

  // The zone the request acts in, authorized default-deny: the token's own zone, or a granted
  // tenant zone a reserved Operator identity targets via the zone-scope header. Every refusal
  // is audited with its precise reason, and the audit records the effective zone on every
  // dispatch, so each cross-zone authorization decision is reconstructable from the chain.
  const zoneScope = await resolveEffectiveZone(req, deps, claims, operatorSubjects)
  if (zoneScope.denied) {
    await emitDeny({
      at: new Date(),
      zoneId: claims.zoneId,
      clientId: claims.clientId,
      subject: claims.sub,
      jti: claims.jti,
      command,
      subcommand,
      decision: 'deny',
      reason: zoneScope.denied,
      requestId,
      idempotencyKey,
    })
    return reply.code(403).send({ ok: false, error: errorBody('denied', zoneScope.denied) })
  }
  const effectiveZone = zoneScope.zone

  const principal: Principal = {
    kind: 'remote',
    subject: claims.sub,
    zoneId: effectiveZone,
    clientId: claims.clientId,
    scopes: claims.scope.split(/\s+/).filter((s) => s.length > 0),
  }

  try {
    const result = await dispatch({ command, subcommand, flags }, principal, dispatchCtx(deps, requestId, authorizedBy, coAuthorOperator))
    // The allow audit is the governance record of a completed change, so it is fail-closed:
    // when the event cannot be durably recorded on either the stream or the outbox, the
    // invoke is reported as failed rather than silently succeeding unaudited.
    try {
      await deps.sink.emit({
        at: new Date(),
        zoneId: effectiveZone,
        clientId: claims.clientId,
        subject: claims.sub,
        jti: claims.jti,
        command,
        subcommand,
        decision: 'allow',
        requestId,
        idempotencyKey,
        authorizedBy,
      })
    } catch (err) {
      req.log.error({ err, command, requestId }, 'control allow audit could not be recorded; refusing to report success')
      return reply.code(500).send({ ok: false, error: errorBody('audit_unavailable', 'operation applied but its audit record could not be durably recorded') })
    }
    return reply.code(200).send({ ok: true, result })
  } catch (err) {
    const reason = describe(err)
    await emitDeny({
      at: new Date(),
      zoneId: effectiveZone,
      clientId: claims.clientId,
      subject: claims.sub,
      jti: claims.jti,
      command,
      subcommand,
      decision: 'deny',
      reason,
      requestId,
      idempotencyKey,
      authorizedBy,
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

// Derives the dispatch context for an invoke, attaching the request id and any request-scoped
// attribution headers so downstream admin calls and their audit records correlate with this
// invoke's trace, and a create route can stamp the human the Operator acted for and mark
// operator co-authorship.
function dispatchCtx(deps: InvokeDeps, requestId: string, authorizedBy: string | undefined, coAuthorOperator: boolean): DispatchContext {
  const headers: Record<string, string> = { 'x-request-id': requestId }
  if (authorizedBy) headers[AUTHORIZED_BY_HEADER] = authorizedBy
  if (coAuthorOperator) headers[CREATED_VIA_HEADER] = 'operator'
  return { ...deps.ctx, admin: deps.ctx.admin.withDefaultHeaders(headers) }
}

function describe(err: unknown): string {
  if (err instanceof AuthError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}

async function ipRateExceeded(redis: RedisClient, ip: string, limitPerMin: number): Promise<boolean> {
  if (limitPerMin <= 0) return false
  // Fail closed: when the counter store is unreachable the request is throttled rather than
  // admitted unmetered, matching the replay guard's posture on the same dependency.
  try {
    const minute = await redisMinuteBucket(redis)
    const key = `api:control_invoke_ip:${ip}:${minute}`
    const count = await redis.incr(key)
    if (count === 1) await redis.expire(key, 90)
    return count > limitPerMin
  } catch {
    return true
  }
}
