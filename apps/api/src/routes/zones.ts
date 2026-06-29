// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Zone CRUD routes: create, read, update, delete.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { insertAdminAuditRecord } from '@caracalai/admin-audit'
import { buildPatchUpdate, patchColumn } from './patch.js'
import { withTransaction, TxAbort } from '../db.js'
import { IdParams, parseParams } from './params.js'
import { appendKeysetCondition, parseListPagination, setNextLink } from './list-pagination.js'
import { assertReservedNamespace, RESERVED_ZONE_SQL, mintZoneId } from '../reserved-namespace.js'
import { enqueueOutboxBatch, type EnqueueArgs } from '../outbox.js'
import { STREAM_AGENTS_LIFECYCLE, STREAM_SESSIONS_REVOKE } from '../redis.js'
import type { Actor } from '../auth.js'

const ZoneCreateBody = z
  .object({
    name: z.string().min(1),
    slug: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    dcr_enabled: z.boolean().optional(),
  })
  .strict()

const ZoneUpdateBody = z
  .object({
    name: z.string().min(1).optional(),
    slug: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    dcr_enabled: z.boolean().optional(),
    dcr_shutdown: z.enum(['keep_live', 'revoke_live']).optional(),
  })
  .strict()

type ZoneUpdateBody = z.infer<typeof ZoneUpdateBody>

interface Queryable {
  query: <T = unknown>(text: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount?: number | null }>
}

interface ZoneRow {
  id: string
  name: string
  slug: string
  dcr_enabled: boolean
  created_at: string
  updated_at: string
}

const ZONE_SLUG_UNIQUE_CONSTRAINT = 'zones_slug_key'

interface LiveDcrApplication {
  id: string
}

interface RevokedSession {
  id: string
}

interface TerminatedAgent {
  id: string
  subject_session_id: string
  parent_id: string | null
}

interface RevokedDelegation {
  id: string
}

function isDcrShutdownInfrastructureError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const code = (err as { code?: unknown }).code
  return code === '42501' || code === '42P01' || code === '42703'
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'zone'
  )
}

async function zoneSlugExists(client: Queryable, slug: string): Promise<boolean> {
  const { rows } = await client.query(`SELECT 1 FROM zones WHERE slug = $1`, [slug])
  return rows.length > 0
}

async function nextZoneSlug(client: Queryable, name: string): Promise<string> {
  const base = slugify(name)
  for (let suffix = 1; suffix < 1000; suffix++) {
    const slug = suffix === 1 ? base : `${base}-${suffix}`
    if (!(await zoneSlugExists(client, slug))) return slug
  }
  return `${base}-${uuidv7().replace(/-/g, '')}`
}

// Creates a zone row, allocating a unique slug when one is not supplied. Shared by
// the zones route and the Operator executor so both create zones identically.
export async function createZoneRecord(
  db: Queryable,
  input: { name: string; slug?: string; dcrEnabled?: boolean; ownerAccountId?: string | null },
): Promise<ZoneRow> {
  const { rows } = await db.query<ZoneRow>(
    `INSERT INTO zones (id, name, slug, dek_ciphertext, dcr_enabled, owner_account_id)
     VALUES ($1, $2, $3, gen_random_bytes(32), $4, $5)
     RETURNING id, name, slug, dcr_enabled, created_at, updated_at`,
    [
      mintZoneId(uuidv7),
      input.name,
      input.slug ?? (await nextZoneSlug(db, input.name)),
      input.dcrEnabled ?? false,
      input.ownerAccountId ?? null,
    ],
  )
  return rows[0]
}

function isZoneSlugConflict(err: unknown): boolean {
  return Boolean(
    err &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505' &&
    'constraint' in err &&
    (err as { constraint?: unknown }).constraint === ZONE_SLUG_UNIQUE_CONSTRAINT,
  )
}

function liveDcrPredicate(): string {
  return `zone_id = $1
    AND registration_method = 'dcr'
    AND archived_at IS NULL
    AND expires_at > now()`
}

async function liveDcrApplications(client: Queryable, zoneId: string, lock = false): Promise<LiveDcrApplication[]> {
  const { rows } = await client.query<LiveDcrApplication>(
    `SELECT id FROM applications
     WHERE ${liveDcrPredicate()}
     ORDER BY created_at
     ${lock ? 'FOR UPDATE' : ''}`,
    [zoneId],
  )
  return rows
}

async function revokeDcrIdentities(
  client: Queryable,
  zoneId: string,
  applicationIds: string[],
  requestId: string,
): Promise<{ applications: number; sessions: number; agents: number; delegations: number }> {
  if (applicationIds.length === 0) return { applications: 0, sessions: 0, agents: 0, delegations: 0 }

  const { rows: apps } = await client.query<{ id: string }>(
    `UPDATE applications
     SET archived_at = now()
     WHERE zone_id = $1 AND id = ANY($2::text[]) AND archived_at IS NULL
     RETURNING id`,
    [zoneId, applicationIds],
  )

  const { rows: sessions } = await client.query<RevokedSession>(
    `WITH RECURSIVE revoked_tree AS (
       SELECT id FROM sessions
       WHERE zone_id = $1
         AND session_type = 'application'
         AND subject_id = ANY($2::text[])
         AND status = 'active'
       UNION
       SELECT s.id FROM sessions s
       JOIN revoked_tree r ON s.parent_id = r.id
       WHERE s.zone_id = $1 AND s.status = 'active'
     )
     UPDATE sessions
     SET status = 'revoked'
     WHERE zone_id = $1 AND id IN (SELECT id FROM revoked_tree)
     RETURNING id`,
    [zoneId, applicationIds],
  )

  const { rows: agents } = await client.query<TerminatedAgent>(
    `WITH RECURSIVE tree AS (
       SELECT id, subject_session_id, parent_id
       FROM agent_sessions
       WHERE zone_id = $1
         AND application_id = ANY($2::text[])
         AND status IN ('active','suspended')
       UNION
       SELECT child.id, child.subject_session_id, child.parent_id
       FROM agent_sessions child
       JOIN tree parent ON child.parent_id = parent.id
       WHERE child.zone_id = $1 AND child.status IN ('active','suspended')
     )
     UPDATE agent_sessions
     SET status = 'terminated', terminated_at = now(), updated_at = now()
     WHERE zone_id = $1 AND id IN (SELECT id FROM tree)
     RETURNING id, subject_session_id, parent_id`,
    [zoneId, applicationIds],
  )

  const agentIds = agents.map((row) => row.id)
  const { rows: delegations } =
    agentIds.length > 0
      ? await client.query<RevokedDelegation>(
          `UPDATE delegation_edges
       SET status = 'revoked', revoked_at = now(), edge_version = edge_version + 1, updated_at = now()
       WHERE zone_id = $1
         AND status = 'active'
         AND (source_session_id = ANY($2::text[]) OR target_session_id = ANY($2::text[]))
       RETURNING id`,
          [zoneId, agentIds],
        )
      : { rows: [] as RevokedDelegation[] }

  const events: EnqueueArgs[] = []
  for (const row of sessions) {
    events.push({
      streamName: STREAM_SESSIONS_REVOKE,
      payload: { zone_id: zoneId, session_id: row.id, reason: 'dcr_shutdown' },
      requestId,
    })
  }
  for (const row of agents) {
    events.push({
      streamName: STREAM_AGENTS_LIFECYCLE,
      payload: {
        event: 'terminate',
        zone_id: zoneId,
        agent_session_id: row.id,
        parent_id: row.parent_id,
        reason: 'dcr_shutdown',
      },
      requestId,
    })
    events.push({
      streamName: STREAM_SESSIONS_REVOKE,
      payload: { zone_id: zoneId, session_id: row.subject_session_id, agent_session_id: row.id, reason: 'dcr_shutdown' },
      requestId,
    })
  }
  for (const row of delegations) {
    events.push({
      streamName: STREAM_SESSIONS_REVOKE,
      payload: { zone_id: zoneId, delegation_edge_id: row.id, reason: 'dcr_shutdown' },
      requestId,
    })
  }
  await enqueueOutboxBatch(client, events)

  return { applications: apps.length, sessions: sessions.length, agents: agents.length, delegations: delegations.length }
}

async function auditDcrShutdown(
  client: Queryable,
  actor: Actor | null,
  requestId: string,
  zoneId: string,
  mode: 'keep_live' | 'revoke_live' | 'no_live',
  counts: { live: number; applications: number; sessions: number; agents: number; delegations: number },
): Promise<void> {
  await insertAdminAuditRecord(client, {
    requestId,
    actorId: actor?.id ?? null,
    actorName: actor?.name ?? null,
    actorScope: actor?.scope ?? null,
    action: `DCR shutdown ${mode}`,
    method: 'PATCH',
    path: `/v1/zones/${zoneId}`,
    zoneId,
    entityType: 'zones',
    entityId: zoneId,
    statusCode: 200,
    payloadJson: {
      dcr_registration_disabled: true,
      dcr_shutdown_mode: mode,
      live_dcr_applications: counts.live,
      revoked_applications: counts.applications,
      revoked_sessions: counts.sessions,
      terminated_agents: counts.agents,
      revoked_delegations: counts.delegations,
    },
  })
}

async function patchZone(client: Queryable, id: string, body: ZoneUpdateBody): Promise<ZoneRow | null | undefined> {
  const update = buildPatchUpdate(
    [id],
    [patchColumn('name', body.name), patchColumn('slug', body.slug), patchColumn('dcr_enabled', body.dcr_enabled)],
  )
  if (!update) return undefined
  const { rows } = await client.query<ZoneRow>(
    `UPDATE zones SET ${update.sets.join(', ')}, updated_at = now()
     WHERE id = $1 AND archived_at IS NULL
     RETURNING id, name, slug, dcr_enabled, created_at, updated_at`,
    update.values,
  )
  return rows[0] ?? null
}

export const zonesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones', async (req, reply) => {
    const page = parseListPagination(req, reply)
    if (!page) return
    // The reserved system zone is Caracal's own internal infrastructure; it is never listed
    // in the Console zones dashboard or any external zone enumeration. It remains reachable by
    // id for the read-only transparency view, so only the list is filtered.
    const conds = ['archived_at IS NULL', `NOT ${RESERVED_ZONE_SQL}`]
    const values: unknown[] = []
    // Per-account isolation: a Console login sees only the zones it owns. A request with no
    // bound account (direct admin) sees all, so break-glass enumeration is unaffected.
    if (req.account) {
      values.push(req.account.id)
      conds.push(`owner_account_id = $${values.length}`)
    }
    const keyset = appendKeysetCondition({ conds, values }, page)
    const { rows } = await fastify.db.query(
      `SELECT id, name, slug, dcr_enabled, created_at, updated_at
       FROM zones WHERE ${keyset.conds.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ${keyset.limitPlaceholder}`,
      keyset.values,
    )
    setNextLink(req, reply, rows, page.limit)
    return rows
  })

  fastify.post('/zones', async (req, reply) => {
    const parsed = ZoneCreateBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_zone' })
    const body = parsed.data
    const reserved = assertReservedNamespace('zoneName', body.name, req.actor) ?? assertReservedNamespace('zoneSlug', body.slug, req.actor)
    if (reserved) return reply.code(409).send(reserved)
    try {
      const row = await createZoneRecord(fastify.db, {
        name: body.name,
        slug: body.slug,
        dcrEnabled: body.dcr_enabled,
        ownerAccountId: req.account?.id ?? null,
      })
      return reply.code(201).send(row)
    } catch (err) {
      if (isZoneSlugConflict(err)) return reply.code(409).send({ error: 'zone_slug_conflict' })
      throw err
    }
  })

  fastify.get('/zones/:id', async (req, reply) => {
    const params = parseParams(IdParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `SELECT id, name, slug, dcr_enabled, created_at, updated_at
       FROM zones WHERE id = $1 AND archived_at IS NULL`,
      [params.id],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'zone_not_found' })
    return rows[0]
  })

  fastify.get('/zones/:id/dcr-status', async (req, reply) => {
    const params = parseParams(IdParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `SELECT z.id, z.dcr_enabled,
              (
                SELECT COUNT(*)::int FROM applications
                WHERE zone_id = z.id
                  AND registration_method = 'dcr'
                  AND archived_at IS NULL
                  AND expires_at > now()
              ) AS live_dcr_applications
       FROM zones z
       WHERE z.id = $1 AND z.archived_at IS NULL`,
      [params.id],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'zone_not_found' })
    return rows[0]
  })

  fastify.patch('/zones/:id', async (req, reply) => {
    const params = parseParams(IdParams, req, reply)
    if (!params) return
    const parsed = ZoneUpdateBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_zone' })
    const body = parsed.data
    const reserved = assertReservedNamespace('zoneName', body.name, req.actor) ?? assertReservedNamespace('zoneSlug', body.slug, req.actor)
    if (reserved) return reply.code(409).send(reserved)
    if (body.dcr_shutdown && body.dcr_enabled !== false) {
      return reply.code(400).send({ error: 'dcr_shutdown_not_applicable' })
    }
    if (body.dcr_enabled !== false) {
      const row = await patchZone(fastify.db, params.id, body)
      if (row === null) return reply.code(404).send({ error: 'zone_not_found' })
      if (row === undefined) return reply.code(400).send({ error: 'no_fields' })
      return row
    }

    const update = buildPatchUpdate(
      [params.id],
      [patchColumn('name', body.name), patchColumn('slug', body.slug), patchColumn('dcr_enabled', body.dcr_enabled)],
    )
    if (!update) return reply.code(400).send({ error: 'no_fields' })
    try {
      return await withTransaction(fastify.db, async (client) => {
        const { rows: zones } = await client.query<{ dcr_enabled: boolean }>(
          `SELECT dcr_enabled FROM zones WHERE id = $1 AND archived_at IS NULL FOR UPDATE`,
          [params.id],
        )
        if (!zones[0]) throw new TxAbort(reply.code(404).send({ error: 'zone_not_found' }))

        const apps = zones[0].dcr_enabled || body.dcr_shutdown ? await liveDcrApplications(client, params.id, true) : []
        if (apps.length > 0 && !body.dcr_shutdown) {
          throw new TxAbort(reply.code(409).send({ error: 'dcr_shutdown_required', live_dcr_applications: apps.length }))
        }

        const { rows } = await client.query<ZoneRow>(
          `UPDATE zones SET ${update.sets.join(', ')}, updated_at = now()
           WHERE id = $1 AND archived_at IS NULL
           RETURNING id, name, slug, dcr_enabled, created_at, updated_at`,
          update.values,
        )
        const shutdown =
          body.dcr_shutdown === 'revoke_live'
            ? await revokeDcrIdentities(
                client,
                params.id,
                apps.map((app) => app.id),
                req.id,
              )
            : { applications: 0, sessions: 0, agents: 0, delegations: 0 }
        if (zones[0].dcr_enabled || body.dcr_shutdown) {
          await auditDcrShutdown(
            client,
            req.actor ?? null,
            req.id,
            params.id,
            apps.length === 0 ? 'no_live' : (body.dcr_shutdown ?? 'keep_live'),
            { live: apps.length, ...shutdown },
          )
        }
        return rows[0]
      })
    } catch (err) {
      if (isDcrShutdownInfrastructureError(err)) {
        req.log.error({ err }, 'dcr_shutdown_infrastructure_error')
        return reply.code(503).send({
          error: 'dcr_shutdown_unavailable',
          message: 'DCR shutdown cannot revoke runtime state until database migrations are applied',
        })
      }
      throw err
    }
  })

  fastify.delete('/zones/:id', async (req, reply) => {
    const params = parseParams(IdParams, req, reply)
    if (!params) return
    const { rowCount } = await fastify.db.query(
      `UPDATE zones SET archived_at = now(), updated_at = now()
       WHERE id = $1 AND archived_at IS NULL`,
      [params.id],
    )
    if (!rowCount) return reply.code(404).send({ error: 'zone_not_found' })
    return reply.code(204).send()
  })
}
