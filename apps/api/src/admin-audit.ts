// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Admin audit log: structured per-action records of every authenticated mutation.

import { pathOnly } from '@caracalai/core'
import { MUTATING_METHODS, insertAdminAuditRecord } from '@caracalai/admin-audit'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { withTransaction } from './db.js'
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
    if (
      candidate &&
      next &&
      /^(zones|applications|resources|providers|provider-grants|policies|policy-sets|policy-templates|grants|step-up-challenges|admin-tokens)$/.test(
        candidate,
      )
    ) {
      return { type: candidate, id: next }
    }
  }
  return { type: null, id: null }
}

function isProviderOAuthCallback(method: string, url: string): boolean {
  if (method !== 'GET') return false
  return /^\/v1\/zones\/[^/]+\/provider-grants\/oauth\/callback(?:\?|$)/.test(url)
}

export interface AuditPluginOptions {
  db: DB
  enabled?: boolean
  hmacKey?: Buffer | null
}

export function registerAdminAuditHook(app: FastifyInstance, opts: AuditPluginOptions): void {
  if (opts.enabled === false) return

  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/v1/')) return

    const success = reply.statusCode < 400
    if (!MUTATING_METHODS.has(req.method) && success && !isProviderOAuthCallback(req.method, req.url)) return

    const actor: Actor | null = req.actor ?? null
    const entity = entityFromUrl(req.url)
    const path = pathOnly(req.url)
    const zoneScoped = actor?.scope === 'zone' && actor.zoneId ? actor.zoneId : null
    try {
      await withTransaction(opts.db, (client) =>
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
            zoneId: zoneFromUrl(req.url),
            entityType: entity.type,
            entityId: entity.id,
            statusCode: reply.statusCode,
            payloadJson: zoneScoped
              ? { rls_mode: 'zone_scoped', rls_zone_guc: zoneScoped }
              : { rls_mode: 'control_plane_wildcard', rls_zone_guc: '*' },
          },
          opts.hmacKey ?? null,
        ),
      )
    } catch (err) {
      req.log.warn({ err, requestId: req.id }, 'failed to record admin audit event')
    }
  })
}
