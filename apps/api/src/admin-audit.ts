// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Admin audit log: structured per-action records of every authenticated mutation, recorded before the response is reported as success.

import { pathOnly } from '@caracalai/server-core'
import { MUTATING_METHODS, insertAdminAuditRecord } from '@caracalai/admin-audit'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { withTransaction } from './db.js'
import type { DB } from './db.js'
import type { Actor } from './auth.js'

// Field names whose presence marks a mutation as carrying secret material, at any depth
// of the body. Values under any name are never persisted to the admin audit log; these
// names are additionally excluded from changed_fields and raise the secret_rotated flag,
// so a credential rotation is distinguishable from a rename without the secret ever
// entering the audit record.
const SECRET_FIELD_NAMES = new Set([
  'client_secret',
  'secret',
  'password',
  'token',
  'private_key',
  'api_key',
  'assertion',
  'bearer_token',
  'access_token',
  'refresh_token',
])

// Sub-resource action verbs that replace stored secret material without carrying it in
// the body, so the mutation classifies as a rotation even though the request is empty.
const SECRET_ACTION_SEGMENTS = new Set(['rotate-secret'])

// Route segments that name auditable entity collections; a segment matching this pattern
// is followed by an entity id in entity routes and terminates the path in create routes.
const COLLECTION_SEGMENT =
  /^(zones|applications|workloads|resources|providers|provider-connections|policies|policy-sets|policy-templates|grants|subject-issuers|subjects|step-up-challenges|admin-tokens|operator-conversations)$/

const CHANGE_FIELD_DEPTH = 3
const CHANGE_FIELD_LIMIT = 64

type ChangeKind = 'create' | 'update' | 'delete' | 'action' | 'secret_rotation'

interface ChangeSummary {
  change_kind: ChangeKind
  changed_fields: string[]
  secret_rotated?: true
}

// Walks the mutation body and records the dotted path of every field the caller touched
// (for example config_json.header_name) — names only, never values. Secret-named fields
// at any depth are excluded from the paths and reported through the return flag, and a
// nested object with no recordable children still surfaces as its own path so an edit is
// never invisible.
function collectChangedFields(body: Record<string, unknown>, prefix: string, depth: number, fields: string[]): boolean {
  let secret = false
  for (const [key, value] of Object.entries(body)) {
    if (SECRET_FIELD_NAMES.has(key.toLowerCase())) {
      secret = true
      continue
    }
    const path = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value) && depth < CHANGE_FIELD_DEPTH) {
      const before = fields.length
      const nestedSecret = collectChangedFields(value as Record<string, unknown>, path, depth + 1, fields)
      if (nestedSecret) secret = true
      if (fields.length === before && !nestedSecret && fields.length < CHANGE_FIELD_LIMIT) fields.push(path)
      continue
    }
    if (fields.length < CHANGE_FIELD_LIMIT) fields.push(path)
  }
  return secret
}

// The trailing verb of a sub-resource action route, such as `test` in
// POST /v1/zones/z1/providers/p1/test, or null for plain collection and entity routes.
// The scan walks from the end so the innermost entity wins, matching entityFromUrl.
// A trailing collection segment is a nested create or list target, never an action verb.
function actionSegment(url: string): string | null {
  const segments = pathOnly(url).split('/').filter(Boolean)
  for (let i = segments.length - 2; i >= 0; i--) {
    const candidate = segments[i]
    if (candidate && segments[i + 1] && COLLECTION_SEGMENT.test(candidate)) {
      const verb = segments[i + 2]
      return verb && !COLLECTION_SEGMENT.test(verb) ? verb : null
    }
  }
  return null
}

// Classifies each mutation into a semantic change record: what kind of operation it was
// (create, update, delete, sub-resource action, or secret rotation), which fields it
// touched through the full body hierarchy, and whether it carried secret material. The
// classification is derived from the method, the route shape, and field names alone, so
// the audit trail answers what changed and whether it was security-sensitive without
// ever storing a value.
function changeSummary(method: string, url: string, body: unknown): ChangeSummary | null {
  const action = actionSegment(url)
  const fields: string[] = []
  let secretRotated = false
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    secretRotated = collectChangedFields(body as Record<string, unknown>, '', 0, fields)
    fields.sort()
  }
  if (action && SECRET_ACTION_SEGMENTS.has(action)) secretRotated = true
  let changeKind: ChangeKind
  if (method === 'DELETE') changeKind = 'delete'
  else if (action) changeKind = secretRotated ? 'secret_rotation' : 'action'
  else if (method === 'POST') changeKind = 'create'
  else changeKind = secretRotated ? 'secret_rotation' : 'update'
  if (changeKind === 'update' && fields.length === 0) return null
  const summary: ChangeSummary = { change_kind: changeKind, changed_fields: fields }
  if (secretRotated) summary.secret_rotated = true
  return summary
}

function zoneFromUrl(url: string): string | null {
  const match = url.match(/^\/v1\/zones\/([^/?]+)/)
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

function entityFromUrl(url: string): { type: string | null; id: string | null } {
  const segments = pathOnly(url).split('/').filter(Boolean)
  for (let i = segments.length - 2; i >= 0; i--) {
    const candidate = segments[i]
    const next = segments[i + 1]
    if (candidate && next && COLLECTION_SEGMENT.test(candidate)) {
      return { type: candidate, id: next }
    }
  }
  return { type: null, id: null }
}

function isProviderOAuthCallback(method: string, url: string): boolean {
  if (method !== 'GET') return false
  return /^\/v1\/zones\/[^/]+\/provider-connections\/oauth\/callback(?:\?|$)/.test(url)
}

// The entity a successful create returned. Creates post to a collection URL, so the new
// entity's id exists only in the response body - deriving it there keeps every creation
// event queryable by the entity it produced, including zone creates where the zone is
// absent from the URL entirely.
function createdEntity(method: string, path: string, statusCode: number, payload: unknown): { type: string; id: string } | null {
  if (method !== 'POST' || statusCode !== 201) return null
  const collection = path.split('/').filter(Boolean).at(-1)
  if (!collection || !COLLECTION_SEGMENT.test(collection)) return null
  if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) return null
  try {
    const body = JSON.parse(payload.toString()) as { id?: unknown }
    return typeof body.id === 'string' ? { type: collection, id: body.id } : null
  } catch {
    return null
  }
}

export interface AuditPluginOptions {
  db: DB
  enabled?: boolean
  hmacKey?: Buffer | null
}

export function registerAdminAuditHook(app: FastifyInstance, opts: AuditPluginOptions): void {
  if (opts.enabled === false) return

  const record = (req: FastifyRequest, reply: FastifyReply, payload?: unknown): Promise<unknown> => {
    const actor: Actor | null = req.actor ?? null
    const account = req.account ?? null
    const entity = entityFromUrl(req.url)
    const path = pathOnly(req.url)
    const created = createdEntity(req.method, path, reply.statusCode, payload)
    const zoneScoped = actor?.scope === 'zone' && actor.zoneId ? actor.zoneId : null
    const rls = zoneScoped
      ? { rls_mode: 'zone_scoped', rls_zone_guc: zoneScoped }
      : { rls_mode: 'control_plane_wildcard', rls_zone_guc: '*' }
    // The verified console profile behind the shared console credential, recorded by its stable
    // id so every audit record identifies the human who performed the change even across renames;
    // the console resolves the id to the profile's current name at render time.
    const operator = account ? { operator: account.id } : null
    const change = reply.statusCode < 400 ? changeSummary(req.method, req.url, req.body) : null
    return withTransaction(opts.db, (client) =>
      insertAdminAuditRecord(
        client,
        {
          requestId: req.id,
          actorId: actor?.id ?? null,
          actorName: actor?.name ?? null,
          actorScope: actor?.scope ?? null,
          action: `${req.method} ${path}`,
          method: req.method,
          path,
          zoneId: zoneFromUrl(req.url) ?? (created?.type === 'zones' ? created.id : null),
          entityType: created?.type ?? entity.type,
          entityId: created?.id ?? entity.id,
          statusCode: reply.statusCode,
          payloadJson: { ...rls, ...operator, ...change },
        },
        opts.hmacKey ?? null,
      ),
    )
  }

  const gated = new WeakSet<FastifyRequest>()

  // A successful mutation must not be reported as success unless its audit record is
  // durably persisted, so success responses are gated here before headers are written.
  // The hook uses the callback form and completes synchronously on every skip path:
  // a promise-returning onSend hook defers chain completion past the handler's own
  // resolution, which makes Fastify re-send replies from handlers that send inside
  // the handler body and resolve with undefined.
  app.addHook('onSend', (req: FastifyRequest, reply: FastifyReply, payload: unknown, done) => {
    if (
      !req.url.startsWith('/v1/') ||
      reply.statusCode >= 400 ||
      (!MUTATING_METHODS.has(req.method) && !isProviderOAuthCallback(req.method, req.url))
    ) {
      done(null, payload)
      return
    }
    record(req, reply, payload).then(
      () => {
        gated.add(req)
        done(null, payload)
      },
      (err) => {
        gated.add(req)
        req.log.error({ err, requestId: req.id }, 'admin audit record could not be persisted; refusing to report success')
        reply.code(500)
        done(
          null,
          JSON.stringify({
            error: 'audit_unavailable',
            error_description: 'operation applied but its audit record could not be persisted',
          }),
        )
      },
    )
  })

  // A failure response is already the safe outcome, so its audit record is written after
  // the response completes; that keeps helper-sent error replies (which send inside the
  // handler and resolve with undefined) from racing async work in the send pipeline.
  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    if (gated.has(req)) return
    if (!req.url.startsWith('/v1/')) return
    if (reply.statusCode < 400) return
    try {
      await record(req, reply)
    } catch (err) {
      req.log.error({ err, requestId: req.id }, 'failed to record admin audit event')
    }
  })
}
