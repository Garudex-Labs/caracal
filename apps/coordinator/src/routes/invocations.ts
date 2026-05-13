// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Durable agent invocation routes with idempotency, cancellation, and outbox events.

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { enqueue, Topics, type Queryable } from '../outbox.js'
import { ownsApplication, requireScope } from '../auth.js'
import { cfg } from '../config.js'

const RetryPolicy = z.object({
  max_attempts: z.number().int().min(1).max(10).default(3),
  backoff_ms: z.number().int().min(0).max(300_000).default(1000),
}).default({})

const InvocationBody = z.object({
  service_id: z.string().min(1),
  source_session_id: z.string().min(1).nullable().default(null),
  target_session_id: z.string().min(1).nullable().default(null),
  idempotency_key: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().default({}),
  metadata: z.record(z.unknown()).default({}),
  timeout_ms: z.number().int().min(1).max(900_000).default(30_000),
  retry_policy: RetryPolicy,
})

const CompleteBody = z.object({
  status: z.enum(['succeeded', 'failed']),
  error: z.record(z.unknown()).nullable().default(null),
  metadata: z.record(z.unknown()).default({}),
})

const CancelBody = z.object({
  reason: z.string().min(1).optional(),
})

const INVOCATION_RETURNING = `RETURNING id, zone_id, service_id, source_session_id, target_session_id, idempotency_key,
                 method, params_json, metadata_json, status, attempts, max_attempts, timeout_ms,
                 retry_policy_json, deadline_at, cancel_requested_at, started_at, completed_at, created_at`

const INVOCATION_SELECT = `SELECT id, zone_id, service_id, source_session_id, target_session_id, idempotency_key,
                method, params_json, metadata_json, status, attempts, max_attempts, timeout_ms,
                retry_policy_json, deadline_at, cancel_requested_at, started_at, completed_at, created_at
         FROM agent_invocations`

export const invocationsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/zones/:zoneId/invocations', async (req, reply) => {
    const { zoneId } = req.params as { zoneId: string }
    if (await rateLimited(fastify, req, zoneId)) {
      return reply.code(429).send({ error: 'rate_limited' })
    }
    const body = InvocationBody.parse(req.body)
    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      const { rows: services } = await client.query<{ application_id: string }>(
        `SELECT application_id FROM agent_services
         WHERE id = $1 AND zone_id = $2 FOR SHARE`,
        [body.service_id, zoneId],
      )
      if (!services[0]) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'agent_service_not_found' })
      }
      const sessions = await loadInvocationSessions(
        client, zoneId, body.source_session_id, body.target_session_id,
      )
      if (sessions === null) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'agent_session_not_found' })
      }
      const sourceApp = sessions.source?.application_id ?? services[0].application_id
      if (!ownsApplication(req, sourceApp)
        && !requireScope(req, `coordinator.invoke_from:${sourceApp}`)
        && !requireScope(req, 'coordinator.admin')) {
        await client.query('ROLLBACK')
        return reply.code(403).send({ error: 'invoker_ownership_required' })
      }

      const id = uuidv7()
      const retryPolicy = body.retry_policy
      const { rows } = await client.query(
        `INSERT INTO agent_invocations
         (id, zone_id, service_id, source_session_id, target_session_id, idempotency_key,
          method, params_json, metadata_json, timeout_ms, max_attempts, retry_policy_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (zone_id, service_id, idempotency_key) DO NOTHING
         ${INVOCATION_RETURNING}`,
        [
          id,
          zoneId,
          body.service_id,
          body.source_session_id,
          body.target_session_id,
          body.idempotency_key,
          body.method,
          JSON.stringify(body.params),
          JSON.stringify(body.metadata),
          body.timeout_ms,
          retryPolicy.max_attempts,
          retryPolicy,
        ],
      )
      if (!rows[0]) {
        const existing = await getInvocationByKey(client, zoneId, body.service_id, body.idempotency_key)
        await client.query('COMMIT')
        return reply.code(200).send(existing)
      }
      await enqueueInvocationEvent(client, zoneId, body.service_id, rows[0].id, 'invocation.created')
      await client.query('COMMIT')
      return reply.code(201).send(rows[0])
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  fastify.get('/zones/:zoneId/invocations/:id', async (req, reply) => {
    const { zoneId, id } = req.params as { zoneId: string; id: string }
    const { rows } = await fastify.db.query(
      `${INVOCATION_SELECT} WHERE zone_id = $1 AND id = $2`,
      [zoneId, id],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'invocation_not_found' })
    return rows[0]
  })

  fastify.patch('/zones/:zoneId/invocations/:id/start', async (req, reply) => {
    const { zoneId, id } = req.params as { zoneId: string; id: string }
    if (await rateLimited(fastify, req, zoneId)) {
      return reply.code(429).send({ error: 'rate_limited' })
    }
    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      const owner = await loadInvocationOwner(client, zoneId, id)
      if (!owner) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'invocation_not_found' })
      }
      if (!authorizeInvocationCaller(req, owner.application_id)) {
        await client.query('ROLLBACK')
        return reply.code(403).send({ error: 'invoker_ownership_required' })
      }
      const { rows } = await client.query(
        `UPDATE agent_invocations
         SET status = 'running', attempts = attempts + 1, started_at = now(),
             completed_at = NULL, error_json = NULL,
             deadline_at = now() + (timeout_ms * interval '1 millisecond'), updated_at = now()
         WHERE zone_id = $1 AND id = $2 AND status IN ('pending', 'failed') AND attempts < max_attempts
         ${INVOCATION_RETURNING}`,
        [zoneId, id],
      )
      if (!rows[0]) {
        await client.query('ROLLBACK')
        return reply.code(409).send({ error: 'invocation_not_startable' })
      }
      await enqueueInvocationEvent(client, zoneId, rows[0].service_id, id, 'invocation.started')
      await client.query('COMMIT')
      return rows[0]
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  fastify.patch('/zones/:zoneId/invocations/:id/cancel', async (req, reply) => {
    const { zoneId, id } = req.params as { zoneId: string; id: string }
    if (await rateLimited(fastify, req, zoneId)) {
      return reply.code(429).send({ error: 'rate_limited' })
    }
    const body = CancelBody.parse(req.body ?? {})
    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      const owner = await loadInvocationOwner(client, zoneId, id)
      if (!owner) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'invocation_not_found' })
      }
      if (!authorizeInvocationCaller(req, owner.application_id)) {
        await client.query('ROLLBACK')
        return reply.code(403).send({ error: 'invoker_ownership_required' })
      }
      const { rows } = await client.query(
        `UPDATE agent_invocations
         SET status = CASE WHEN status IN ('pending', 'failed') THEN 'canceled' ELSE 'cancel_requested' END,
             cancel_requested_at = now(),
             metadata_json = metadata_json || $3::jsonb,
             updated_at = now()
         WHERE zone_id = $1 AND id = $2 AND status NOT IN ('succeeded', 'canceled', 'timed_out', 'dead', 'failed')
         ${INVOCATION_RETURNING}`,
        [zoneId, id, JSON.stringify(body.reason ? { cancel_reason: body.reason } : {})],
      )
      if (!rows[0]) {
        await client.query('ROLLBACK')
        return reply.code(409).send({ error: 'invocation_not_cancelable' })
      }
      await enqueueInvocationEvent(client, zoneId, rows[0].service_id, id, 'invocation.cancel_requested')
      await client.query('COMMIT')
      return rows[0]
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  fastify.patch('/zones/:zoneId/invocations/:id/complete', async (req, reply) => {
    const { zoneId, id } = req.params as { zoneId: string; id: string }
    if (await rateLimited(fastify, req, zoneId)) {
      return reply.code(429).send({ error: 'rate_limited' })
    }
    const body = CompleteBody.parse(req.body)
    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      const owner = await loadInvocationOwner(client, zoneId, id)
      if (!owner) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'invocation_not_found' })
      }
      if (!authorizeInvocationCaller(req, owner.application_id)) {
        await client.query('ROLLBACK')
        return reply.code(403).send({ error: 'invoker_ownership_required' })
      }
      const { rows } = await client.query(
        `UPDATE agent_invocations
         SET status = $3, error_json = $4::jsonb, metadata_json = metadata_json || $5::jsonb,
             completed_at = now(), updated_at = now()
         WHERE zone_id = $1 AND id = $2 AND status IN ('running', 'cancel_requested')
         ${INVOCATION_RETURNING}`,
        [zoneId, id, body.status, JSON.stringify(body.error), JSON.stringify(body.metadata)],
      )
      if (!rows[0]) {
        await client.query('ROLLBACK')
        return reply.code(409).send({ error: 'invocation_not_completable' })
      }
      await enqueueInvocationEvent(client, zoneId, rows[0].service_id, id, `invocation.${body.status}`)
      await client.query('COMMIT')
      return rows[0]
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })
}

async function loadInvocationOwner(
  db: Queryable, zoneId: string, id: string,
): Promise<{ application_id: string } | null> {
  const { rows } = await db.query<{ application_id: string }>(
    `SELECT s.application_id
     FROM agent_invocations i
     JOIN agent_services s ON s.id = i.service_id AND s.zone_id = i.zone_id
     WHERE i.zone_id = $1 AND i.id = $2
     FOR UPDATE OF i`,
    [zoneId, id],
  )
  return rows[0] ?? null
}

function authorizeInvocationCaller(req: FastifyRequest, appId: string): boolean {
  return ownsApplication(req, appId)
    || requireScope(req, `coordinator.invoke_from:${appId}`)
    || requireScope(req, 'coordinator.admin')
}

async function getInvocationByKey(
  db: Queryable, zoneId: string, serviceId: string, idempotencyKey: string,
): Promise<unknown> {
  const { rows } = await db.query(
    `${INVOCATION_SELECT} WHERE zone_id = $1 AND service_id = $2 AND idempotency_key = $3 FOR SHARE`,
    [zoneId, serviceId, idempotencyKey],
  )
  return rows[0]
}

interface SessionRef {
  id: string
  application_id: string
}

async function loadInvocationSessions(
  db: Queryable,
  zoneId: string,
  sourceId: string | null,
  targetId: string | null,
): Promise<{ source?: SessionRef; target?: SessionRef } | null> {
  const ids = [sourceId, targetId].filter((v): v is string => Boolean(v))
  if (ids.length === 0) return {}
  const { rows } = await db.query<SessionRef>(
    `SELECT id, application_id FROM agent_sessions
     WHERE zone_id = $1
       AND id = ANY($2::text[])
       AND status = 'active'
       AND ttl_seconds IS NOT NULL
       AND spawned_at + (ttl_seconds * interval '1 second') > now()
     FOR SHARE`,
    [zoneId, ids],
  )
  const byId = new Map(rows.map((row) => [row.id, row]))
  if (byId.size !== ids.length) return null
  return {
    ...(sourceId ? { source: byId.get(sourceId) } : {}),
    ...(targetId ? { target: byId.get(targetId) } : {}),
  }
}

async function enqueueInvocationEvent(
  db: Queryable,
  zoneId: string,
  serviceId: string,
  invocationId: string,
  event: string,
): Promise<void> {
  await enqueue(db, Topics.InvocationsLifecycle, `${event}:${invocationId}`, {
    event,
    zone_id: zoneId,
    service_id: serviceId,
    invocation_id: invocationId,
  })
}

async function rateLimited(fastify: FastifyInstance, req: FastifyRequest, zoneId: string): Promise<boolean> {
  if (cfg.invocationRateLimitPerMin <= 0) return false
  const subject = req.caracalAuth?.clientId ?? req.ip
  const minute = Math.floor(Date.now() / 60_000)
  const key = `coordinator:invocation_rl:${zoneId}:${subject}:${minute}`
  const count = await fastify.redis.incr(key)
  if (count === 1) await fastify.redis.expire(key, 90)
  return count > cfg.invocationRateLimitPerMin
}
