// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Admin audit log: structured per-action records of every authenticated mutation.

import { v7 as uuidv7 } from 'uuid'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { DB } from './db.js'
import type { Actor } from './auth.js'

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export interface AdminAuditEvent {
  requestId: string
  actor: Actor | null
  method: string
  path: string
  zoneId: string | null
  entityType: string | null
  entityId: string | null
  statusCode: number
  payload: Record<string, unknown> | null
}

export async function recordAdminEvent(db: DB, ev: AdminAuditEvent): Promise<void> {
  const id = uuidv7()
  await db.query(
    `INSERT INTO admin_audit_events
     (id, request_id, actor_id, actor_name, actor_scope, action, method, path,
      zone_id, entity_type, entity_id, status_code, payload_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
    [
      id,
      ev.requestId,
      ev.actor?.id ?? null,
      ev.actor?.name ?? null,
      ev.actor?.scope ?? null,
      `${ev.method} ${ev.path}`,
      ev.method,
      ev.path,
      ev.zoneId,
      ev.entityType,
      ev.entityId,
      ev.statusCode,
      ev.payload ? JSON.stringify(ev.payload) : null,
    ],
  )
}

function zoneFromUrl(url: string): string | null {
  const match = url.match(/^\/v1\/zones\/([^/?]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

function entityFromUrl(url: string): { type: string | null; id: string | null } {
  const stripped = url.split('?')[0]
  const segments = stripped.split('/').filter(Boolean)
  for (let i = segments.length - 2; i >= 0; i--) {
    const candidate = segments[i]
    const next = segments[i + 1]
    if (candidate && next && /^(zones|applications|resources|providers|policies|policy-sets|grants|invitations|teams|step-up-challenges)$/.test(candidate)) {
      return { type: candidate, id: next }
    }
  }
  return { type: null, id: null }
}

export interface AuditPluginOptions {
  db: DB
  enabled?: boolean
}

export function registerAdminAuditHook(app: FastifyInstance, opts: AuditPluginOptions): void {
  if (opts.enabled === false) return

  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/v1/')) return

    const success = reply.statusCode < 400
    const mutating = MUTATING_METHODS.has(req.method)

    if (!mutating && success) return

    const entity = entityFromUrl(req.url)
    const event: AdminAuditEvent = {
      requestId: req.id,
      actor: req.actor ?? null,
      method: req.method,
      path: req.url,
      zoneId: zoneFromUrl(req.url),
      entityType: entity.type,
      entityId: entity.id,
      statusCode: reply.statusCode,
      payload: null,
    }
    try {
      await recordAdminEvent(opts.db, event)
    } catch (err) {
      req.log.warn({ err, requestId: req.id }, 'failed to record admin audit event')
    }
  })
}
