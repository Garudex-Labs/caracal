// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Admin audit log: structured per-action records of every authenticated mutation.

import { pathOnly } from '@caracalai/core'
import { MUTATING_METHODS, insertAdminAuditRecord } from '@caracalai/admin/server'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { DB } from './db.js'
import type { Actor } from './auth.js'

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
    if (!MUTATING_METHODS.has(req.method) && success) return

    const actor: Actor | null = req.actor ?? null
    const entity = entityFromUrl(req.url)
    try {
      await insertAdminAuditRecord(opts.db, {
        requestId: req.id,
        actorId: actor?.id ?? null,
        actorName: actor?.name ?? null,
        actorScope: actor?.scope ?? null,
        action: `${req.method} ${req.url}`,
        method: req.method,
        path: req.url,
        zoneId: zoneFromUrl(req.url),
        entityType: entity.type,
        entityId: entity.id,
        statusCode: reply.statusCode,
      })
    } catch (err) {
      req.log.warn({ err, requestId: req.id }, 'failed to record admin audit event')
    }
  })
}
