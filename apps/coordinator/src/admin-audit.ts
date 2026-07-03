// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Coordinator admin audit hook: records authenticated mutating calls to admin_audit_events, refusing to report an unaudited success.

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
  const record = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const path = pathOnly(req.url)
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
      throw err
    } finally {
      client.release()
    }
  }

  const auditExempt = (path: string): boolean =>
    path === '/health' || path === '/ready' || path === '/metrics' || path === '/stats'

  const gated = new WeakSet<FastifyRequest>()

  // A successful mutation must not be reported as success unless its audit record is
  // durably persisted, so success responses are gated here before headers are written.
  // The hook uses the callback form and completes synchronously on every skip path:
  // a promise-returning onSend hook defers chain completion past the handler's own
  // resolution, which makes Fastify re-send replies from handlers that send inside
  // the handler body and resolve with undefined.
  app.addHook('onSend', (req: FastifyRequest, reply: FastifyReply, payload: unknown, done) => {
    if (auditExempt(pathOnly(req.url)) || reply.statusCode >= 400 || !MUTATING_METHODS.has(req.method)) {
      done(null, payload)
      return
    }
    record(req, reply).then(
      () => {
        gated.add(req)
        done(null, payload)
      },
      (err) => {
        gated.add(req)
        req.log.error({ err, requestId: req.id }, 'admin audit record could not be persisted; refusing to report success')
        reply.code(500)
        done(null, JSON.stringify({ error: 'audit_unavailable', message: 'operation applied but its audit record could not be persisted' }))
      },
    )
  })

  // A failure response is already the safe outcome, so its audit record is written after
  // the response completes; that keeps helper-sent error replies (which send inside the
  // handler and resolve with undefined) from racing async work in the send pipeline.
  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    if (gated.has(req)) return
    if (auditExempt(pathOnly(req.url))) return
    if (reply.statusCode < 400) return
    try {
      await record(req, reply)
    } catch (err) {
      req.log.error({ err, requestId: req.id }, 'failed to record admin audit event')
    }
  })
}
