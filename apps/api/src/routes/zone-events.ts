// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Zone audit and session read routes for management clients.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

const AuditQuery = z.object({
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  request_id: z.string().min(1).optional(),
  decision: z.enum(['allow', 'deny', 'partial']).optional(),
  event_type: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
})

const SessionQuery = z.object({
  status: z.enum(['active', 'revoked', 'expired']).optional(),
  subject_id: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
})

export const zoneEventsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones/:zoneId/audit', async (req, reply) => {
    const { zoneId } = req.params as { zoneId: string }
    const parsed = AuditQuery.safeParse(req.query ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' })
    const q = parsed.data

    const conds = ['zone_id = $1']
    const params: (string | number)[] = [zoneId]
    if (q.since) { params.push(q.since); conds.push(`occurred_at >= $${params.length}`) }
    if (q.until) { params.push(q.until); conds.push(`occurred_at < $${params.length}`) }
    if (q.request_id) { params.push(q.request_id); conds.push(`request_id = $${params.length}`) }
    if (q.decision) { params.push(q.decision); conds.push(`decision = $${params.length}`) }
    if (q.event_type) { params.push(q.event_type); conds.push(`event_type = $${params.length}`) }
    params.push(q.limit)

    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, event_type, request_id, decision, evaluation_status,
              metadata_json, occurred_at, ingested_at
       FROM audit_events
       WHERE ${conds.join(' AND ')}
       ORDER BY occurred_at DESC
       LIMIT $${params.length}`,
      params,
    )
    return rows
  })

  fastify.get('/zones/:zoneId/audit/by-request/:requestId', async (req, reply) => {
    const { zoneId, requestId } = req.params as { zoneId: string; requestId: string }
    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, event_type, request_id, decision, policy_set_id,
              policy_set_version_id, manifest_sha, evaluation_status,
              determining_policies_json, diagnostics_json, metadata_json,
              occurred_at, ingested_at
       FROM audit_events
       WHERE zone_id = $1 AND request_id = $2
       ORDER BY occurred_at ASC`,
      [zoneId, requestId],
    )
    if (rows.length === 0) return reply.code(404).send({ error: 'request_not_found' })
    return rows
  })

  fastify.get('/zones/:zoneId/sessions', async (req, reply) => {
    const { zoneId } = req.params as { zoneId: string }
    const parsed = SessionQuery.safeParse(req.query ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' })
    const q = parsed.data

    const conds = ['zone_id = $1']
    const params: (string | number)[] = [zoneId]
    if (q.status) { params.push(q.status); conds.push(`status = $${params.length}`) }
    if (q.subject_id) { params.push(q.subject_id); conds.push(`subject_id = $${params.length}`) }
    params.push(q.limit)

    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, session_type, subject_id, parent_id, status, expires_at,
              authenticated_at, created_at
       FROM sessions
       WHERE ${conds.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params,
    )
    return rows
  })
}
