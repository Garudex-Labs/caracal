// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Delegation graph routes for agent-to-agent authority edges.

import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { scopesAllowed } from '@caracalai/core'
import { enqueue, enqueueMany, Topics, type OutboxItem, type Queryable } from '../outbox.js'
import { ownsApplication, requireScope } from '../auth.js'
import { bumpDelegationEpoch } from '../delegationEpochs.js'
import { MAX_DEPTH, terminateSubtree } from './agents.js'
import { ZoneIdParams, ZoneParams, ZoneSessionParams, parseParams } from './params.js'

const LIST_DEFAULT_LIMIT = 100
const LIST_MAX_LIMIT = 500

const ConstraintBody = z.object({
  resources: z.array(z.string().min(1)).max(64).optional(),
  max_depth: z.number().int().min(1).max(MAX_DEPTH).optional(),
  max_hops: z.number().int().min(1).max(MAX_DEPTH).optional(),
  ttl_seconds: z.number().int().min(1).max(86400).optional(),
  budget: z.number().int().min(1).max(1024).optional(),
  policy_approved: z.boolean().optional(),
  expires_at: z.string().datetime().optional(),
  broad_reason: z.string().min(1).max(256).optional(),
}).strict()

type DelegationConstraints = z.infer<typeof ConstraintBody>

interface ResourceAuthority {
  id: string
  identifier: string
  application_id: string | null
  scopes: string[]
}

interface ParentDelegationEdge {
  id: string
  resource_id: string | null
  resource_identifier: string | null
  scopes: string[]
  constraints_json: Record<string, unknown>
  expires_at: string
}

const DelegationBody = z.object({
  source_session_id: z.string().min(1),
  target_session_id: z.string().min(1),
  issuer_application_id: z.string().min(1),
  receiver_application_id: z.string().min(1),
  parent_edge_id: z.string().min(1).optional(),
  resource_id: z.string().min(1).nullable().default(null),
  scopes: z.array(z.string().min(1)).default([]),
  constraints: z.unknown().optional(),
  constraints_json: z.unknown().optional(),
  expires_at: z.string().datetime().optional(),
  ttl_seconds: z.number().int().min(1).max(86400).optional(),
})

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(LIST_MAX_LIMIT).default(LIST_DEFAULT_LIMIT),
  cursor: z.string().min(1).optional(),
})

export const delegationsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/zones/:zoneId/delegations', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const { zoneId } = params
    const body = DelegationBody.parse(req.body)
    const constraintsResult = normalizedConstraints(body.constraints_json, body.constraints, body.ttl_seconds)
    if (!constraintsResult.ok) return reply.code(400).send({ error: constraintsResult.error })
    const constraints = constraintsResult.constraints
    const requestedExpiresAt = body.expires_at
      ?? (typeof constraints.expires_at === 'string' ? constraints.expires_at : undefined)
    const ttlSeconds = requestedExpiresAt ? null : constraints.ttl_seconds ?? null
    if (!requestedExpiresAt && ttlSeconds === null) {
      return reply.code(400).send({ error: 'delegation_expiry_required' })
    }
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
    const resourceScoped = body.resource_id !== null || (constraints.resources?.length ?? 0) > 0
    const warnings = resourceScoped
      ? []
      : ['resource_null_delegation_broadens_resource_matching']
    if (!resourceScoped
      && !requireScope(req, 'coordinator.admin')
      && !requireScope(req, 'coordinator.delegate_broad')
      && !requireScope(req, `coordinator.delegate_broad:${body.issuer_application_id}`)) {
      return reply.code(403).send({ error: 'broad_delegation_permission_required' })
    }
    if (!resourceScoped) {
      constraints.broad_reason ??= 'resource_null_delegation'
      constraints.policy_approved = true
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
      const resources = await resolveResourceAuthority(client, zoneId, body.resource_id, constraints.resources ?? [])
      if (resources.error) {
        await client.query('ROLLBACK')
        return reply.code(resources.status).send({ error: resources.error })
      }
      for (const resource of resources.items) {
        if (resource.application_id !== body.issuer_application_id) {
          await client.query('ROLLBACK')
          return reply.code(403).send({ error: 'resource_ownership_required' })
        }
      }
      // Scopes are validated against the union of the constrained resources:
      // the STS narrows to each resource's own scopes at mandate minting.
      if (resources.items.length > 0) {
        const available = [...new Set(resources.items.flatMap((resource) => resource.scopes))]
        if (!scopesAllowed(body.scopes, available)) {
          await client.query('ROLLBACK')
          return reply.code(403).send({ error: 'delegation_scopes_exceed_resource' })
        }
      }
      const parents = await activeParentDelegations(client, zoneId, body.source_session_id)
      let parentEdgeId: string | null = null
      if (parents.length > 0) {
        const parent = body.parent_edge_id
          ? parents.find((item) => item.id === body.parent_edge_id)
          : parents.length === 1 ? parents[0] : undefined
        if (!parent) {
          await client.query('ROLLBACK')
          return reply.code(body.parent_edge_id ? 403 : 409).send({
            error: body.parent_edge_id ? 'parent_delegation_not_active' : 'parent_delegation_ambiguous',
          })
        }
        if (!parentAllowsDelegation(parent, body, constraints, resources.items, requestedExpiresAt)) {
          await client.query('ROLLBACK')
          return reply.code(403).send({ error: 'delegation_exceeds_parent_authority' })
        }
        parentEdgeId = parent.id
      }
      if (await wouldCreateCycle(client, zoneId, body.source_session_id, body.target_session_id)) {
        await client.query('ROLLBACK')
        return reply.code(409).send({ error: 'delegation_cycle_denied' })
      }

      const edgeId = uuidv7()
      const { rows } = await client.query(
        `WITH expiry AS (
           SELECT COALESCE($11::timestamptz, now() + ($12::int * interval '1 second')) AS expires_at
         )
         INSERT INTO delegation_edges
          (id, zone_id, source_session_id, target_session_id, issuer_application_id, receiver_application_id,
           parent_edge_id, resource_id, scopes, constraints_json, expires_at)
          SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,expiry.expires_at
          FROM expiry
          WHERE expiry.expires_at > now()
            AND (
              $7::text IS NULL
              OR expiry.expires_at <= (
                SELECT expires_at FROM delegation_edges WHERE id = $7 AND zone_id = $2
              )
            )
          RETURNING id AS delegation_edge_id, zone_id, source_session_id, target_session_id, issuer_application_id, receiver_application_id,
                    parent_edge_id, resource_id, scopes, constraints_json, status, expires_at, edge_version, revoked_at, created_at`,
        [
          edgeId,
          zoneId,
          body.source_session_id,
          body.target_session_id,
          body.issuer_application_id,
          body.receiver_application_id,
          parentEdgeId,
          body.resource_id,
          body.scopes,
          constraints,
          requestedExpiresAt ?? null,
          ttlSeconds,
        ],
      )
      if (!rows[0]) {
        await client.query('ROLLBACK')
        return reply.code(parentEdgeId ? 403 : 400).send({
          error: parentEdgeId ? 'delegation_exceeds_parent_authority' : 'delegation_expired',
        })
      }
      const insertedExpiresAt = rows[0].expires_at instanceof Date
        ? rows[0].expires_at.toISOString()
        : String(rows[0].expires_at)
      const epoch = await bumpDelegationEpoch(client, zoneId)
      await enqueue(client, Topics.DelegationsInvalidate, `edge_create:${edgeId}`, {
        event: 'edge_create',
        zone_id: zoneId,
        edge_id: edgeId,
        source_session_id: body.source_session_id,
        target_session_id: body.target_session_id,
        epoch,
      })
      await client.query('COMMIT')
      return reply.code(201).send({
        ...rows[0],
        warnings,
        allow_reason: [
          'same_zone_endpoints_active',
          resourceScoped ? 'resource_scope_checked' : 'broad_delegation_elevated',
          parentEdgeId ? 'parent_authority_narrowed' : 'source_authority_root',
          'typed_constraints_validated',
        ],
        effective_authority: effectiveAuthority(body, constraints, resources.items, insertedExpiresAt, parents, parentEdgeId),
      })
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  fastify.get('/zones/:zoneId/delegations/inbound/:sessionId', async (req, reply) => {
    const params = parseParams(ZoneSessionParams, req, reply)
    if (!params) return
    const { zoneId, sessionId } = params
    return listEdges(fastify.db, reply, zoneId, 'target_session_id', sessionId, req.query)
  })

  fastify.get('/zones/:zoneId/delegations/active', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const query = ListQuery.safeParse(req.query)
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' })
    const { zoneId } = params
    const { limit, cursor } = query.data
    const values: unknown[] = [zoneId, limit]
    let cursorClause = ''
    if (cursor) {
      const { rows: probe } = await fastify.db.query(
        `SELECT 1 FROM delegation_edges WHERE id = $1 AND zone_id = $2`,
        [cursor, zoneId],
      )
      if (!probe[0]) return reply.code(400).send({ error: 'invalid_cursor' })
      values.push(cursor)
      cursorClause = `AND id < $3`
    }
    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, source_session_id, target_session_id, issuer_application_id, receiver_application_id,
              parent_edge_id, resource_id, scopes, constraints_json, status, expires_at, edge_version, revoked_at, created_at,
              constraints_json->>'broad_reason' AS broad_reason
       FROM delegation_edges
       WHERE zone_id = $1 AND status = 'active' AND expires_at > now() ${cursorClause}
       ORDER BY id DESC LIMIT $2`,
      values,
    )
    return { items: rows, next_cursor: rows.length === limit ? rows[rows.length - 1].id : null }
  })

  fastify.get('/zones/:zoneId/delegations/outbound/:sessionId', async (req, reply) => {
    const params = parseParams(ZoneSessionParams, req, reply)
    if (!params) return
    const { zoneId, sessionId } = params
    return listEdges(fastify.db, reply, zoneId, 'source_session_id', sessionId, req.query)
  })

  fastify.get('/zones/:zoneId/delegations/:id/traverse', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { zoneId, id } = params
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

  fastify.get('/zones/:zoneId/delegations/:id/impact', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { zoneId, id } = params
    const { rows } = await fastify.db.query<{
      id: string
      source_session_id: string
      target_session_id: string
      depth: number
      subject_session_id: string | null
    }>(
      `WITH RECURSIVE affected AS (
         SELECT id, source_session_id, target_session_id, 1 AS depth, ARRAY[id] AS visited
         FROM delegation_edges
         WHERE id = $1 AND zone_id = $2 AND status = 'active' AND expires_at > now()
         UNION ALL
         SELECT e.id, e.source_session_id, e.target_session_id, a.depth + 1, a.visited || e.id
         FROM delegation_edges e
         JOIN affected a ON e.source_session_id = a.target_session_id
         WHERE e.zone_id = $2
           AND e.status = 'active'
           AND e.expires_at > now()
           AND NOT e.id = ANY(a.visited)
           AND a.depth < $3
       )
       SELECT a.id, a.source_session_id, a.target_session_id, a.depth, s.subject_session_id
       FROM affected a
       LEFT JOIN agent_sessions s ON s.id = a.target_session_id AND s.zone_id = $2
       ORDER BY a.depth, a.id`,
      [id, zoneId, MAX_DEPTH],
    )
    if (rows.length === 0) return reply.code(404).send({ error: 'delegation_not_found' })
    return {
      edge_id: id,
      affected_edges: rows.map(({ subject_session_id: _subjectSessionId, ...row }) => row),
      affected_agents: [...new Set(rows.map((row) => row.target_session_id))],
      affected_subject_sessions: [...new Set(rows.map((row) => row.subject_session_id).filter(Boolean))],
    }
  })

  fastify.get('/zones/:zoneId/agents/:sessionId/effective-authority', async (req, reply) => {
    const params = parseParams(ZoneSessionParams, req, reply)
    if (!params) return
    const { zoneId, sessionId } = params
    const parents = await activeParentDelegations(fastify.db, zoneId, sessionId)
    if (parents.length === 0) {
      return {
        agent_session_id: sessionId,
        inbound_edges: [],
        effective_scopes: [],
        effective_resources: [],
        effective_max_hops: 0,
        effective_ttl_seconds: null,
        earliest_expires_at: null,
      }
    }
    let scopes: Set<string> | null = null
    const resourceIds = new Set<string>()
    const resourceIdentifiers = new Set<string>()
    let resourceConstrained = false
    let maxHops = Number.POSITIVE_INFINITY
    let ttlSeconds: number | null = null
    let earliestExpiry = new Date(parents[0].expires_at).getTime()
    const considered: string[] = []
    for (const parent of parents) {
      considered.push(parent.id)
      const parsedConstraints = normalizedConstraints(parent.constraints_json, undefined, undefined)
      if (!parsedConstraints.ok) continue
      const c = parsedConstraints.constraints
      const parentScopes = new Set<string>(parent.scopes)
      if (scopes === null) {
        scopes = parentScopes
      } else {
        const intersected = new Set<string>()
        for (const s of scopes) {
          if (parentScopes.has(s)) intersected.add(s)
        }
        scopes = intersected
      }
      if (parent.resource_id) {
        resourceIds.add(parent.resource_id)
        resourceConstrained = true
      }
      if (parent.resource_identifier) {
        resourceIdentifiers.add(parent.resource_identifier)
      }
      if (c.resources && c.resources.length > 0) {
        for (const r of c.resources) resourceIdentifiers.add(r)
        resourceConstrained = true
      }
      const hops = c.max_hops ?? 1
      if (hops < maxHops) maxHops = hops
      if (c.ttl_seconds !== undefined) {
        ttlSeconds = ttlSeconds === null ? c.ttl_seconds : Math.min(ttlSeconds, c.ttl_seconds)
      }
      const expires = new Date(parent.expires_at).getTime()
      if (expires < earliestExpiry) earliestExpiry = expires
    }
    return {
      agent_session_id: sessionId,
      inbound_edges: considered,
      effective_scopes: scopes ? [...scopes].sort() : [],
      effective_resource_ids: [...resourceIds].sort(),
      effective_resources: [...resourceIdentifiers].sort(),
      effective_resource_constrained: resourceConstrained,
      effective_max_hops: maxHops === Number.POSITIVE_INFINITY ? null : maxHops,
      effective_ttl_seconds: ttlSeconds,
      earliest_expires_at: new Date(earliestExpiry).toISOString(),
    }
  })

  fastify.patch('/zones/:zoneId/delegations/:id/revoke', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { zoneId, id } = params
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
        id: string; subject_session_id: string; parent_id: string | null
      }>(
        `SELECT id, subject_session_id, parent_id FROM agent_sessions
         WHERE id = ANY($1::text[]) AND zone_id = $2
           AND status IN ('active','suspended')`,
        [targetIds, zoneId],
      )
      const terminated = await terminateSubtree(client, zoneId,
        targets.map((row) => row.id), 'delegation_revoked')
      const epoch = await bumpDelegationEpoch(client, zoneId)
      await enqueue(client, Topics.DelegationsInvalidate, `edge_revoke:${id}`, {
        event: 'edge_revoke', zone_id: zoneId, edge_id: id,
        affected_edges: revoked.length, epoch,
      })
      const sessionItems: OutboxItem[] = []
      const seenSubjectSessionIds = new Set<string>()
      for (const row of targets) {
        if (seenSubjectSessionIds.has(row.subject_session_id)) continue
        seenSubjectSessionIds.add(row.subject_session_id)
        sessionItems.push({
          topic: Topics.SessionsRevoke,
          dedupeKey: `delegation:${id}:subject:${row.subject_session_id}`,
          payload: {
            zone_id: zoneId, session_id: row.subject_session_id,
            agent_session_id: row.id, delegation_edge_id: id, reason: 'delegation_revoked',
          },
        })
      }
      await enqueueMany(client, sessionItems)
      await client.query('COMMIT')
      return {
        revoked_edges: revoked.length,
        affected_sessions: seenSubjectSessionIds.size,
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

function normalizedConstraints(
  constraintsJson: unknown,
  constraints: unknown,
  ttlSeconds: number | undefined,
): { ok: true; constraints: DelegationConstraints } | { ok: false; error: string } {
  if ((constraintsJson !== undefined && !plainObject(constraintsJson))
    || (constraints !== undefined && !plainObject(constraints))) {
    return { ok: false, error: 'invalid_delegation_constraint' }
  }
  const out = { ...(constraintsJson ?? {}), ...(constraints ?? {}) } as Record<string, unknown>
  if (typeof out.max_depth === 'number' && out.max_hops === undefined) {
    out.max_hops = out.max_depth
  }
  if (ttlSeconds !== undefined && out.ttl_seconds === undefined) {
    out.ttl_seconds = ttlSeconds
  }
  const parsed = ConstraintBody.safeParse(out)
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path[0]
    return { ok: false, error: typeof path === 'string' ? `invalid_${path}` : 'invalid_delegation_constraint' }
  }
  if (parsed.data.max_depth !== undefined && parsed.data.max_hops !== undefined
    && parsed.data.max_depth !== parsed.data.max_hops) {
    return { ok: false, error: 'invalid_max_hops' }
  }
  return { ok: true, constraints: parsed.data }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
            parent_edge_id, resource_id, scopes, constraints_json, status, expires_at, edge_version, revoked_at, created_at
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
        AND (
          (ttl_seconds IS NOT NULL AND spawned_at + (ttl_seconds * interval '1 second') > now())
          OR (lifecycle = 'service' AND heartbeat_deadline_at IS NOT NULL AND heartbeat_deadline_at > now())
        )
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
): Promise<ResourceAuthority | null> {
  const { rows } = await db.query(
    `SELECT r.id, r.identifier, b.application_id, r.scopes
     FROM resources r
     LEFT JOIN gateway_resource_bindings b
       ON b.zone_id = r.zone_id AND b.resource_identifier = r.identifier
     WHERE r.id = $1 AND r.zone_id = $2 AND r.archived_at IS NULL`,
    [resourceId, zoneId],
  )
  return rows[0] ?? null
}

async function resolveResourceAuthority(
  db: Queryable,
  zoneId: string,
  resourceId: string | null,
  identifiers: string[],
): Promise<{ items: ResourceAuthority[]; error?: string; status: number }> {
  const resources = new Map<string, ResourceAuthority>()
  if (resourceId) {
    const resource = await getResource(db, zoneId, resourceId)
    if (!resource) return { items: [], error: 'resource_not_found', status: 404 }
    resources.set(resource.id, resource)
  }
  if (identifiers.length > 0) {
    const uniqueIdentifiers = [...new Set(identifiers)]
    const { rows } = await db.query<ResourceAuthority>(
      `SELECT r.id, r.identifier, b.application_id, r.scopes
       FROM resources r
       LEFT JOIN gateway_resource_bindings b
         ON b.zone_id = r.zone_id AND b.resource_identifier = r.identifier
       WHERE r.zone_id = $1
         AND r.identifier = ANY($2::text[])
         AND r.archived_at IS NULL`,
      [zoneId, uniqueIdentifiers],
    )
    if (rows.length !== uniqueIdentifiers.length) {
      return { items: [], error: 'resource_not_found', status: 404 }
    }
    for (const row of rows) resources.set(row.id, row)
    if (resourceId && !rows.some((row) => row.id === resourceId)) {
      return { items: [], error: 'delegation_resource_scope_mismatch', status: 400 }
    }
  }
  return { items: [...resources.values()], status: 200 }
}

async function activeParentDelegations(
  db: Queryable,
  zoneId: string,
  targetSessionId: string,
): Promise<ParentDelegationEdge[]> {
  const { rows } = await db.query<ParentDelegationEdge>(
    `SELECT e.id, e.resource_id, r.identifier AS resource_identifier,
            e.scopes, e.constraints_json, e.expires_at
     FROM delegation_edges e
     LEFT JOIN resources r ON r.id = e.resource_id AND r.zone_id = e.zone_id
     WHERE e.zone_id = $1
       AND e.target_session_id = $2
       AND e.status = 'active'
       AND e.expires_at > now()`,
    [zoneId, targetSessionId],
  )
  return rows
}

function parentAllowsDelegation(
  parent: ParentDelegationEdge,
  body: z.infer<typeof DelegationBody>,
  childConstraints: DelegationConstraints,
  resources: ResourceAuthority[],
  expiresAt: string | undefined,
): boolean {
  const parentConstraints = normalizedConstraints(parent.constraints_json, undefined, undefined)
  if (!parentConstraints.ok) return false
  const constraints = parentConstraints.constraints
  if (!scopesAllowed(body.scopes, parent.scopes)) return false
  if (expiresAt !== undefined && new Date(expiresAt).getTime() > new Date(parent.expires_at).getTime()) return false
  if (!resourcesNarrowParent(parent, constraints, body.resource_id, resources)) return false
  const parentMaxHops = constraints.max_hops ?? 1
  const childMaxHops = childConstraints.max_hops ?? 1
  if (parentMaxHops <= 1 || childMaxHops > parentMaxHops - 1) return false
  if (constraints.ttl_seconds !== undefined) {
    const childTTL = childConstraints.ttl_seconds
    if (childTTL === undefined || childTTL > constraints.ttl_seconds) return false
  }
  if (constraints.budget !== undefined) {
    const childBudget = childConstraints.budget ?? body.scopes.length
    if (childBudget > constraints.budget) return false
  }
  return true
}

function resourcesNarrowParent(
  parent: ParentDelegationEdge,
  parentConstraints: DelegationConstraints,
  childResourceId: string | null,
  childResources: ResourceAuthority[],
): boolean {
  const parentIdentifiers = new Set(parentConstraints.resources ?? [])
  if (parent.resource_id) {
    if (childResourceId === parent.resource_id) return true
    return childResources.length > 0
      && childResources.every((resource) => resource.id === parent.resource_id)
  }
  if (parentIdentifiers.size > 0) {
    return childResources.length > 0
      && childResources.every((resource) => parentIdentifiers.has(resource.identifier))
  }
  return true
}

function effectiveAuthority(
  body: z.infer<typeof DelegationBody>,
  constraints: DelegationConstraints,
  resources: ResourceAuthority[],
  expiresAt: string,
  parents: ParentDelegationEdge[],
  parentEdgeId: string | null,
): Record<string, unknown> {
  return {
    source_session_id: body.source_session_id,
    target_session_id: body.target_session_id,
    parent_edge_id: parentEdgeId,
    resource_id: body.resource_id,
    resources: resources.map((resource) => resource.identifier),
    scopes: body.scopes,
    expires_at: expiresAt,
    max_hops: constraints.max_hops ?? 1,
    ttl_seconds: constraints.ttl_seconds ?? null,
    broad: body.resource_id === null && resources.length === 0,
    parent_edges_considered: parents.map((parent) => parent.id),
  }
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
