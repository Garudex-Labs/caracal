// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Subject endpoints: per-subject aggregation over sessions plus the investigation overview.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { ZoneParams, parseParams } from './params.js'

const SUBJECT_PAGE_LIMIT = 100

const SubjectsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(SUBJECT_PAGE_LIMIT),
  cursor: z.string().max(1024).optional(),
  kind: z.enum(['user', 'application']).optional(),
  search: z.string().max(512).optional(),
})

const OverviewQuery = z.object({
  subject_id: z.string().min(1).max(512),
})

interface SubjectCursor {
  ts: string
  id: string
}

function encodeSubjectCursor(ts: string, id: string): string {
  return Buffer.from(JSON.stringify({ ts, id }), 'utf8').toString('base64url')
}

function decodeSubjectCursor(raw: string): SubjectCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as SubjectCursor
    if (typeof parsed.ts !== 'string' || typeof parsed.id !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

// One row per distinct subject: identity resolution (an application's own id renders
// as the application), standing counts the runtime rule enforces (active means
// status=active AND unexpired), and the newest recorded issuer provenance. The
// per-mint session records stay available underneath through /sessions.
const SUBJECT_AGGREGATE = `
  SELECT s.subject_id,
         BOOL_OR(s.session_type = 'user') AS federated,
         a.name AS application_name,
         COUNT(*)::int AS total_sessions,
         COUNT(*) FILTER (WHERE s.status = 'active' AND s.expires_at > now())::int AS active_sessions,
         COUNT(*) FILTER (WHERE s.status = 'revoked')::int AS revoked_sessions,
         MIN(s.authenticated_at) AS first_seen,
         MAX(s.authenticated_at) AS last_seen,
         MAX(s.revoked_at) AS last_revoked_at,
         (ARRAY_AGG(s.claims_json->>'iss' ORDER BY s.authenticated_at DESC)
            FILTER (WHERE s.claims_json->>'iss' IS NOT NULL))[1] AS issuer
  FROM sessions s
  LEFT JOIN applications a ON a.zone_id = s.zone_id AND a.id = s.subject_id`

export const subjectsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones/:zoneId/subjects', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const parsed = SubjectsQuery.safeParse(req.query ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' })
    const q = parsed.data

    const conds = ['s.zone_id = $1']
    const values: (string | number)[] = [params.zoneId]
    if (q.search) {
      values.push(`%${q.search}%`)
      conds.push(`(s.subject_id ILIKE $${values.length} OR a.name ILIKE $${values.length})`)
    }

    const having: string[] = []
    if (q.kind === 'user') having.push(`BOOL_OR(s.session_type = 'user')`)
    if (q.kind === 'application') having.push(`NOT BOOL_OR(s.session_type = 'user')`)
    const cursor = q.cursor ? decodeSubjectCursor(q.cursor) : null
    if (q.cursor && !cursor) return reply.code(400).send({ error: 'invalid_cursor' })
    if (cursor) {
      values.push(cursor.ts)
      values.push(cursor.id)
      having.push(`(MAX(s.authenticated_at), s.subject_id) < ($${values.length - 1}::timestamptz, $${values.length})`)
    }
    values.push(q.limit)

    const { rows } = await fastify.db.query<{ subject_id: string; last_seen: Date }>(
      `${SUBJECT_AGGREGATE}
       WHERE ${conds.join(' AND ')}
       GROUP BY s.subject_id, a.name
       ${having.length ? `HAVING ${having.join(' AND ')}` : ''}
       ORDER BY MAX(s.authenticated_at) DESC, s.subject_id DESC
       LIMIT $${values.length}`,
      values,
    )

    const last = rows[rows.length - 1]
    const next = rows.length === q.limit && last ? encodeSubjectCursor(new Date(last.last_seen).toISOString(), last.subject_id) : null
    return { items: rows, next_cursor: next }
  })

  // The investigation bundle for one subject: identity and standing, the governed
  // sessions that acted for it, approvals raised under it, and its upstream
  // connections. The subject identifier travels as a query parameter, never a path
  // segment, so any issuer-assigned format stays routable.
  fastify.get('/zones/:zoneId/subjects/overview', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const parsed = OverviewQuery.safeParse(req.query ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' })
    const subjectId = parsed.data.subject_id

    const [identity, governed, recentAgents, approvals, connections] = await Promise.all([
      fastify.db.query(
        `${SUBJECT_AGGREGATE}
         WHERE s.zone_id = $1 AND s.subject_id = $2
         GROUP BY s.subject_id, a.name`,
        [params.zoneId, subjectId],
      ),
      fastify.db.query(
        `SELECT COUNT(*) FILTER (WHERE ag.status IN ('active', 'suspended'))::int AS active,
                COUNT(*)::int AS total
         FROM agent_sessions ag
         JOIN sessions s ON s.id = ag.subject_session_id
         WHERE s.zone_id = $1 AND s.subject_id = $2`,
        [params.zoneId, subjectId],
      ),
      fastify.db.query(
        `SELECT ag.id, ag.application_id, ap.name AS application_name, ag.lifecycle, ag.status, ag.spawned_at
         FROM agent_sessions ag
         JOIN sessions s ON s.id = ag.subject_session_id
         LEFT JOIN applications ap ON ap.zone_id = ag.zone_id AND ap.id = ag.application_id
         WHERE s.zone_id = $1 AND s.subject_id = $2
         ORDER BY ag.spawned_at DESC
         LIMIT 5`,
        [params.zoneId, subjectId],
      ),
      fastify.db.query(
        `SELECT COUNT(*) FILTER (WHERE satisfied_at IS NULL AND rejected_at IS NULL
                                   AND consumed_at IS NULL AND expires_at > now())::int AS pending,
                COUNT(*)::int AS total
         FROM step_up_challenges
         WHERE zone_id = $1 AND principal_id = $2`,
        [params.zoneId, subjectId],
      ),
      fastify.db.query(
        `SELECT pc.id, pc.provider_id, p.name AS provider_name, pc.status, pc.expires_at, pc.created_at
         FROM provider_connections pc
         LEFT JOIN providers p ON p.zone_id = pc.zone_id AND p.id = pc.provider_id
         WHERE pc.zone_id = $1 AND pc.subject_id = $2
         ORDER BY pc.created_at DESC
         LIMIT 10`,
        [params.zoneId, subjectId],
      ),
    ])

    if (!identity.rows[0]) return reply.code(404).send({ error: 'subject_not_found' })
    return {
      subject: identity.rows[0],
      governed: { ...(governed.rows[0] ?? { active: 0, total: 0 }), recent: recentAgents.rows },
      approvals: approvals.rows[0] ?? { pending: 0, total: 0 },
      connections: connections.rows,
    }
  })
}
