// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Agent lifecycle routes: spawn, topology, suspend/resume, cascade terminate.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import type { PoolClient } from 'pg'
import { enqueue, enqueueMany, Topics, type OutboxItem, type Queryable } from '../outbox.js'
import { ownsApplication, requireScope } from '../auth.js'
import { bumpDelegationEpoch } from '../delegationEpochs.js'
import { ZoneIdParams, ZoneParams, parseParams } from './params.js'
import { cfg } from '../config.js'

export const MAX_DEPTH = 10
const MAX_CHILDREN = 10
const DEFAULT_TTL = 3600
const LIST_DEFAULT_LIMIT = 100
const LIST_MAX_LIMIT = 500
export const MAX_AGENT_LABELS = 32
export const MAX_AGENT_LABEL_LENGTH = 64

export const Lifecycle = z.enum(['task', 'service'])
export const AgentLabels = z.array(z.string().trim().min(1).max(MAX_AGENT_LABEL_LENGTH)).max(MAX_AGENT_LABELS).default([])

const SpawnBody = z.object({
  application_id: z.string().min(1),
  subject_session_id: z.string().min(1).optional(),
  parent_id: z.string().nullable().default(null),
  lifecycle: Lifecycle.optional(),
  labels: AgentLabels,
  ttl_seconds: z.number().int().min(1).max(86400).optional(),
  inherit_parent_edge_id: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
})

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(LIST_MAX_LIMIT).default(LIST_DEFAULT_LIMIT),
  cursor: z.string().min(1).optional(),
  status: z.enum(['active', 'suspended', 'terminated']).optional(),
  lifecycle: z.enum(['task', 'service']).optional(),
  application_id: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
})

const TerminateQuery = z.object({
  reason: z.string().min(1).max(256).default('requested'),
})

export function spawnLockKey(zoneId: string): string {
  return `coordinator:agent_spawn:${zoneId}`
}

// inheritParentEdge mirrors the parent's narrowing edge onto a freshly spawned
// child so an inherit spawn carries the parent's effective authority forward
// instead of regaining full application authority. The copy is escalation-proof
// by construction: the child edge holds the parent edge's exact scopes, resource,
// constraints, and expiry. Returns the new edge id, null when no inheritance was
// requested, or false when the requested parent edge is not an active edge into
// the parent under the same application.
async function inheritParentEdge(
  client: PoolClient,
  zoneId: string,
  body: z.infer<typeof SpawnBody>,
  childId: string,
): Promise<string | null | false> {
  if (!body.inherit_parent_edge_id || !body.parent_id) return null
  const { rows } = await client.query(
    `SELECT id, receiver_application_id, resource_id, scopes, constraints_json, expires_at
     FROM delegation_edges
     WHERE id = $1 AND zone_id = $2 AND target_session_id = $3
       AND receiver_application_id = $4 AND status = 'active' AND expires_at > now()`,
    [body.inherit_parent_edge_id, zoneId, body.parent_id, body.application_id],
  )
  const parentEdge = rows[0]
  if (!parentEdge) return false
  const edgeId = uuidv7()
  await client.query(
    `INSERT INTO delegation_edges
     (id, zone_id, source_session_id, target_session_id, issuer_application_id, receiver_application_id,
      parent_edge_id, resource_id, scopes, constraints_json, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      edgeId,
      zoneId,
      body.parent_id,
      childId,
      parentEdge.receiver_application_id,
      body.application_id,
      parentEdge.id,
      parentEdge.resource_id,
      parentEdge.scopes,
      parentEdge.constraints_json,
      parentEdge.expires_at,
    ],
  )
  const epoch = await bumpDelegationEpoch(client, zoneId)
  await enqueue(client, Topics.DelegationsInvalidate, `edge_create:${edgeId}`, {
    event: 'edge_create',
    zone_id: zoneId,
    edge_id: edgeId,
    source_session_id: body.parent_id,
    target_session_id: childId,
    epoch,
  })
  return edgeId
}

export const agentsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/zones/:zoneId/agents', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const { zoneId } = params
    const body = SpawnBody.parse(req.body)
    const subjectSessionId = body.subject_session_id ?? req.caracalAuth?.sessionId
    if (!subjectSessionId) {
      return reply.code(400).send({ error: 'subject_session_id_required' })
    }
    if (!ownsApplication(req, body.application_id) && !requireScope(req, `coordinator.spawn_for:${body.application_id}`)) {
      return reply.code(403).send({ error: 'application_ownership_required' })
    }
    const idempotencyKey = (req.headers['idempotency-key'] as string | undefined)?.trim() || null
    const id = uuidv7()
    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [spawnLockKey(zoneId)])
      if (idempotencyKey) {
        const { rows: existing } = await client.query(
          `SELECT id AS agent_session_id, zone_id, application_id, parent_id,
                  subject_session_id, lifecycle,
                  labels, status, depth, ttl_seconds, metadata_json AS metadata,
                  spawned_at, last_heartbeat_at, heartbeat_deadline_at,
                  (
                    SELECT e.id FROM delegation_edges e
                    WHERE e.zone_id = agent_sessions.zone_id
                      AND e.target_session_id = agent_sessions.id
                      AND e.status = 'active' AND e.expires_at > now()
                    ORDER BY e.created_at DESC LIMIT 1
                  ) AS delegation_edge_id
           FROM agent_sessions
           WHERE zone_id = $1 AND application_id = $2 AND idempotency_key = $3
             AND status IN ('active','suspended')
           LIMIT 1`,
          [zoneId, body.application_id, idempotencyKey],
        )
        if (existing[0]) {
          await client.query('ROLLBACK')
          return reply.code(200).send(existing[0])
        }
      }
      const { rows: refs } = await client.query(
        `SELECT
           (
             SELECT registration_method FROM applications
             WHERE id = $2 AND zone_id = $1 AND archived_at IS NULL
               AND (expires_at IS NULL OR expires_at > now())
           ) AS registration_method,
           EXISTS (
              SELECT 1 FROM applications
              WHERE id = $2 AND zone_id = $1 AND archived_at IS NULL
                AND (expires_at IS NULL OR expires_at > now())
            ) AS application_exists,
           EXISTS (
              SELECT 1 FROM sessions
              WHERE id = $3 AND zone_id = $1 AND status = 'active' AND expires_at > now()
            ) AS session_exists`,
        [zoneId, body.application_id, subjectSessionId],
      )
      if (!refs[0]?.application_exists) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'application_not_found' })
      }
      const lifecycle = body.lifecycle ?? 'task'
      if (refs[0].registration_method === 'dcr' && lifecycle !== 'task') {
        await client.query('ROLLBACK')
        return reply.code(409).send({ error: 'dcr_application_cannot_host_service' })
      }
      if (refs[0].registration_method === 'dcr' && body.parent_id) {
        await client.query('ROLLBACK')
        return reply.code(409).send({ error: 'dcr_application_cannot_be_child' })
      }
      if (!refs[0].session_exists) {
        await client.query('ROLLBACK')
        return reply.code(404).send({
          error: 'session_not_found',
          detail: 'subject_session_id must reference an STS sessions.id; for business correlation use metadata',
        })
      }
      const { rows: cnt } = await client.query(
        `SELECT
           COUNT(*) FILTER (WHERE application_id = $2) AS app_n,
           COUNT(*) AS zone_n
         FROM agent_sessions
         WHERE zone_id = $1
           AND status IN ('active', 'suspended')
           AND spawned_at + make_interval(secs => COALESCE(ttl_seconds, $3)) > now()
           AND (heartbeat_deadline_at IS NULL OR heartbeat_deadline_at > now())`,
        [zoneId, body.application_id, DEFAULT_TTL],
      )
      if (parseInt(cnt[0].zone_n, 10) >= cfg.maxAgentsPerZone) {
        await client.query('ROLLBACK')
        return reply.code(429).send({ error: 'agent_zone_limit_exceeded' })
      }
      if (refs[0].registration_method === 'dcr' && parseInt(cnt[0].app_n, 10) > 0) {
        await client.query('ROLLBACK')
        return reply.code(409).send({ error: 'dcr_application_already_bound' })
      }
      if (parseInt(cnt[0].app_n, 10) >= cfg.maxAgentsPerApp) {
        await client.query('ROLLBACK')
        return reply.code(429).send({ error: 'agent_limit_exceeded' })
      }

      let depth = 0
      if (body.parent_id) {
        const { rows: parent } = await client.query(
          `SELECT s.depth, s.child_count, s.max_children, s.application_id, s.lifecycle,
                  a.registration_method
           FROM agent_sessions s
           JOIN applications a ON a.id = s.application_id AND a.zone_id = s.zone_id
           WHERE s.id = $1 AND s.zone_id = $2 AND s.status = 'active'
           FOR UPDATE OF s`,
          [body.parent_id, zoneId],
        )
        if (!parent[0]) {
          await client.query('ROLLBACK')
          return reply.code(404).send({ error: 'parent_not_found' })
        }
        if (parent[0].registration_method === 'dcr') {
          await client.query('ROLLBACK')
          return reply.code(409).send({ error: 'dcr_application_cannot_spawn' })
        }
        if (parent[0].lifecycle === 'task' && lifecycle === 'service') {
          await client.query('ROLLBACK')
          return reply.code(409).send({ error: 'task_agent_cannot_spawn_service' })
        }
        if (parent[0].application_id !== body.application_id && !requireScope(req, `coordinator.spawn_under:${parent[0].application_id}`)) {
          await client.query('ROLLBACK')
          return reply.code(403).send({ error: 'parent_ownership_required' })
        }
        if (parent[0].child_count >= parent[0].max_children) {
          await client.query('ROLLBACK')
          return reply.code(429).send({ error: 'agent_children_limit_exceeded' })
        }
        depth = parent[0].depth + 1
        if (depth > MAX_DEPTH) {
          await client.query('ROLLBACK')
          return reply.code(429).send({ error: 'agent_depth_limit_exceeded' })
        }
      }
      const ttlSeconds = body.ttl_seconds ?? (lifecycle === 'service' ? null : DEFAULT_TTL)
      const { rows } = await client.query(
        `INSERT INTO agent_sessions
          (id, zone_id, application_id, parent_id, subject_session_id, lifecycle, depth,
            labels, max_children, ttl_seconds, metadata_json, idempotency_key,
            last_heartbeat_at, heartbeat_deadline_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$13,
                  CASE WHEN $6 = 'service' THEN now() ELSE NULL END,
                  CASE WHEN $6 = 'service' THEN now() + ($12::int * interval '1 second') ELSE NULL END)
           RETURNING id AS agent_session_id, zone_id, application_id, parent_id,
                     subject_session_id, lifecycle,
                     labels, status, depth, ttl_seconds, metadata_json AS metadata,
                     spawned_at, last_heartbeat_at, heartbeat_deadline_at`,
        [
          id,
          zoneId,
          body.application_id,
          body.parent_id,
          subjectSessionId,
          lifecycle,
          depth,
          body.labels,
          MAX_CHILDREN,
          ttlSeconds,
          body.metadata,
          cfg.serviceAgentLeaseSeconds,
          idempotencyKey,
        ],
      )
      if (body.parent_id) {
        await client.query(`INSERT INTO agent_topology (parent_id, child_id) VALUES ($1,$2)`, [body.parent_id, id])
        await client.query(`UPDATE agent_sessions SET child_count = child_count + 1 WHERE id = $1`, [body.parent_id])
      }
      const inheritedEdgeId = await inheritParentEdge(client, zoneId, body, id)
      if (inheritedEdgeId === false) {
        await client.query('ROLLBACK')
        return reply.code(409).send({ error: 'inherit_parent_edge_not_active' })
      }
      await enqueue(client, Topics.AgentsLifecycle, `spawn:${id}`, {
        event: 'spawn',
        zone_id: zoneId,
        agent_session_id: id,
        parent_id: body.parent_id,
        application_id: body.application_id,
      })
      await client.query('COMMIT')
      return reply.code(201).send({ ...rows[0], delegation_edge_id: inheritedEdgeId })
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  fastify.get('/zones/:zoneId/agents', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const { zoneId } = params
    const query = ListQuery.safeParse(req.query)
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' })
    const { limit, cursor, status, lifecycle, application_id, label } = query.data
    if (cursor) {
      const { rows: probe } = await fastify.db.query(`SELECT 1 FROM agent_sessions WHERE id = $1 AND zone_id = $2`, [cursor, zoneId])
      if (!probe[0]) return reply.code(400).send({ error: 'invalid_cursor' })
    }
    const conds = ['zone_id = $1']
    const queryParams: unknown[] = [zoneId]
    if (status) {
      queryParams.push(status)
      conds.push(`status = $${queryParams.length}`)
    }
    if (lifecycle) {
      queryParams.push(lifecycle)
      conds.push(`lifecycle = $${queryParams.length}`)
    }
    if (application_id) {
      queryParams.push(application_id)
      conds.push(`application_id = $${queryParams.length}`)
    }
    if (label) {
      queryParams.push(label)
      conds.push(`$${queryParams.length} = ANY(labels)`)
    }
    if (cursor) {
      queryParams.push(cursor)
      conds.push(`id < $${queryParams.length}`)
    }
    queryParams.push(limit)
    const limitPlaceholder = `$${queryParams.length}`
    const { rows } = await fastify.db.query(
      `SELECT id AS agent_session_id, zone_id, application_id, parent_id,
                subject_session_id, lifecycle,
                labels, status, depth, ttl_seconds, metadata_json AS metadata,
                spawned_at, terminated_at, termination_reason, last_heartbeat_at, heartbeat_deadline_at
         FROM agent_sessions WHERE ${conds.join(' AND ')}
       ORDER BY id DESC LIMIT ${limitPlaceholder}`,
      queryParams,
    )
    const nextCursor = rows.length === limit ? rows[rows.length - 1].agent_session_id : null
    return { items: rows, next_cursor: nextCursor }
  })

  fastify.get('/zones/:zoneId/agents/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { zoneId, id } = params
    const { rows } = await fastify.db.query(
      `SELECT id AS agent_session_id, zone_id, application_id, parent_id,
                subject_session_id, lifecycle,
                labels, status, depth, ttl_seconds, metadata_json AS metadata,
                spawned_at, terminated_at, termination_reason, last_heartbeat_at, heartbeat_deadline_at
         FROM agent_sessions WHERE id = $1 AND zone_id = $2`,
      [id, zoneId],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'agent_not_found' })
    return rows[0]
  })

  fastify.get('/zones/:zoneId/agents/:id/children', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { zoneId, id } = params
    const query = ListQuery.safeParse(req.query)
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' })
    const { limit, cursor } = query.data
    if (cursor) {
      const { rows: probe } = await fastify.db.query(`SELECT 1 FROM agent_sessions WHERE id = $1 AND zone_id = $2`, [cursor, zoneId])
      if (!probe[0]) return reply.code(400).send({ error: 'invalid_cursor' })
    }
    const queryParams: unknown[] = [id, zoneId]
    let cursorClause = ''
    if (cursor) {
      queryParams.push(cursor)
      cursorClause = `AND s.id < $${queryParams.length}`
    }
    queryParams.push(limit)
    const limitPlaceholder = `$${queryParams.length}`
    const { rows } = await fastify.db.query(
      `SELECT s.id AS agent_session_id, s.zone_id, s.application_id, s.parent_id,
              s.subject_session_id, s.lifecycle,
              s.labels, s.status, s.depth, s.ttl_seconds, s.metadata_json AS metadata,
              s.spawned_at, s.last_heartbeat_at, s.heartbeat_deadline_at
       FROM agent_sessions s
       JOIN agent_topology t ON t.child_id = s.id
       WHERE t.parent_id = $1 AND s.zone_id = $2 ${cursorClause}
       ORDER BY s.id DESC LIMIT ${limitPlaceholder}`,
      queryParams,
    )
    const nextCursor = rows.length === limit ? rows[rows.length - 1].agent_session_id : null
    return { items: rows, next_cursor: nextCursor }
  })

  fastify.patch('/zones/:zoneId/agents/:id/suspend', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { zoneId, id } = params
    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      const { rows: own } = await client.query(
        `SELECT application_id FROM agent_sessions
         WHERE id = $1 AND zone_id = $2 FOR UPDATE`,
        [id, zoneId],
      )
      if (!own[0]) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'agent_not_found' })
      }
      if (
        !ownsApplication(req, own[0].application_id) &&
        !requireScope(req, 'coordinator.admin') &&
        !requireScope(req, `coordinator.spawn_for:${own[0].application_id}`)
      ) {
        await client.query('ROLLBACK')
        return reply.code(403).send({ error: 'application_ownership_required' })
      }
      const suspended = await suspendSubtree(client, zoneId, [id], 'requested')
      if (suspended === 0) {
        await client.query('ROLLBACK')
        return reply.code(409).send({ error: 'agent_not_found_or_not_active' })
      }
      await client.query('COMMIT')
      return { suspended }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  fastify.patch('/zones/:zoneId/agents/:id/resume', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { zoneId, id } = params
    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      const { rows: own } = await client.query(
        `SELECT application_id FROM agent_sessions
         WHERE id = $1 AND zone_id = $2 FOR UPDATE`,
        [id, zoneId],
      )
      if (!own[0]) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'agent_not_found' })
      }
      if (
        !ownsApplication(req, own[0].application_id) &&
        !requireScope(req, 'coordinator.admin') &&
        !requireScope(req, `coordinator.spawn_for:${own[0].application_id}`)
      ) {
        await client.query('ROLLBACK')
        return reply.code(403).send({ error: 'application_ownership_required' })
      }
      const { rows: changed } = await client.query<{ id: string; parent_id: string | null }>(
        `WITH RECURSIVE tree AS (
           SELECT id, parent_id FROM agent_sessions
           WHERE id = $1 AND zone_id = $2 AND status = 'suspended'
           UNION ALL
           SELECT s.id, s.parent_id FROM agent_sessions s
           JOIN tree t ON s.parent_id = t.id
           WHERE s.zone_id = $2 AND s.status = 'suspended'
         )
          UPDATE agent_sessions
          SET status = 'active',
              heartbeat_deadline_at = CASE
                WHEN lifecycle = 'service' THEN now() + ($3::int * interval '1 second')
                ELSE heartbeat_deadline_at
              END,
              updated_at = now()
          WHERE id IN (SELECT id FROM tree) AND zone_id = $2
          RETURNING id, parent_id`,
        [id, zoneId, cfg.serviceAgentLeaseSeconds],
      )
      if (changed.length === 0) {
        await client.query('ROLLBACK')
        return reply.code(409).send({ error: 'agent_not_found_or_not_suspended' })
      }
      await enqueueMany(
        client,
        changed.map(
          (row): OutboxItem => ({
            topic: Topics.AgentsLifecycle,
            dedupeKey: `resume:${row.id}`,
            payload: { event: 'resume', zone_id: zoneId, agent_session_id: row.id, parent_id: row.parent_id },
          }),
        ),
      )
      await client.query('COMMIT')
      return { resumed: changed.length }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  fastify.delete('/zones/:zoneId/agents/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { zoneId, id } = params
    const query = TerminateQuery.safeParse(req.query)
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' })
    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [spawnLockKey(zoneId)])
      const { rows: own } = await client.query(
        `SELECT application_id FROM agent_sessions
         WHERE id = $1 AND zone_id = $2 FOR UPDATE`,
        [id, zoneId],
      )
      if (!own[0]) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'agent_not_found' })
      }
      if (
        !ownsApplication(req, own[0].application_id) &&
        !requireScope(req, 'coordinator.admin') &&
        !requireScope(req, `coordinator.spawn_for:${own[0].application_id}`)
      ) {
        await client.query('ROLLBACK')
        return reply.code(403).send({ error: 'application_ownership_required' })
      }
      const terminated = await terminateSubtree(client, zoneId, [id], query.data.reason)
      if (terminated === 0) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'agent_not_found' })
      }
      await client.query('COMMIT')
      return reply.code(204).send()
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })
}

interface TerminatedRow {
  id: string
  subject_session_id: string
  parent_id: string | null
}

interface SuspendedRow {
  id: string
  subject_session_id: string
  parent_id: string | null
}

export async function suspendSubtree(client: PoolClient, zoneId: string, rootIds: string[], reason: string): Promise<number> {
  if (rootIds.length === 0) return 0
  const { rows } = await client.query<SuspendedRow>(
    `WITH RECURSIVE tree AS (
       SELECT id, subject_session_id, parent_id
       FROM agent_sessions
       WHERE id = ANY($1::text[]) AND zone_id = $2 AND status = 'active'
       UNION ALL
       SELECT s.id, s.subject_session_id, s.parent_id
       FROM agent_sessions s
       JOIN tree t ON s.parent_id = t.id
       WHERE s.zone_id = $2 AND s.status = 'active'
     ),
     suspended AS (
       UPDATE agent_sessions
       SET status = 'suspended', updated_at = now()
       WHERE id IN (SELECT id FROM tree) AND zone_id = $2
       RETURNING id, subject_session_id, parent_id
     )
     SELECT id, subject_session_id, parent_id FROM suspended`,
    [rootIds, zoneId],
  )
  if (rows.length === 0) return 0
  const exemptSessions = await revocationExemptSessions(client, zoneId, rows)
  const items: OutboxItem[] = []
  for (const row of rows) {
    items.push({
      topic: Topics.AgentsLifecycle,
      dedupeKey: `suspend:${row.id}`,
      payload: {
        event: 'suspend',
        zone_id: zoneId,
        agent_session_id: row.id,
        parent_id: row.parent_id,
        reason,
      },
    })
    if (exemptSessions.has(row.subject_session_id)) continue
    items.push({
      topic: Topics.SessionsRevoke,
      dedupeKey: `agent_suspend:${row.id}`,
      payload: {
        zone_id: zoneId,
        session_id: row.subject_session_id,
        agent_session_id: row.id,
        reason,
      },
    })
  }
  await enqueueMany(client as Queryable, items)
  return rows.length
}

export async function terminateSubtree(client: PoolClient, zoneId: string, rootIds: string[], reason: string): Promise<number> {
  if (rootIds.length === 0) return 0
  const { rows } = await client.query<TerminatedRow>(
    `WITH RECURSIVE tree AS (
      SELECT id, subject_session_id, parent_id
       FROM agent_sessions
       WHERE id = ANY($1::text[]) AND zone_id = $2 AND status IN ('active','suspended')
       UNION ALL
      SELECT s.id, s.subject_session_id, s.parent_id
       FROM agent_sessions s
       JOIN tree t ON s.parent_id = t.id
       WHERE s.zone_id = $2 AND s.status IN ('active','suspended')
     ),
     terminated AS (
       UPDATE agent_sessions
       SET status = 'terminated', terminated_at = now(), updated_at = now(),
           termination_reason = CASE WHEN id = ANY($1::text[]) THEN $3 ELSE 'parent_terminated' END
       WHERE id IN (SELECT id FROM tree) AND zone_id = $2
      RETURNING id, subject_session_id, parent_id
     ),
     parent_decrements AS (
       SELECT parent_id, COUNT(*)::int AS dec
       FROM terminated
       WHERE parent_id IS NOT NULL
         AND parent_id NOT IN (SELECT id FROM terminated)
       GROUP BY parent_id
     ),
     adjusted AS (
       UPDATE agent_sessions s
       SET child_count = GREATEST(s.child_count - p.dec, 0), updated_at = now()
       FROM parent_decrements p
       WHERE s.id = p.parent_id AND s.zone_id = $2
       RETURNING s.id
     )
    SELECT id, subject_session_id, parent_id FROM terminated`,
    [rootIds, zoneId, reason],
  )
  if (rows.length === 0) return 0
  const exemptSessions = await revocationExemptSessions(client, zoneId, rows)
  const items: OutboxItem[] = []
  for (const row of rows) {
    items.push({
      topic: Topics.AgentsLifecycle,
      dedupeKey: `terminate:${row.id}`,
      payload: {
        event: 'terminate',
        zone_id: zoneId,
        agent_session_id: row.id,
        parent_id: row.parent_id,
        reason,
      },
    })
    if (exemptSessions.has(row.subject_session_id)) continue
    items.push({
      topic: Topics.SessionsRevoke,
      dedupeKey: `agent_terminate:${row.id}`,
      payload: { zone_id: zoneId, session_id: row.subject_session_id, agent_session_id: row.id, reason },
    })
  }
  await enqueueMany(client as Queryable, items)
  return rows.length
}

// A subject session may bootstrap many agents (an application reuses its STS
// session token across spawns). Revoking it while other agents still run under
// it would sever their credential lineage, and revoking an application's own
// bootstrap session would invalidate a credential the application can simply
// re-mint, breaking unrelated in-flight calls for no security gain. Revocation
// therefore skips sessions that still have live referents and application-type
// sessions entirely.
async function revocationExemptSessions(
  client: PoolClient,
  zoneId: string,
  affected: Array<{ id: string; subject_session_id: string }>,
): Promise<Set<string>> {
  const sessionIds = [...new Set(affected.map((row) => row.subject_session_id))]
  const affectedIds = affected.map((row) => row.id)
  const { rows } = await client.query<{ subject_session_id: string }>(
    `SELECT DISTINCT subject_session_id FROM agent_sessions
     WHERE zone_id = $1
       AND subject_session_id = ANY($2::text[])
       AND id <> ALL($3::text[])
       AND status IN ('active', 'suspended')
     UNION
     SELECT id AS subject_session_id FROM sessions
     WHERE zone_id = $1
       AND id = ANY($2::text[])
       AND session_type = 'application'`,
    [zoneId, sessionIds, affectedIds],
  )
  return new Set(rows.map((row) => row.subject_session_id))
}
