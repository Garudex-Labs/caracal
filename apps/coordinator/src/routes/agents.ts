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

export const MAX_DEPTH = 10
export const MAX_CHILDREN = 10
export const MAX_PER_ZONE = 50
export const MAX_PER_APP = 200
const DEFAULT_TTL = 3600
const LIST_DEFAULT_LIMIT = 100
const LIST_MAX_LIMIT = 500

const SpawnBody = z.object({
  application_id: z.string().min(1),
  session_sid: z.string().min(1),
  parent_id: z.string().nullable().default(null),
  capabilities: z.array(z.string()).default([]),
  ttl_seconds: z.number().int().min(1).max(86400).default(DEFAULT_TTL),
})

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(LIST_MAX_LIMIT).default(LIST_DEFAULT_LIMIT),
  cursor: z.string().min(1).optional(),
})

const TerminateQuery = z.object({
  reason: z.string().min(1).max(256).default('requested'),
})

export function spawnLockKey(zoneId: string): string {
  return `coordinator:agent_spawn:${zoneId}`
}

export const agentsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/zones/:zoneId/agents', async (req, reply) => {
    const { zoneId } = req.params as { zoneId: string }
    const body = SpawnBody.parse(req.body)
    if (!ownsApplication(req, body.application_id)
      && !requireScope(req, `coordinator.spawn_for:${body.application_id}`)) {
      return reply.code(403).send({ error: 'application_ownership_required' })
    }
    const idempotencyKey = (req.headers['idempotency-key'] as string | undefined)?.trim() || null
    const id = uuidv7()
    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext($1))`,
        [spawnLockKey(zoneId)],
      )
      if (idempotencyKey) {
        const { rows: existing } = await client.query(
          `SELECT id, zone_id, application_id, parent_id, session_sid, status, depth, spawned_at
           FROM agent_sessions
           WHERE zone_id = $1 AND application_id = $2 AND session_sid = $3
             AND COALESCE(parent_id, '') = COALESCE($4, '')
             AND status IN ('active','suspended')
           LIMIT 1`,
          [zoneId, body.application_id, body.session_sid, body.parent_id],
        )
        if (existing[0]) {
          await client.query('ROLLBACK')
          return reply.code(200).send(existing[0])
        }
      }
      const { rows: refs } = await client.query(
        `SELECT
           EXISTS (
             SELECT 1 FROM applications
             WHERE id = $2 AND zone_id = $1 AND archived_at IS NULL
               AND (expires_at IS NULL OR expires_at > now())
           ) AS application_exists,
           EXISTS (
             SELECT 1 FROM sessions
             WHERE id = $3 AND zone_id = $1 AND status = 'active' AND expires_at > now()
           ) AS session_exists`,
        [zoneId, body.application_id, body.session_sid],
      )
      if (!refs[0]?.application_exists) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'application_not_found' })
      }
      if (!refs[0].session_exists) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'session_not_found' })
      }
      const { rows: cnt } = await client.query(
        `SELECT
           COUNT(*) FILTER (WHERE application_id = $2) AS app_n,
           COUNT(*) AS zone_n
         FROM agent_sessions
         WHERE zone_id = $1 AND status IN ('active', 'suspended')`,
        [zoneId, body.application_id],
      )
      if (parseInt(cnt[0].zone_n, 10) >= MAX_PER_ZONE) {
        await client.query('ROLLBACK')
        return reply.code(429).send({ error: 'agent_zone_limit_exceeded' })
      }
      if (parseInt(cnt[0].app_n, 10) >= MAX_PER_APP) {
        await client.query('ROLLBACK')
        return reply.code(429).send({ error: 'agent_limit_exceeded' })
      }

      let depth = 0
      if (body.parent_id) {
        const { rows: parent } = await client.query(
          `SELECT depth, child_count, max_children, application_id FROM agent_sessions
           WHERE id = $1 AND zone_id = $2 AND status = 'active'
           FOR UPDATE`,
          [body.parent_id, zoneId],
        )
        if (!parent[0]) {
          await client.query('ROLLBACK')
          return reply.code(404).send({ error: 'parent_not_found' })
        }
        if (parent[0].application_id !== body.application_id
          && !requireScope(req, `coordinator.spawn_under:${parent[0].application_id}`)) {
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
      const { rows } = await client.query(
        `INSERT INTO agent_sessions
         (id, zone_id, application_id, parent_id, session_sid, depth, capabilities, max_children, ttl_seconds)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, zone_id, application_id, parent_id, session_sid, status, depth, spawned_at`,
        [id, zoneId, body.application_id, body.parent_id, body.session_sid,
          depth, body.capabilities, MAX_CHILDREN, body.ttl_seconds],
      )
      if (body.parent_id) {
        await client.query(
          `INSERT INTO agent_topology (parent_id, child_id) VALUES ($1,$2)`,
          [body.parent_id, id],
        )
        await client.query(
          `UPDATE agent_sessions SET child_count = child_count + 1 WHERE id = $1`,
          [body.parent_id],
        )
      }
      await enqueue(client, Topics.AgentsLifecycle, `spawn:${id}`, {
        event: 'spawn',
        zone_id: zoneId,
        session_id: id,
        parent_id: body.parent_id,
        application_id: body.application_id,
      })
      await client.query('COMMIT')
      return reply.code(201).send(rows[0])
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  fastify.get('/zones/:zoneId/agents', async (req, reply) => {
    const { zoneId } = req.params as { zoneId: string }
    const query = ListQuery.safeParse(req.query)
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' })
    const { limit, cursor } = query.data
    if (cursor) {
      const { rows: probe } = await fastify.db.query(
        `SELECT 1 FROM agent_sessions WHERE id = $1 AND zone_id = $2`,
        [cursor, zoneId],
      )
      if (!probe[0]) return reply.code(400).send({ error: 'invalid_cursor' })
    }
    const params: unknown[] = [zoneId, limit]
    let cursorClause = ''
    if (cursor) {
      params.push(cursor)
      cursorClause = `AND id < $3`
    }
    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, application_id, parent_id, session_sid, status, depth, spawned_at, terminated_at
       FROM agent_sessions WHERE zone_id = $1 ${cursorClause}
       ORDER BY id DESC LIMIT $2`,
      params,
    )
    const nextCursor = rows.length === limit ? rows[rows.length - 1].id : null
    return { items: rows, next_cursor: nextCursor }
  })

  fastify.get('/zones/:zoneId/agents/:id', async (req, reply) => {
    const { zoneId, id } = req.params as { zoneId: string; id: string }
    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, application_id, parent_id, session_sid, status, depth, spawned_at, terminated_at
       FROM agent_sessions WHERE id = $1 AND zone_id = $2`,
      [id, zoneId],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'agent_not_found' })
    return rows[0]
  })

  fastify.get('/zones/:zoneId/agents/:id/children', async (req) => {
    const { zoneId, id } = req.params as { zoneId: string; id: string }
    const { rows } = await fastify.db.query(
      `SELECT s.id, s.zone_id, s.application_id, s.parent_id, s.session_sid, s.status, s.depth, s.spawned_at
       FROM agent_sessions s
       JOIN agent_topology t ON t.child_id = s.id
       WHERE t.parent_id = $1 AND s.zone_id = $2
       ORDER BY s.spawned_at`,
      [id, zoneId],
    )
    return rows
  })

  fastify.patch('/zones/:zoneId/agents/:id/suspend', async (req, reply) => {
    const { zoneId, id } = req.params as { zoneId: string; id: string }
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
      if (!ownsApplication(req, own[0].application_id)
        && !requireScope(req, 'coordinator.admin')
        && !requireScope(req, `coordinator.spawn_for:${own[0].application_id}`)) {
        await client.query('ROLLBACK')
        return reply.code(403).send({ error: 'application_ownership_required' })
      }
      const { rows: changed } = await client.query<{ id: string; parent_id: string | null }>(
        `WITH RECURSIVE tree AS (
           SELECT id, parent_id FROM agent_sessions
           WHERE id = $1 AND zone_id = $2 AND status = 'active'
           UNION ALL
           SELECT s.id, s.parent_id FROM agent_sessions s
           JOIN tree t ON s.parent_id = t.id
           WHERE s.zone_id = $2 AND s.status = 'active'
         )
         UPDATE agent_sessions SET status = 'suspended', updated_at = now()
         WHERE id IN (SELECT id FROM tree) AND zone_id = $2
         RETURNING id, parent_id`,
        [id, zoneId],
      )
      if (changed.length === 0) {
        await client.query('ROLLBACK')
        return reply.code(409).send({ error: 'agent_not_found_or_not_active' })
      }
      await enqueueMany(client, changed.map((row): OutboxItem => ({
        topic: Topics.AgentsLifecycle,
        dedupeKey: `suspend:${row.id}`,
        payload: { event: 'suspend', zone_id: zoneId, session_id: row.id, parent_id: row.parent_id },
      })))
      await client.query('COMMIT')
      return { suspended: changed.length }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  fastify.patch('/zones/:zoneId/agents/:id/resume', async (req, reply) => {
    const { zoneId, id } = req.params as { zoneId: string; id: string }
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
      if (!ownsApplication(req, own[0].application_id)
        && !requireScope(req, 'coordinator.admin')
        && !requireScope(req, `coordinator.spawn_for:${own[0].application_id}`)) {
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
         UPDATE agent_sessions SET status = 'active', last_active_at = now(), updated_at = now()
         WHERE id IN (SELECT id FROM tree) AND zone_id = $2
         RETURNING id, parent_id`,
        [id, zoneId],
      )
      if (changed.length === 0) {
        await client.query('ROLLBACK')
        return reply.code(409).send({ error: 'agent_not_found_or_not_suspended' })
      }
      await enqueueMany(client, changed.map((row): OutboxItem => ({
        topic: Topics.AgentsLifecycle,
        dedupeKey: `resume:${row.id}`,
        payload: { event: 'resume', zone_id: zoneId, session_id: row.id, parent_id: row.parent_id },
      })))
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
    const { zoneId, id } = req.params as { zoneId: string; id: string }
    const query = TerminateQuery.safeParse(req.query)
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' })
    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext($1))`,
        [spawnLockKey(zoneId)],
      )
      const { rows: own } = await client.query(
        `SELECT application_id FROM agent_sessions
         WHERE id = $1 AND zone_id = $2 FOR UPDATE`,
        [id, zoneId],
      )
      if (!own[0]) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'agent_not_found' })
      }
      if (!ownsApplication(req, own[0].application_id)
        && !requireScope(req, 'coordinator.admin')
        && !requireScope(req, `coordinator.spawn_for:${own[0].application_id}`)) {
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
  session_sid: string
  parent_id: string | null
}

export async function terminateSubtree(
  client: PoolClient,
  zoneId: string,
  rootIds: string[],
  reason: string,
): Promise<number> {
  if (rootIds.length === 0) return 0
  const { rows } = await client.query<TerminatedRow>(
    `WITH RECURSIVE tree AS (
       SELECT id, session_sid, parent_id
       FROM agent_sessions
       WHERE id = ANY($1::text[]) AND zone_id = $2 AND status IN ('active','suspended')
       UNION ALL
       SELECT s.id, s.session_sid, s.parent_id
       FROM agent_sessions s
       JOIN tree t ON s.parent_id = t.id
       WHERE s.zone_id = $2 AND s.status IN ('active','suspended')
     ),
     terminated AS (
       UPDATE agent_sessions
       SET status = 'terminated', terminated_at = now(), updated_at = now()
       WHERE id IN (SELECT id FROM tree) AND zone_id = $2
       RETURNING id, session_sid, parent_id
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
     SELECT id, session_sid, parent_id FROM terminated`,
    [rootIds, zoneId],
  )
  if (rows.length === 0) return 0
  const items: OutboxItem[] = []
  for (const row of rows) {
    items.push({
      topic: Topics.SessionsRevoke,
      dedupeKey: `agent_terminate:${row.id}`,
      payload: { zone_id: zoneId, session_id: row.session_sid, reason },
    })
    items.push({
      topic: Topics.AgentsLifecycle,
      dedupeKey: `terminate:${row.id}`,
      payload: {
        event: 'terminate', zone_id: zoneId, session_id: row.id,
        parent_id: row.parent_id, reason,
      },
    })
  }
  await enqueueMany(client as Queryable, items)
  return rows.length
}
