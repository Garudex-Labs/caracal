// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Zone audit and session read routes for management clients.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { ZoneParams, parseParams } from './params.js'
import { redactSensitive } from '../redact.js'

const Cursor = z.object({ ts: z.string().min(1), id: z.string().min(1) })

function decodeCursor(raw: string): { ts: string; id: string } | null {
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8')
    const parsed = Cursor.safeParse(JSON.parse(json))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function encodeCursor(ts: string, id: string): string {
  return Buffer.from(JSON.stringify({ ts, id }), 'utf8').toString('base64url')
}

const AuditQuery = z.object({
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  request_id: z.string().min(1).optional(),
  decision: z.enum(['allow', 'deny', 'partial']).optional(),
  event_type: z.string().min(1).optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
})

const SessionQuery = z.object({
  status: z.enum(['active', 'revoked', 'expired']).optional(),
  subject_id: z.string().min(1).optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
})

const ZoneRequestParams = ZoneParams.extend({ requestId: z.string().regex(/^[A-Za-z0-9_.\-:]{1,128}$/) })

export const zoneEventsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones/:zoneId/audit', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const parsed = AuditQuery.safeParse(req.query ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' })
    const q = parsed.data

    const conds = ['zone_id = $1']
    const values: (string | number)[] = [params.zoneId]
    if (q.since) { values.push(q.since); conds.push(`occurred_at >= $${values.length}`) }
    if (q.until) { values.push(q.until); conds.push(`occurred_at < $${values.length}`) }
    if (q.request_id) { values.push(q.request_id); conds.push(`request_id = $${values.length}`) }
    if (q.decision) { values.push(q.decision); conds.push(`decision = $${values.length}`) }
    if (q.event_type) { values.push(q.event_type); conds.push(`event_type = $${values.length}`) }

    const cursor = q.cursor ? decodeCursor(q.cursor) : null
    if (q.cursor && !cursor) return reply.code(400).send({ error: 'invalid_cursor' })
    if (cursor) {
      values.push(cursor.ts)
      values.push(cursor.id)
      conds.push(`(occurred_at, id) < ($${values.length - 1}, $${values.length})`)
    }
    values.push(q.limit)

    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, event_type, request_id, decision, evaluation_status,
              metadata_json, occurred_at, ingested_at
       FROM audit_events
       WHERE ${conds.join(' AND ')}
       ORDER BY occurred_at DESC, id DESC
       LIMIT $${values.length}`,
      values,
    )

    const redacted = rows.map((r) => ({ ...r, metadata_json: redactSensitive(r.metadata_json) }))
    const last = redacted[redacted.length - 1]
    const next = redacted.length === q.limit && last
      ? encodeCursor(new Date(last.occurred_at).toISOString(), last.id)
      : null
    return { rows: redacted, next_cursor: next }
  })

  fastify.get('/zones/:zoneId/audit/by-request/:requestId', async (req, reply) => {
    const params = parseParams(ZoneRequestParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, event_type, request_id, decision, policy_set_id,
              policy_set_version_id, manifest_sha, evaluation_status,
              determining_policies_json, diagnostics_json, metadata_json,
              occurred_at, ingested_at
       FROM audit_events
       WHERE zone_id = $1 AND request_id = $2
       ORDER BY occurred_at ASC`,
      [params.zoneId, params.requestId],
    )
    if (rows.length === 0) return reply.code(404).send({ error: 'request_not_found' })
    return rows.map((r) => ({ ...r, metadata_json: redactSensitive(r.metadata_json) }))
  })

  fastify.get('/zones/:zoneId/audit/by-request/:requestId/explain', async (req, reply) => {
    const params = parseParams(ZoneRequestParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, event_type, request_id, decision, policy_set_id,
              policy_set_version_id, manifest_sha, evaluation_status,
              determining_policies_json, diagnostics_json, metadata_json,
              occurred_at, ingested_at
       FROM audit_events
       WHERE zone_id = $1 AND request_id = $2
       ORDER BY occurred_at ASC`,
      [params.zoneId, params.requestId],
    )
    if (rows.length === 0) return reply.code(404).send({ error: 'request_not_found' })
    const events = rows.map((r) => ({ ...r, metadata_json: redactSensitive(r.metadata_json) }))
    return {
      request_id: params.requestId,
      zone_id: params.zoneId,
      final_decision: events.some((event) => event.decision === 'deny') ? 'deny' : events.at(-1)?.decision ?? 'unknown',
      denied: events.filter((event) => event.decision === 'deny').map((event) => ({
        event_id: event.id,
        event_type: event.event_type,
        evaluation_status: event.evaluation_status,
        determining_policies: event.determining_policies_json ?? [],
        diagnostics: event.diagnostics_json ?? [],
        metadata: event.metadata_json ?? {},
      })),
      events,
    }
  })

  fastify.get('/zones/:zoneId/sessions', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const parsed = SessionQuery.safeParse(req.query ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' })
    const q = parsed.data

    const conds = ['zone_id = $1']
    const values: (string | number)[] = [params.zoneId]
    if (q.status) { values.push(q.status); conds.push(`status = $${values.length}`) }
    if (q.subject_id) { values.push(q.subject_id); conds.push(`subject_id = $${values.length}`) }

    const cursor = q.cursor ? decodeCursor(q.cursor) : null
    if (q.cursor && !cursor) return reply.code(400).send({ error: 'invalid_cursor' })
    if (cursor) {
      values.push(cursor.ts)
      values.push(cursor.id)
      conds.push(`(created_at, id) < ($${values.length - 1}, $${values.length})`)
    }
    values.push(q.limit)

    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, session_type, subject_id, parent_id, status, expires_at,
              authenticated_at, created_at
       FROM sessions
       WHERE ${conds.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT $${values.length}`,
      values,
    )
    const last = rows[rows.length - 1]
    const next = rows.length === q.limit && last
      ? encodeCursor(new Date(last.created_at).toISOString(), last.id)
      : null
    return { rows, next_cursor: next }
  })
}
