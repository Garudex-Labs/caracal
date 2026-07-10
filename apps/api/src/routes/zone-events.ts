// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Zone audit, authority record, and governed session read routes for management clients.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { ZoneParams, parseParams } from './params.js'
import { redactSensitive } from '../redact.js'
import { OPA_INPUT_SCHEMA_VERSION } from '../rego.js'

// reconstructPolicyInput rebuilds a canonical OPA simulation input from the
// redaction-safe audit metadata of a denied decision, so a denied request can
// be replayed through policy-set simulation without hand-translation. Actor and
// subject claims are never stored in audit metadata; authors add them when they
// reproduce a claim-dependent denial.
function reconstructPolicyInput(zoneId: string, metadata: unknown): Record<string, unknown> {
  const meta = (metadata && typeof metadata === 'object' ? metadata : {}) as Record<string, unknown>
  const scopes = Array.isArray(meta.requested_scopes) ? (meta.requested_scopes as unknown[]) : []
  const principal: Record<string, unknown> = {
    type: 'Application',
    id: typeof meta.application_id === 'string' ? meta.application_id : '',
    zone_id: zoneId,
  }
  if (typeof meta.application_registration_method === 'string') {
    principal.registration_method = meta.application_registration_method
  }
  if (typeof meta.agent_session_id === 'string') principal.agent_session_id = meta.agent_session_id
  if (typeof meta.agent_lifecycle === 'string') principal.lifecycle = meta.agent_lifecycle
  if (Array.isArray(meta.agent_labels)) principal.labels = meta.agent_labels

  const context: Record<string, unknown> = {
    actor_claims: {},
    requested_scopes: scopes,
    challenge_resolved: false,
  }
  if (typeof meta.session_id === 'string') context.session_id = meta.session_id
  if (typeof meta.agent_session_id === 'string') context.agent_session_id = meta.agent_session_id
  if (typeof meta.delegation_edge_id === 'string') context.delegation_edge_id = meta.delegation_edge_id

  const input: Record<string, unknown> = {
    schema_version: OPA_INPUT_SCHEMA_VERSION,
    principal,
    resource: {
      type: 'Resource',
      identifier: typeof meta.resource === 'string' ? meta.resource : '',
      scopes,
    },
    action: { id: 'TokenExchange' },
    context,
  }
  if (typeof meta.session_id === 'string') input.session = { id: meta.session_id }
  if (typeof meta.delegation_edge_id === 'string') {
    input.delegation_edge = { id: meta.delegation_edge_id }
  }
  return input
}

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
  event_type: z.string().min(1).max(512).optional(),
  application_id: z.string().min(1).max(128).optional(),
  session_id: z.string().min(1).max(128).optional(),
  authority_record_id: z.string().min(1).max(128).optional(),
  label: z.string().min(1).max(64).optional(),
  format: z.enum(['json', 'csv']).default('json'),
  fields: z.string().min(1).max(1000).optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
})

// event_type accepts a single type or a comma-separated list, so one query can cover an
// audit domain (for example every step_up_* lifecycle event) without client-side merging.
function parseEventTypes(raw: string): string[] | null {
  const types = raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  return types.length > 0 && types.length <= 16 ? types : null
}

const AuthorityRecordQuery = z.object({
  authority_record_id: z.string().min(1).max(128).optional(),
  status: z.enum(['active', 'revoked', 'expired']).optional(),
  subject_id: z.string().min(1).optional(),
  format: z.enum(['json', 'csv']).default('json'),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
})

const AdminAuditQuery = z.object({
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  actor_id: z.string().min(1).max(128).optional(),
  entity_type: z.string().min(1).max(64).optional(),
  entity_id: z.string().min(1).max(128).optional(),
  method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  format: z.enum(['json', 'csv']).default('json'),
  fields: z.string().min(1).max(1000).optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
})

const SessionQuery = z.object({
  status: z.enum(['active', 'suspended', 'terminated', 'expired']).optional(),
  lifecycle: z.enum(['task', 'service']).optional(),
  application_id: z.string().min(1).optional(),
  parent_session_id: z.string().min(1).optional(),
  label: z.string().min(1).max(64).optional(),
  format: z.enum(['json', 'csv']).default('json'),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
})

const SESSION_CSV_COLUMNS = [
  'session_id',
  'application_id',
  'parent_session_id',
  'status',
  'lifecycle',
  'labels',
  'depth',
  'child_count',
  'spawned_at',
  'last_active_at',
  'terminated_at',
  'termination_reason',
  'ttl_seconds',
] as const

function toCsvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let text = value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.join(' ') : String(value)
  // Formula-injection guard: a cell starting with a formula trigger is prefixed
  // with a single quote so spreadsheet applications render it as text. Exported
  // values such as federated subject identifiers are issuer-controlled, so every
  // cell is treated as hostile.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function csvDocument(columns: readonly string[], rows: Record<string, unknown>[]): string {
  const lines = [columns.join(',')]
  for (const row of rows) {
    lines.push(columns.map((col) => toCsvCell(row[col])).join(','))
  }
  return `${lines.join('\r\n')}\r\n`
}

const AUTHORITY_RECORD_CSV_COLUMNS = [
  'authority_record_id',
  'authority_record_type',
  'subject_id',
  'parent_authority_record_id',
  'status',
  'authenticated_at',
  'created_at',
  'expires_at',
  'revoked_at',
  'revoked_reason',
] as const

const AUDIT_ROW_FIELDS = ['id', 'occurred_at', 'event_type', 'decision', 'evaluation_status', 'request_id', 'ingested_at'] as const

const AUDIT_METADATA_FIELDS = [
  'application_id',
  'application_name',
  'resource',
  'requested_scopes',
  'agent_session_id',
  'agent_lifecycle',
  'agent_labels',
  'delegation_edge_id',
  'delegation_hop_count',
  'method',
  'latency_ms',
  'upstream_status',
  'result_class',
  'reason',
  'trace_id',
  'provider_id',
  'connection_id',
  'upstream_host',
  'gateway_status',
  'error_kind',
  'response_bytes',
  'auth_mode',
  'subject_fingerprint',
  'subject',
  'authorized_by',
  'command',
  'subcommand',
  'challenge_id',
  'tier',
  'approver_class',
  'privacy_mode',
  'approver_subject_id',
] as const

const AUDIT_EXPORT_FIELDS: readonly string[] = [...AUDIT_ROW_FIELDS, ...AUDIT_METADATA_FIELDS]

const ADMIN_AUDIT_ROW_FIELDS = [
  'id',
  'occurred_at',
  'action',
  'method',
  'path',
  'entity_type',
  'entity_id',
  'status_code',
  'actor_id',
  'actor_name',
  'actor_scope',
  'request_id',
  'chain_seq',
  'signed',
] as const

const ADMIN_AUDIT_EXPORT_FIELDS: readonly string[] = [...ADMIN_AUDIT_ROW_FIELDS, 'change_kind', 'changed_fields']

// Projects an event row onto the caller-selected export fields, flattening the
// redacted JSON payload so exports carry human-usable columns instead of blobs.
function projectRow(
  row: Record<string, unknown>,
  fields: readonly string[],
  ownFields: readonly string[],
  payloadKey: string,
): Record<string, unknown> {
  const payload = row[payloadKey]
  const meta = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    out[field] = ownFields.includes(field) ? row[field] : meta[field]
  }
  return out
}

function parseFields(raw: string | undefined, allowed: readonly string[]): readonly string[] | null {
  if (!raw) return allowed
  const fields = raw
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean)
  if (fields.length === 0 || fields.some((f) => !allowed.includes(f))) return null
  return fields
}

const ZoneRequestParams = ZoneParams.extend({ requestId: z.string().regex(/^[A-Za-z0-9_.\-:]{1,128}$/) })

export const zoneEventsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones/:zoneId/audit', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const parsed = AuditQuery.safeParse(req.query ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' })
    const q = parsed.data
    const fields = parseFields(q.fields, AUDIT_EXPORT_FIELDS)
    if (!fields) return reply.code(400).send({ error: 'invalid_fields' })

    const conds = ['zone_id = $1']
    const values: (string | number | string[])[] = [params.zoneId]
    if (q.since) {
      values.push(q.since)
      conds.push(`occurred_at >= $${values.length}`)
    }
    if (q.until) {
      values.push(q.until)
      conds.push(`occurred_at < $${values.length}`)
    }
    if (q.request_id) {
      values.push(q.request_id)
      conds.push(`request_id = $${values.length}`)
    }
    if (q.decision) {
      values.push(q.decision)
      conds.push(`decision = $${values.length}`)
    }
    if (q.event_type) {
      const types = parseEventTypes(q.event_type)
      if (!types) return reply.code(400).send({ error: 'invalid_query' })
      if (types.length === 1) {
        values.push(types[0]!)
        conds.push(`event_type = $${values.length}`)
      } else {
        values.push(types)
        conds.push(`event_type = ANY($${values.length})`)
      }
    }
    if (q.application_id) {
      values.push(q.application_id)
      conds.push(`metadata_json->>'application_id' = $${values.length}`)
    }
    if (q.session_id) {
      values.push(q.session_id)
      conds.push(`metadata_json->>'agent_session_id' = $${values.length}`)
    }
    if (q.authority_record_id) {
      values.push(q.authority_record_id)
      conds.push(`metadata_json->>'session_id' = $${values.length}`)
    }
    if (q.label) {
      values.push(JSON.stringify([q.label]))
      conds.push(`metadata_json->'agent_labels' @> $${values.length}::jsonb`)
    }

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

    if (q.format === 'csv') {
      reply.header('content-type', 'text/csv; charset=utf-8')
      reply.header('content-disposition', `attachment; filename="audit-${params.zoneId}.csv"`)
      const flat = redacted.map((r) => projectRow(r, fields, AUDIT_ROW_FIELDS, 'metadata_json'))
      return reply.send(csvDocument(fields, flat))
    }

    const last = redacted[redacted.length - 1]
    const next = redacted.length === q.limit && last ? encodeCursor(new Date(last.occurred_at).toISOString(), last.id) : null
    if (q.fields) {
      return {
        items: redacted.map((r) => projectRow(r, fields, AUDIT_ROW_FIELDS, 'metadata_json')),
        next_cursor: next,
      }
    }
    return { items: redacted, next_cursor: next }
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
      final_decision: events.some((event) => event.decision === 'deny') ? 'deny' : (events.at(-1)?.decision ?? 'unknown'),
      denied: rows
        .filter((event) => event.decision === 'deny')
        .map((event) => ({
          event_id: event.id,
          event_type: event.event_type,
          evaluation_status: event.evaluation_status,
          determining_policies: event.determining_policies_json ?? [],
          diagnostics: event.diagnostics_json ?? [],
          metadata: redactSensitive(event.metadata_json) ?? {},
          policy_input: reconstructPolicyInput(params.zoneId, event.metadata_json),
        })),
      events,
    }
  })

  fastify.get('/zones/:zoneId/admin-audit', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const parsed = AdminAuditQuery.safeParse(req.query ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' })
    const q = parsed.data
    const fields = parseFields(q.fields, ADMIN_AUDIT_EXPORT_FIELDS)
    if (!fields) return reply.code(400).send({ error: 'invalid_fields' })

    const conds = ['zone_id = $1']
    const values: (string | number)[] = [params.zoneId]
    if (q.since) {
      values.push(q.since)
      conds.push(`occurred_at >= $${values.length}`)
    }
    if (q.until) {
      values.push(q.until)
      conds.push(`occurred_at < $${values.length}`)
    }
    if (q.actor_id) {
      values.push(q.actor_id)
      conds.push(`actor_id = $${values.length}`)
    }
    if (q.entity_type) {
      values.push(q.entity_type)
      conds.push(`entity_type = $${values.length}`)
    }
    if (q.entity_id) {
      values.push(q.entity_id)
      conds.push(`entity_id = $${values.length}`)
    }
    if (q.method) {
      values.push(q.method)
      conds.push(`method = $${values.length}`)
    }

    const cursor = q.cursor ? decodeCursor(q.cursor) : null
    if (q.cursor && !cursor) return reply.code(400).send({ error: 'invalid_cursor' })
    if (cursor) {
      values.push(cursor.ts)
      values.push(cursor.id)
      conds.push(`(occurred_at, id) < ($${values.length - 1}, $${values.length})`)
    }
    values.push(q.limit)

    const { rows } = await fastify.db.query(
      `SELECT id, request_id, actor_id, actor_name, actor_scope, action, method, path,
              entity_type, entity_id, status_code, payload_json, occurred_at,
              chain_seq, (chain_hmac IS NOT NULL) AS signed
       FROM admin_audit_events
       WHERE ${conds.join(' AND ')}
       ORDER BY occurred_at DESC, id DESC
       LIMIT $${values.length}`,
      values,
    )
    const redacted = rows.map((r) => ({ ...r, payload_json: redactSensitive(r.payload_json) }))

    if (q.format === 'csv') {
      reply.header('content-type', 'text/csv; charset=utf-8')
      reply.header('content-disposition', `attachment; filename="admin-audit-${params.zoneId}.csv"`)
      const flat = redacted.map((r) => projectRow(r, fields, ADMIN_AUDIT_ROW_FIELDS, 'payload_json'))
      return reply.send(csvDocument(fields, flat))
    }

    const last = redacted[redacted.length - 1]
    const next = redacted.length === q.limit && last ? encodeCursor(new Date(last.occurred_at).toISOString(), last.id) : null
    if (q.fields) {
      return {
        items: redacted.map((r) => projectRow(r, fields, ADMIN_AUDIT_ROW_FIELDS, 'payload_json')),
        next_cursor: next,
      }
    }
    return { items: redacted, next_cursor: next }
  })

  fastify.get('/zones/:zoneId/authority-records', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const parsed = AuthorityRecordQuery.safeParse(req.query ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' })
    const q = parsed.data

    const conds = ['zone_id = $1']
    const values: (string | number)[] = [params.zoneId]
    if (q.authority_record_id) {
      values.push(q.authority_record_id)
      conds.push(`id = $${values.length}`)
    }
    if (q.status) {
      values.push(q.status)
      conds.push(`status = $${values.length}`)
    }
    if (q.subject_id) {
      values.push(q.subject_id)
      conds.push(`subject_id = $${values.length}`)
    }

    const cursor = q.cursor ? decodeCursor(q.cursor) : null
    if (q.cursor && !cursor) return reply.code(400).send({ error: 'invalid_cursor' })
    if (cursor) {
      values.push(cursor.ts)
      values.push(cursor.id)
      conds.push(`(created_at, id) < ($${values.length - 1}, $${values.length})`)
    }
    values.push(q.limit)

    const { rows } = await fastify.db.query(
      `SELECT id AS authority_record_id, zone_id, session_type AS authority_record_type, subject_id,
              parent_id AS parent_authority_record_id, status, expires_at,
              authenticated_at, created_at, revoked_at, revoked_reason
       FROM sessions
       WHERE ${conds.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT $${values.length}`,
      values,
    )

    if (q.format === 'csv') {
      reply.header('content-type', 'text/csv; charset=utf-8')
      reply.header('content-disposition', `attachment; filename="authority-records-${params.zoneId}.csv"`)
      return reply.send(csvDocument(AUTHORITY_RECORD_CSV_COLUMNS, rows))
    }

    const last = rows[rows.length - 1]
    const next = rows.length === q.limit && last ? encodeCursor(new Date(last.created_at).toISOString(), last.authority_record_id) : null
    return { items: rows, next_cursor: next }
  })

  fastify.get('/zones/:zoneId/sessions', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const parsed = SessionQuery.safeParse(req.query ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' })
    const q = parsed.data

    const conds = ['zone_id = $1']
    const values: (string | number)[] = [params.zoneId]
    if (q.status) {
      values.push(q.status)
      conds.push(`status = $${values.length}`)
    }
    if (q.lifecycle) {
      values.push(q.lifecycle)
      conds.push(`lifecycle = $${values.length}`)
    }
    if (q.application_id) {
      values.push(q.application_id)
      conds.push(`application_id = $${values.length}`)
    }
    if (q.parent_session_id) {
      values.push(q.parent_session_id)
      conds.push(`parent_id = $${values.length}`)
    }
    if (q.label) {
      values.push(`{${q.label}}`)
      conds.push(`labels @> $${values.length}`)
    }

    const cursor = q.cursor ? decodeCursor(q.cursor) : null
    if (q.cursor && !cursor) return reply.code(400).send({ error: 'invalid_cursor' })
    if (cursor) {
      values.push(cursor.ts)
      values.push(cursor.id)
      conds.push(`(spawned_at, id) < ($${values.length - 1}, $${values.length})`)
    }
    values.push(q.limit)

    const { rows } = await fastify.db.query(
      `SELECT id AS session_id, application_id, parent_id AS parent_session_id, status, lifecycle, labels, depth, child_count,
              spawned_at, last_active_at, terminated_at, termination_reason, ttl_seconds
       FROM agent_sessions
       WHERE ${conds.join(' AND ')}
       ORDER BY spawned_at DESC, id DESC
       LIMIT $${values.length}`,
      values,
    )

    if (q.format === 'csv') {
      reply.header('content-type', 'text/csv; charset=utf-8')
      reply.header('content-disposition', `attachment; filename="sessions-${params.zoneId}.csv"`)
      return reply.send(csvDocument(SESSION_CSV_COLUMNS, rows))
    }

    const last = rows[rows.length - 1]
    const next = rows.length === q.limit && last ? encodeCursor(new Date(last.spawned_at).toISOString(), last.session_id) : null
    return { items: rows, next_cursor: next }
  })
}
