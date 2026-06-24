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

// Field names whose presence is recorded but whose values are never persisted to
// the admin audit log, so a secret rotation is distinguishable from a rename
// without the secret ever entering the audit record.
const SECRET_FIELD_NAMES = new Set([
  'client_secret', 'secret', 'password', 'token', 'private_key', 'api_key', 'assertion',
])

// changeSummary captures which top-level fields a mutation touched, never their
// values, so a rename, a trait change, and a secret rotation are distinguishable
// in the admin audit log while remaining secret-free.
function changeSummary(method: string, body: unknown): { changed_fields: string[]; secret_rotated?: true } | null {
  if (method === 'DELETE') return { changed_fields: [] }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const keys = Object.keys(body as Record<string, unknown>)
  if (keys.length === 0) return null
  const changed = keys.filter((key) => !SECRET_FIELD_NAMES.has(key.toLowerCase())).sort()
  const secretRotated = keys.some((key) => SECRET_FIELD_NAMES.has(key.toLowerCase()))
  return secretRotated ? { changed_fields: changed, secret_rotated: true } : { changed_fields: changed }
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
    const rls = zoneScoped
      ? { rls_mode: 'zone_scoped', rls_zone_guc: zoneScoped }
      : { rls_mode: 'control_plane_wildcard', rls_zone_guc: '*' }
    const change = success ? changeSummary(req.method, req.body) : null
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
            payloadJson: change ? { ...rls, ...change } : rls,
          },
          opts.hmacKey ?? null,
        ),
      )
    } catch (err) {
      req.log.warn({ err, requestId: req.id }, 'failed to record admin audit event')
    }
  })
}
