// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Delegation graph routes for agent-to-agent authority edges.

import type { FastifyPluginAsync } from 'fastify'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { enqueue, enqueueMany, Topics, type OutboxItem, type Queryable } from '../outbox.js'
import { ownsApplication, requireScope } from '../auth.js'
import { MAX_DEPTH, terminateSubtree } from './agents.js'

const LIST_DEFAULT_LIMIT = 100
const LIST_MAX_LIMIT = 500

const DelegationBody = z.object({
  source_session_id: z.string().min(1),
  target_session_id: z.string().min(1),
  issuer_application_id: z.string().min(1),
  receiver_application_id: z.string().min(1),
  resource_id: z.string().min(1).nullable().default(null),
  scopes: z.array(z.string().min(1)).default([]),
  constraints_json: z.record(z.unknown()).default({}),
  expires_at: z.string().datetime(),
})

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(LIST_MAX_LIMIT).default(LIST_DEFAULT_LIMIT),
  cursor: z.string().min(1).optional(),
})

export const delegationsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/zones/:zoneId/delegations', async (req, reply) => {
    const { zoneId } = req.params as { zoneId: string }
    const body = DelegationBody.parse(req.body)
    if (!ownsApplication(req, body.issuer_application_id)
      && !requireScope(req, `coordinator.delegate_from:${body.issuer_application_id}`)) {
      return reply.code(403).send({ error: 'issuer_ownership_required' })
    }
    if (body.receiver_application_id !== body.issuer_application_id
      && !ownsApplication(req, body.receiver_application_id)
      && !requireScope(req, `coordinator.delegate_to:${body.receiver_application_id}`)
      && !requireScope(req, 'coordinator.admin')) {
      return reply.code(403).send({ error: 'receiver_consent_required' })
    }
    if (body.source_session_id === body.target_session_id) {
      return reply.code(400).send({ error: 'self_delegation_denied' })
    }
    if (new Date(body.expires_at).getTime() <= Date.now()) {
      return reply.code(400).send({ error: 'delegation_expired' })
    }
    const maxHops = body.constraints_json?.max_hops
    if (maxHops !== undefined && (typeof maxHops !== 'number' || maxHops <= 0)) {
      return reply.code(400).send({ error: 'invalid_max_hops' })
    }
    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`delegation:${zoneId}`])
      const endpoints = await activeAgentEndpoints(
        client, zoneId, body.source_session_id, body.target_session_id,
      )
      if (!endpoints.source || !endpoints.target) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'delegation_endpoint_not_found' })
      }
      if (endpoints.source.application_id !== body.issuer_application_id
        || endpoints.target.application_id !== body.receiver_application_id) {
        await client.query('ROLLBACK')
        return reply.code(409).send({ error: 'delegation_application_mismatch' })
      }
      if (body.resource_id) {
        const resource = await getResource(client, zoneId, body.resource_id)
        if (!resource) {
          await client.query('ROLLBACK')
          return reply.code(404).send({ error: 'resource_not_found' })
        }
        if (resource.application_id !== body.issuer_application_id) {
          await client.query('ROLLBACK')
          return reply.code(403).send({ error: 'resource_ownership_required' })
        }
        if (!scopesAllowed(body.scopes, resource.scopes)) {
          await client.query('ROLLBACK')
          return reply.code(403).send({ error: 'delegation_scopes_exceed_resource' })
        }
      }
      if (await wouldCreateCycle(client, zoneId, body.source_session_id, body.target_session_id)) {
        await client.query('ROLLBACK')
        return reply.code(409).send({ error: 'delegation_cycle_denied' })
      }

      const edgeId = uuidv7()
      const { rows } = await client.query(
        `INSERT INTO delegation_edges
         (id, zone_id, source_session_id, target_session_id, issuer_application_id, receiver_application_id,
          resource_id, scopes, constraints_json, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id, zone_id, source_session_id, target_session_id, issuer_application_id, receiver_application_id,
                   resource_id, scopes, constraints_json, status, expires_at, edge_version, revoked_at, created_at`,
        [
          edgeId,
          zoneId,
          body.source_session_id,
          body.target_session_id,
          body.issuer_application_id,
          body.receiver_application_id,
          body.resource_id,
          body.scopes,
          body.constraints_json,
          body.expires_at,
        ],
      )
      const epoch = await bumpEpoch(client, zoneId)
      await enqueue(client, Topics.DelegationsInvalidate, `edge_create:${edgeId}`, {
        event: 'edge_create',
        zone_id: zoneId,
        edge_id: edgeId,
        source_session_id: body.source_session_id,
        target_session_id: body.target_session_id,
        epoch,
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

  fastify.get('/zones/:zoneId/delegations/inbound/:sessionId', async (req, reply) => {
    const { zoneId, sessionId } = req.params as { zoneId: string; sessionId: string }
    return listEdges(fastify.db, reply, zoneId, 'target_session_id', sessionId, req.query)
  })

  fastify.get('/zones/:zoneId/delegations/outbound/:sessionId', async (req, reply) => {
    const { zoneId, sessionId } = req.params as { zoneId: string; sessionId: string }
    return listEdges(fastify.db, reply, zoneId, 'source_session_id', sessionId, req.query)
  })

  fastify.get('/zones/:zoneId/delegations/:id/traverse', async (req) => {
    const { zoneId, id } = req.params as { zoneId: string; id: string }
    const { rows } = await fastify.db.query(
      `WITH RECURSIVE graph AS (
         SELECT id, source_session_id, target_session_id, 1 AS depth, ARRAY[id] AS visited
         FROM delegation_edges
         WHERE id = $1 AND zone_id = $2 AND status = 'active' AND expires_at > now()
         UNION ALL
         SELECT e.id, e.source_session_id, e.target_session_id, g.depth + 1, g.visited || e.id
         FROM delegation_edges e
         JOIN graph g ON e.source_session_id = g.target_session_id
         WHERE e.zone_id = $2
           AND e.status = 'active'
           AND e.expires_at > now()
           AND NOT e.id = ANY(g.visited)
           AND g.depth < $3
       )
       SELECT id, source_session_id, target_session_id, depth FROM graph ORDER BY depth, id`,
      [id, zoneId, MAX_DEPTH],
    )
    return rows
  })

  fastify.patch('/zones/:zoneId/delegations/:id/revoke', async (req, reply) => {
    const { zoneId, id } = req.params as { zoneId: string; id: string }
    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`delegation:${zoneId}`])
      const { rows: edge } = await client.query<{ issuer_application_id: string }>(
        `SELECT issuer_application_id FROM delegation_edges
         WHERE id = $1 AND zone_id = $2 FOR UPDATE`,
        [id, zoneId],
      )
      if (!edge[0]) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'delegation_not_found' })
      }
      if (!ownsApplication(req, edge[0].issuer_application_id)
        && !requireScope(req, `coordinator.delegate_from:${edge[0].issuer_application_id}`)
        && !requireScope(req, 'coordinator.admin')) {
        await client.query('ROLLBACK')
        return reply.code(403).send({ error: 'issuer_ownership_required' })
      }
      const { rows: revoked } = await client.query<{ id: string; target_session_id: string }>(
        `WITH RECURSIVE affected AS (
           SELECT id, target_session_id, ARRAY[id] AS visited
           FROM delegation_edges
           WHERE id = $1 AND zone_id = $2 AND status = 'active'
           UNION ALL
           SELECT e.id, e.target_session_id, a.visited || e.id
           FROM delegation_edges e
           JOIN affected a ON e.source_session_id = a.target_session_id
           WHERE e.zone_id = $2
             AND e.status = 'active'
             AND NOT e.id = ANY(a.visited)
             AND cardinality(a.visited) < $3
         )
         UPDATE delegation_edges d
         SET status = 'revoked', revoked_at = now(),
             edge_version = edge_version + 1, updated_at = now()
         FROM affected a
         WHERE d.id = a.id
         RETURNING d.id, d.target_session_id`,
        [id, zoneId, MAX_DEPTH],
      )
      if (revoked.length === 0) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'delegation_not_found' })
      }
      const targetIds = [...new Set(revoked.map((row) => row.target_session_id))]
      const { rows: targets } = await client.query<{
        id: string; session_sid: string; parent_id: string | null
      }>(
        `SELECT id, session_sid, parent_id FROM agent_sessions
         WHERE id = ANY($1::text[]) AND zone_id = $2
           AND status IN ('active','suspended')`,
        [targetIds, zoneId],
      )
      const terminated = await terminateSubtree(client, zoneId,
        targets.map((row) => row.id), 'delegation_revoked')
      const epoch = await bumpEpoch(client, zoneId)
      await enqueue(client, Topics.DelegationsInvalidate, `edge_revoke:${id}`, {
        event: 'edge_revoke', zone_id: zoneId, edge_id: id,
        affected_edges: revoked.length, epoch,
      })
      const sessionItems: OutboxItem[] = []
      const seenSids = new Set<string>()
      for (const row of targets) {
        if (seenSids.has(row.session_sid)) continue
        seenSids.add(row.session_sid)
        sessionItems.push({
          topic: Topics.SessionsRevoke,
          dedupeKey: `delegation:${id}:sid:${row.session_sid}`,
          payload: { zone_id: zoneId, session_id: row.session_sid, reason: 'delegation_revoked' },
        })
      }
      await enqueueMany(client, sessionItems)
      await client.query('COMMIT')
      return {
        revoked_edges: revoked.length,
        affected_sessions: seenSids.size,
        terminated_agents: terminated,
      }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })
}

const EDGE_LIST_FIELDS = {
  source_session_id: 'source_session_id',
  target_session_id: 'target_session_id',
} as const

async function listEdges(
  db: Pool,
  reply: import('fastify').FastifyReply,
  zoneId: string,
  field: keyof typeof EDGE_LIST_FIELDS,
  sessionId: string,
  rawQuery: unknown,
): Promise<unknown> {
  const parsed = ListQuery.safeParse(rawQuery)
  if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' })
  const column = EDGE_LIST_FIELDS[field]
  const { limit, cursor } = parsed.data
  if (cursor) {
    const { rows: probe } = await db.query(
      `SELECT 1 FROM delegation_edges WHERE id = $1 AND zone_id = $2`,
      [cursor, zoneId],
    )
    if (!probe[0]) return reply.code(400).send({ error: 'invalid_cursor' })
  }
  const params: unknown[] = [zoneId, sessionId, limit]
  let cursorClause = ''
  if (cursor) {
    params.push(cursor)
    cursorClause = `AND id < $4`
  }
  const { rows } = await db.query(
    `SELECT id, zone_id, source_session_id, target_session_id, issuer_application_id, receiver_application_id,
            resource_id, scopes, constraints_json, status, expires_at, edge_version, revoked_at, created_at
     FROM delegation_edges
     WHERE zone_id = $1 AND ${column} = $2 ${cursorClause}
     ORDER BY id DESC LIMIT $3`,
    params,
  )
  const nextCursor = rows.length === limit ? rows[rows.length - 1].id : null
  return { items: rows, next_cursor: nextCursor }
}

async function activeAgentEndpoints(
  db: Queryable,
  zoneId: string,
  sourceId: string,
  targetId: string,
): Promise<{
  source?: { id: string; application_id: string }
  target?: { id: string; application_id: string }
}> {
  const { rows } = await db.query(
    `SELECT id, application_id
     FROM agent_sessions
     WHERE zone_id = $1
       AND id = ANY($2::text[])
       AND status = 'active'
       AND ttl_seconds IS NOT NULL
       AND spawned_at + (ttl_seconds * interval '1 second') > now()
     FOR SHARE`,
    [zoneId, [sourceId, targetId]],
  )
  const endpoints: {
    source?: { id: string; application_id: string }
    target?: { id: string; application_id: string }
  } = {}
  for (const row of rows as Array<{ id: string; application_id: string }>) {
    if (row.id === sourceId) endpoints.source = row
    if (row.id === targetId) endpoints.target = row
  }
  return endpoints
}

async function getResource(
  db: Queryable, zoneId: string, resourceId: string,
): Promise<{ application_id: string; scopes: string[] } | null> {
  const { rows } = await db.query(
    `SELECT application_id, scopes FROM resources WHERE id = $1 AND zone_id = $2`,
    [resourceId, zoneId],
  )
  return rows[0] ?? null
}

function scopesAllowed(requested: string[], available: string[]): boolean {
  const allowed = new Set(available)
  return requested.every((scope) => allowed.has(scope))
}

async function wouldCreateCycle(
  db: Queryable, zoneId: string, sourceId: string, targetId: string,
): Promise<boolean> {
  const { rows } = await db.query(
    `WITH RECURSIVE path AS (
       SELECT target_session_id, ARRAY[id] AS visited
       FROM delegation_edges
       WHERE zone_id = $1 AND source_session_id = $2 AND status = 'active' AND expires_at > now()
       UNION ALL
       SELECT e.target_session_id, p.visited || e.id
       FROM delegation_edges e
       JOIN path p ON e.source_session_id = p.target_session_id
       WHERE e.zone_id = $1
         AND e.status = 'active'
         AND e.expires_at > now()
         AND NOT e.id = ANY(p.visited)
         AND cardinality(p.visited) < $4
     )
     SELECT 1 FROM path WHERE target_session_id = $3 LIMIT 1`,
    [zoneId, targetId, sourceId, MAX_DEPTH],
  )
  return rows.length > 0
}

async function bumpEpoch(db: PoolClient, zoneId: string): Promise<number> {
  const { rows } = await db.query<{ epoch: string }>(
    `INSERT INTO delegation_graph_epochs (zone_id, epoch, updated_at)
     VALUES ($1, 1, now())
     ON CONFLICT (zone_id) DO UPDATE
     SET epoch = delegation_graph_epochs.epoch + 1, updated_at = now()
     RETURNING epoch`,
    [zoneId],
  )
  return Number(rows[0].epoch)
}
