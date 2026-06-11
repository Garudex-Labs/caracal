// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Coordinator admin audit hook: records authenticated mutating calls to admin_audit_events.

import { pathOnly } from '@caracalai/core'
import { MUTATING_METHODS, insertAdminAuditRecord } from '@caracalai/admin-audit'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { Pool } from 'pg'

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
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

export function registerAdminAuditHook(app: FastifyInstance, db: Pool, hmacKey: Buffer | null = null): void {
  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    const path = pathOnly(req.url)
    if (path === '/health' || path === '/ready' || path === '/metrics' || path === '/stats') return
    const success = reply.statusCode < 400
    if (!MUTATING_METHODS.has(req.method) && success) return
    const auth = req.caracalAuth
    if (!auth) return
    const entity = entityFromUrl(req.url)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await insertAdminAuditRecord(
        client,
        {
          requestId: req.id,
          actorId: auth.subject,
          actorName: auth.clientId,
          actorScope: auth.scopes.join(' '),
          action: `${req.method} ${path}`,
          method: req.method,
          path,
          zoneId: zoneFromParams(req, req.url),
          entityType: entity.type,
          entityId: entity.id,
          statusCode: reply.statusCode,
        },
        hmacKey,
      )
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      req.log.warn({ err, requestId: req.id }, 'failed to record admin audit event')
    } finally {
      client.release()
    }
  })
}
