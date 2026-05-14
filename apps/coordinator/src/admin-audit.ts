// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Coordinator admin audit hook: records authenticated mutating calls to admin_audit_events.

import { pathOnly } from '@caracalai/core'
import { v7 as uuidv7 } from 'uuid'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { Pool } from 'pg'

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function entityFromUrl(url: string): { type: string | null; id: string | null } {
  const segments = pathOnly(url).split('/').filter(Boolean)
  for (let i = segments.length - 2; i >= 0; i--) {
    const candidate = segments[i]
    const next = segments[i + 1]
    if (candidate && next && /^(agents|agent-services|delegations|invocations|applications)$/.test(candidate)) {
      return { type: candidate, id: next }
    }
  }
  return { type: null, id: null }
}

function zoneFromParams(req: FastifyRequest, url: string): string | null {
  const params = req.params as { zoneId?: string } | undefined
  if (params?.zoneId) return params.zoneId
  const match = pathOnly(url).match(/^\/zones\/([^/]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

export function registerAdminAuditHook(app: FastifyInstance, db: Pool): void {
  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    const path = pathOnly(req.url)
    if (path === '/health' || path === '/ready' || path === '/metrics') return
    const success = reply.statusCode < 400
    const mutating = MUTATING_METHODS.has(req.method)
    if (!mutating && success) return
    const auth = req.caracalAuth
    if (!auth) return
    const entity = entityFromUrl(req.url)
    try {
      await db.query(
        `INSERT INTO admin_audit_events
         (id, request_id, actor_id, actor_name, actor_scope, action, method, path,
          zone_id, entity_type, entity_id, status_code, payload_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
        [
          uuidv7(),
          req.id,
          auth?.subject ?? null,
          auth?.clientId ?? null,
          auth ? auth.scopes.join(' ') : null,
          `${req.method} ${req.url}`,
          req.method,
          req.url,
          zoneFromParams(req, req.url),
          entity.type,
          entity.id,
          reply.statusCode,
          null,
        ],
      )
    } catch (err) {
      req.log.warn({ err, requestId: req.id }, 'failed to record admin audit event')
    }
  })
}
