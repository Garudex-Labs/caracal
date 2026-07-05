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

// Field names whose presence is recorded but whose values are never persisted to
// the admin audit log, so a secret rotation is distinguishable from a rename
// without the secret ever entering the audit record.
const SECRET_FIELD_NAMES = new Set(['client_secret', 'secret', 'password', 'token', 'private_key', 'api_key', 'assertion'])

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
      /^(zones|applications|workloads|resources|providers|provider-grants|policies|policy-sets|policy-templates|grants|step-up-challenges|admin-tokens|operator-conversations)$/.test(
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

  const record = (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const actor: Actor | null = req.actor ?? null
    const account = req.account ?? null
    const entity = entityFromUrl(req.url)
    const path = pathOnly(req.url)
    const zoneScoped = actor?.scope === 'zone' && actor.zoneId ? actor.zoneId : null
    const rls = zoneScoped
      ? { rls_mode: 'zone_scoped', rls_zone_guc: zoneScoped }
      : { rls_mode: 'control_plane_wildcard', rls_zone_guc: '*' }
    // The verified console profile behind the shared console credential, so every audit
    // record names the human who performed the change, not just the credential it rode on.
    const operator = account ? { operator: account.name ?? account.email ?? account.id } : null
    const change = reply.statusCode < 400 ? changeSummary(req.method, req.body) : null
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
          zoneId: zoneFromUrl(req.url),
          entityType: entity.type,
          entityId: entity.id,
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
    record(req, reply).then(
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
