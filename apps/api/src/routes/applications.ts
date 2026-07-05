// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Application CRUD routes: managed and DCR app registration.

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { randomBytes } from 'node:crypto'
import { hashClientSecret } from '../hash-secret.js'
import { withTransaction, TxAbort } from '../db.js'
import { appendAttribution, buildPatchUpdate, patchColumn } from './patch.js'
import { resolveAttribution, type Attribution } from '../attribution.js'
import { ZoneIdParams, ZoneParams, parseParams } from './params.js'
import { zoneExists } from '../zone-guard.js'
import { appendKeysetCondition, parseListPagination, setNextLink } from './list-pagination.js'
import { validateTraits } from '../traits.js'
import { assertReservedNamespace } from '../reserved-namespace.js'

const DCR_DEFAULT_LIFETIME_SECONDS = 3600
const DCR_MAX_LIFETIME_SECONDS = 3600

const NAME_MAX_LENGTH = 200

const CLIENT_SECRET_MIN_LENGTH = 32

const APP_ATTRIBUTION = 'created_by, created_via_operator, updated_by, updated_via_operator, created_at, updated_at'

const AppBody = z
  .object({
    name: z.string().trim().min(1).max(NAME_MAX_LENGTH),
    registration_method: z.literal('managed'),
    traits: z.array(z.string()).optional(),
  })
  .strict()

const DCRBody = z
  .object({
    name: z.string().trim().min(1).max(NAME_MAX_LENGTH),
    expires_in: z.number().int().positive().max(DCR_MAX_LIFETIME_SECONDS).default(DCR_DEFAULT_LIFETIME_SECONDS),
  })
  .strict()

const PatchBody = z
  .object({
    name: z.string().trim().min(1).max(NAME_MAX_LENGTH).optional(),
    client_secret: z.string().min(CLIENT_SECRET_MIN_LENGTH).optional(),
    traits: z.array(z.string()).optional(),
  })
  .strict()

function generateClientSecret(): string {
  return `cs_${randomBytes(32).toString('base64url')}`
}

// Reports whether another active application in the zone already uses the name,
// case-insensitively, so managed identities stay unambiguous in every picker and
// audit trail. excludeId lets a rename skip the application being renamed.
async function activeNameTaken(
  db: { query: <T = unknown>(text: string, params?: unknown[]) => Promise<{ rows: T[] }> },
  zoneId: string,
  name: string,
  excludeId?: string,
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM applications
      WHERE zone_id = $1 AND lower(name) = lower($2) AND archived_at IS NULL
        AND registration_method = 'managed' AND id IS DISTINCT FROM $3
      LIMIT 1`,
    [zoneId, name, excludeId ?? null],
  )
  return rows.length > 0
}

// Registers a managed application with a freshly generated one-time client secret;
// the plaintext secret is returned to the caller and never persisted beyond its hash.
async function createManagedApplication(
  db: { query: <T = unknown>(text: string, params?: unknown[]) => Promise<{ rows: T[] }> },
  zoneId: string,
  input: { name: string; traits?: string[]; attribution: Attribution },
): Promise<{ row: Record<string, unknown>; clientSecret: string }> {
  const clientSecret = generateClientSecret()
  const secretHash = await hashClientSecret(clientSecret)
  const { rows } = await db.query<Record<string, unknown>>(
    `INSERT INTO applications (id, zone_id, name, registration_method, credential_type, client_secret_hash, traits, created_by, created_via_operator)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, zone_id, name, registration_method, expires_at, ${APP_ATTRIBUTION}`,
    [
      uuidv7(),
      zoneId,
      input.name,
      'managed',
      'token',
      secretHash,
      input.traits ?? [],
      input.attribution.actor,
      input.attribution.viaOperator,
    ],
  )
  return { row: rows[0], clientSecret }
}

// Issues a fresh client secret for an existing application and retires the old one; the
// new plaintext secret is returned to the caller and never persisted beyond its hash.
// Returns null when the application does not exist.
async function rotateApplicationClientSecret(
  db: { query: <T = unknown>(text: string, params?: unknown[]) => Promise<{ rows: T[] }> },
  zoneId: string,
  applicationId: string,
  attribution: Attribution,
): Promise<{ row: Record<string, unknown>; clientSecret: string } | null> {
  const clientSecret = generateClientSecret()
  const secretHash = await hashClientSecret(clientSecret)
  const { rows } = await db.query<Record<string, unknown>>(
    `UPDATE applications
        SET client_secret_hash = $3, updated_by = $4, updated_via_operator = $5, updated_at = now()
      WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL
      RETURNING id, zone_id, name, registration_method, expires_at, ${APP_ATTRIBUTION}`,
    [applicationId, zoneId, secretHash, attribution.actor, attribution.viaOperator],
  )
  if (!rows[0]) return null
  return { row: rows[0], clientSecret }
}

function applicationSelect(req: FastifyRequest): string {
  return req.actor?.scope === 'global'
    ? `id, zone_id, name, registration_method, traits, expires_at, ${APP_ATTRIBUTION}`
    : `id, zone_id, name, registration_method, expires_at, ${APP_ATTRIBUTION}`
}

export const applicationsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones/:zoneId/applications', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const page = parseListPagination(req, reply)
    if (!page) return
    const keyset = appendKeysetCondition({ conds: ['zone_id = $1', 'archived_at IS NULL'], values: [params.zoneId] }, page)
    const { rows } = await fastify.db.query(
      `SELECT ${applicationSelect(req)}
       FROM applications WHERE ${keyset.conds.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ${keyset.limitPlaceholder}`,
      keyset.values,
    )
    setNextLink(req, reply, rows, page.limit)
    return rows
  })

  fastify.get('/zones/:zoneId/applications/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `SELECT ${applicationSelect(req)}
       FROM applications WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`,
      [params.id, params.zoneId],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'application_not_found' })
    return rows[0]
  })

  fastify.post('/zones/:zoneId/applications', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    if (!(await zoneExists(fastify.db, params.zoneId))) {
      return reply.code(404).send({ error: 'zone_not_found' })
    }
    const parsed = AppBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_application' })
    const body = parsed.data
    const reservedErr = assertReservedNamespace('applicationName', body.name, req.actor)
    if (reservedErr) return reply.code(409).send(reservedErr)
    const traitErr = validateTraits(body.traits, req.actor)
    if (traitErr) return reply.code(403).send(traitErr)
    if (await activeNameTaken(fastify.db, params.zoneId, body.name)) {
      return reply.code(409).send({ error: 'application_name_taken' })
    }
    const { row, clientSecret } = await createManagedApplication(fastify.db, params.zoneId, {
      name: body.name,
      traits: body.traits,
      attribution: await resolveAttribution(req, fastify.db, params.zoneId),
    })
    return reply.code(201).send({ ...row, client_secret: clientSecret })
  })

  fastify.post('/zones/:zoneId/applications/:id/rotate-secret', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const attribution = await resolveAttribution(req, fastify.db, params.zoneId)
    const rotated = await rotateApplicationClientSecret(fastify.db, params.zoneId, params.id, attribution)
    if (!rotated) return reply.code(404).send({ error: 'application_not_found' })
    return { ...rotated.row, client_secret: rotated.clientSecret }
  })

  fastify.patch('/zones/:zoneId/applications/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const parsed = PatchBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_application' })
    const body = parsed.data
    const reservedErr = assertReservedNamespace('applicationName', body.name, req.actor)
    if (reservedErr) return reply.code(409).send(reservedErr)
    const traitErr = validateTraits(body.traits, req.actor)
    if (traitErr) return reply.code(403).send(traitErr)
    if (body.name !== undefined && (await activeNameTaken(fastify.db, params.zoneId, body.name, params.id))) {
      return reply.code(409).send({ error: 'application_name_taken' })
    }
    if (body.client_secret !== undefined) {
      const { rows: existing } = await fastify.db.query(
        `SELECT client_secret_hash FROM applications WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`,
        [params.id, params.zoneId],
      )
      if (!existing[0]) return reply.code(404).send({ error: 'application_not_found' })
      if (!existing[0].client_secret_hash) return reply.code(400).send({ error: 'client_secret_not_configured' })
    }
    const patchedHash = body.client_secret === undefined ? undefined : await hashClientSecret(body.client_secret)
    const update = buildPatchUpdate(
      [params.id, params.zoneId],
      [patchColumn('name', body.name), patchColumn('client_secret_hash', patchedHash), patchColumn('traits', body.traits)],
    )
    if (!update) return reply.code(400).send({ error: 'no_fields' })
    appendAttribution(update, await resolveAttribution(req, fastify.db, params.zoneId))
    const { rows } = await fastify.db.query(
      `UPDATE applications SET ${update.sets.join(', ')}, updated_at = now()
       WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL
       RETURNING id, name`,
      update.values,
    )
    if (!rows[0]) return reply.code(404).send({ error: 'application_not_found' })
    return rows[0]
  })

  fastify.delete('/zones/:zoneId/applications/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const attribution = await resolveAttribution(req, fastify.db, params.zoneId)
    return withTransaction(fastify.db, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE applications SET archived_at = now(), updated_at = now(), updated_by = $3, updated_via_operator = $4
         WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`,
        [params.id, params.zoneId, attribution.actor, attribution.viaOperator],
      )
      if (!rowCount) throw new TxAbort(reply.code(404).send({ error: 'application_not_found' }))
      // Clear any Gateway resource bindings that named this application as their
      // exchange identity so no binding is left pointing at an archived app, and
      // bump the binding revision so the Gateway drops the stale route from cache.
      const { rowCount: unbound } = await client.query(
        `DELETE FROM gateway_resource_bindings
         WHERE zone_id = $1 AND application_id = $2`,
        [params.zoneId, params.id],
      )
      if (unbound) {
        await client.query(`UPDATE gateway_binding_revision SET version = version + 1, updated_at = now() WHERE id = true`)
      }
      return reply.code(204).send()
    })
  })

  fastify.post('/zones/:zoneId/applications/dcr', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const parsed = DCRBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_application' })
    const body = parsed.data
    const reservedErr = assertReservedNamespace('applicationName', body.name, req.actor)
    if (reservedErr) return reply.code(409).send(reservedErr)

    const rlKey = `rl:dcr:${params.zoneId}:${req.actor.id}`
    await fastify.redis.set(rlKey, 0, 'EX', 1, 'NX')
    const rlCount = await fastify.redis.incr(rlKey)
    if (rlCount > 10) {
      return reply.code(429).send({ error: 'dcr_rate_limit_exceeded' })
    }

    const id = uuidv7()
    return withTransaction(fastify.db, async (client) => {
      const { rows: zones } = await client.query(`SELECT dcr_enabled FROM zones WHERE id = $1 AND archived_at IS NULL FOR UPDATE`, [
        params.zoneId,
      ])
      if (!zones[0]) throw new TxAbort(reply.code(404).send({ error: 'zone_not_found' }))
      if (!zones[0].dcr_enabled) throw new TxAbort(reply.code(403).send({ error: 'dcr_disabled' }))
      const { rows: cnt } = await client.query(
        `SELECT COUNT(*) AS n FROM applications
         WHERE zone_id = $1 AND registration_method = 'dcr'
           AND archived_at IS NULL
           AND (expires_at IS NULL OR expires_at > now())`,
        [params.zoneId],
      )
      if (parseInt(cnt[0].n, 10) >= 1000) {
        throw new TxAbort(reply.code(429).send({ error: 'dcr_limit_exceeded' }))
      }
      const clientSecret = generateClientSecret()
      const dcrSecretHash = await hashClientSecret(clientSecret)
      const attribution = await resolveAttribution(req, client, params.zoneId)
      const { rows } = await client.query(
        `INSERT INTO applications (id, zone_id, name, registration_method, credential_type, client_secret_hash, traits, expires_at, created_by, created_via_operator)
         VALUES ($1, $2, $3, 'dcr', $4, $5, $6, now() + ($7::int * interval '1 second'), $8, $9)
         RETURNING id, zone_id, name, registration_method, expires_at, ${APP_ATTRIBUTION}`,
        [id, params.zoneId, body.name, 'token', dcrSecretHash, [], body.expires_in, attribution.actor, attribution.viaOperator],
      )
      return reply.code(201).send({ ...rows[0], client_secret: clientSecret })
    })
  })
}
