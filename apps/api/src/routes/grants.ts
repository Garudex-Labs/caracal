// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Delegated grant CRUD routes: creation and revocation with session invalidation.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { scopesAllowed } from '@caracalai/core'
import { STREAM_SESSIONS_REVOKE } from '../redis.js'
import { enqueueOutbox } from '../outbox.js'
import { withTransaction, TxAbort } from '../db.js'
import { resolveAttribution, type Attribution } from '../attribution.js'
import { ZoneIdParams, ZoneParams, parseParams } from './params.js'
import { zoneExists } from '../zone-guard.js'
import { appendKeysetCondition, listPage, parseListPagination } from './list-pagination.js'

const SESSION_REVOKE_BATCH = 1000

// Scope strings cross trust boundaries (Rego policies, upstream IdPs). Restrict to a
// safe charset and bounded length so neither side has to sanitize control characters,
// whitespace, or absurdly long values.
const ScopePattern = /^[a-z0-9:_./-]+$/
const ScopeMaxLen = 200
const Scope = z.string().min(1).max(ScopeMaxLen).regex(ScopePattern)

const GrantBody = z.object({
  application_id: z.string().min(1),
  user_id: z.string().min(1),
  resource_id: z.string().min(1),
  scopes: z.array(Scope).min(1).max(64),
})

const GrantListQuery = z.object({
  application_id: z.string().min(1).optional(),
  user_id: z.string().min(1).optional(),
  subject_id: z.string().min(1).optional(),
  resource_id: z.string().min(1).optional(),
  provider_id: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  scopes: z.preprocess(
    (value) =>
      typeof value === 'string'
        ? value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
        : value,
    z.array(Scope).min(1).max(64).optional(),
  ),
})

// Creates an active delegated grant after validating the application and resource exist
// and the requested scopes are within the resource's scopes. Shared by the grants route
// and the Operator executor so both authorize and persist a grant identically. Returns a
// typed error rather than throwing so each caller maps it to its own surface.
export type CreateGrantError =
  'application_not_found' | 'resource_not_found' | 'grant_scopes_exceed_resource' | 'control_resource_not_grantable'

export async function createDelegatedGrant(
  db: { query: <T = unknown>(text: string, params?: unknown[]) => Promise<{ rows: T[] }> },
  zoneId: string,
  input: { application_id: string; user_id: string; resource_id: string; scopes: string[] },
  attribution: Attribution,
): Promise<{ ok: true; row: Record<string, unknown> } | { ok: false; error: CreateGrantError }> {
  const { rows: refs } = await db.query<{
    application_exists: boolean
    resource_scopes: string[] | null
    resource_identifier: string | null
  }>(
    `SELECT
       EXISTS (
         SELECT 1 FROM applications
         WHERE id = $2 AND zone_id = $1 AND archived_at IS NULL
           AND (expires_at IS NULL OR expires_at > now())
       ) AS application_exists,
       (SELECT scopes FROM resources WHERE id = $3 AND zone_id = $1 AND archived_at IS NULL) AS resource_scopes,
       (SELECT identifier FROM resources WHERE id = $3 AND zone_id = $1 AND archived_at IS NULL) AS resource_identifier`,
    [zoneId, input.application_id, input.resource_id],
  )
  if (!refs[0]?.application_exists) return { ok: false, error: 'application_not_found' }
  if (!refs[0].resource_scopes) return { ok: false, error: 'resource_not_found' }
  // A delegated grant on the control resource would open a non-control-key mint
  // path for control-audience tokens; control authority flows only through control
  // keys, so the grant is refused at creation.
  if (refs[0].resource_identifier === (process.env.CONTROL_AUDIENCE ?? 'caracal-control')) {
    return { ok: false, error: 'control_resource_not_grantable' }
  }
  if (!scopesAllowed(input.scopes, refs[0].resource_scopes)) {
    return { ok: false, error: 'grant_scopes_exceed_resource' }
  }
  const { rows } = await db.query<Record<string, unknown>>(
    `INSERT INTO delegated_grants (id, zone_id, application_id, user_id, resource_id, scopes, status, created_by, created_via_operator)
     VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8)
     RETURNING id, zone_id, application_id, user_id, resource_id, scopes, status, created_by, created_via_operator, created_at`,
    [uuidv7(), zoneId, input.application_id, input.user_id, input.resource_id, input.scopes, attribution.actor, attribution.viaOperator],
  )
  return { ok: true, row: rows[0] }
}

export const grantsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones/:zoneId/grants', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const page = parseListPagination(req, reply)
    if (!page) return
    const parsed = GrantListQuery.safeParse(req.query ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' })
    const query = parsed.data
    const userId = query.user_id ?? query.subject_id
    const base = { conds: ['dg.zone_id = $1'], values: [params.zoneId] as unknown[] }
    if (query.application_id) {
      base.values.push(query.application_id)
      base.conds.push(`dg.application_id = $${base.values.length}`)
    }
    if (userId) {
      base.values.push(userId)
      base.conds.push(`dg.user_id = $${base.values.length}`)
    }
    if (query.resource_id) {
      base.values.push(query.resource_id)
      base.conds.push(`dg.resource_id = $${base.values.length}`)
    }
    if (query.provider_id) {
      base.values.push(query.provider_id)
      base.conds.push(`r.credential_provider_id = $${base.values.length}`)
    }
    if (query.status) {
      base.values.push(query.status)
      base.conds.push(`dg.status = $${base.values.length}`)
    }
    if (query.scopes) {
      base.values.push(query.scopes)
      base.conds.push(`dg.scopes @> $${base.values.length}::text[]`)
    }
    const keyset = appendKeysetCondition(base, page, 'dg.created_at', 'dg.id')
    const { rows } = await fastify.db.query(
      `SELECT dg.id, dg.zone_id, dg.application_id, dg.user_id, dg.resource_id,
              r.credential_provider_id AS provider_id,
              a.name AS application_name,
              r.name AS resource_name,
              p.name AS provider_name,
              p.provider_kind AS provider_kind,
              dg.scopes, dg.status, dg.created_by, dg.created_via_operator, dg.updated_by, dg.updated_via_operator, dg.created_at
       FROM delegated_grants dg
       LEFT JOIN applications a ON a.zone_id = dg.zone_id AND a.id = dg.application_id
       LEFT JOIN resources r ON r.zone_id = dg.zone_id AND r.id = dg.resource_id
       LEFT JOIN providers p ON p.zone_id = dg.zone_id AND p.id = r.credential_provider_id
       WHERE ${keyset.conds.join(' AND ')}
       ORDER BY dg.created_at DESC, dg.id DESC LIMIT ${keyset.limitPlaceholder}`,
      keyset.values,
    )
    return listPage(rows, page.limit)
  })

  fastify.get('/zones/:zoneId/grants/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, application_id, user_id, resource_id, scopes, status,
              created_by, created_via_operator, updated_by, updated_via_operator, created_at
       FROM delegated_grants WHERE id = $1 AND zone_id = $2`,
      [params.id, params.zoneId],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'grant_not_found' })
    return rows[0]
  })

  fastify.post('/zones/:zoneId/grants', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    if (!(await zoneExists(fastify.db, params.zoneId))) {
      return reply.code(404).send({ error: 'zone_not_found' })
    }
    const body = GrantBody.parse(req.body)
    const result = await createDelegatedGrant(fastify.db, params.zoneId, body, await resolveAttribution(req, fastify.db, params.zoneId))
    if (!result.ok) {
      const status = result.error === 'application_not_found' || result.error === 'resource_not_found' ? 404 : 403
      return reply.code(status).send({ error: result.error })
    }
    return reply.code(201).send(result.row)
  })

  fastify.delete('/zones/:zoneId/grants/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const attribution = await resolveAttribution(req, fastify.db, params.zoneId)
    return withTransaction(fastify.db, async (client) => {
      const { rows } = await client.query<{ user_id: string }>(
        `UPDATE delegated_grants SET status = 'revoked', updated_by = $3, updated_via_operator = $4, updated_at = now()
         WHERE id = $1 AND zone_id = $2
         RETURNING user_id`,
        [params.id, params.zoneId, attribution.actor, attribution.viaOperator],
      )
      if (!rows[0]) throw new TxAbort(reply.code(404).send({ error: 'grant_not_found' }))

      // Page authority-record revocation so a grant covering many active records cannot
      // hold a long-running UPDATE lock or flood the outbox in a single batch.
      while (true) {
        const { rows: authorityRecords } = await client.query<{ id: string }>(
          `UPDATE authority_records SET status = 'revoked',
                  revoked_at = now(), revoked_reason = 'grant_revoked'
           WHERE id IN (
             SELECT id FROM authority_records
             WHERE zone_id = $1 AND status = 'active' AND subject_id = $2
             ORDER BY created_at
             LIMIT $3
             FOR UPDATE SKIP LOCKED
           )
           RETURNING id`,
          [params.zoneId, rows[0].user_id, SESSION_REVOKE_BATCH],
        )
        for (const record of authorityRecords) {
          await enqueueOutbox(client, {
            streamName: STREAM_SESSIONS_REVOKE,
            payload: { zone_id: params.zoneId, session_id: record.id, reason: 'grant_revoked', grant_id: params.id },
            requestId: req.id,
          })
        }
        if (authorityRecords.length < SESSION_REVOKE_BATCH) break
      }

      return reply.code(204).send()
    })
  })
}
