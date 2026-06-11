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
import { buildPatchUpdate, patchColumn } from './patch.js'
import { ZoneIdParams, ZoneParams, parseParams } from './params.js'
import { zoneExists } from '../zone-guard.js'
import { appendKeysetCondition, parseListPagination, setNextLink } from './list-pagination.js'
import { validateTraits } from '../traits.js'

const DCR_DEFAULT_LIFETIME_SECONDS = 3600
const DCR_MAX_LIFETIME_SECONDS = 3600

const AppBody = z.object({
  name: z.string().min(1),
  registration_method: z.literal('managed'),
  traits: z.array(z.string()).optional(),
}).strict()

const DCRBody = z.object({
  name: z.string().min(1),
  expires_in: z.number().int().positive().max(DCR_MAX_LIFETIME_SECONDS).default(DCR_DEFAULT_LIFETIME_SECONDS),
}).strict()

const PatchBody = z.object({
  name: z.string().min(1).optional(),
  client_secret: z.string().min(1).optional(),
  traits: z.array(z.string()).optional(),
}).strict()

function generateClientSecret(): string {
  return `cs_${randomBytes(32).toString('base64url')}`
}

function applicationSelect(req: FastifyRequest): string {
  return req.actor?.scope === 'global'
    ? 'id, zone_id, name, registration_method, traits, expires_at, created_at'
    : 'id, zone_id, name, registration_method, expires_at, created_at'
}

export const applicationsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones/:zoneId/applications', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const page = parseListPagination(req, reply)
    if (!page) return
    const keyset = appendKeysetCondition(
      { conds: ['zone_id = $1', 'archived_at IS NULL'], values: [params.zoneId] },
      page,
    )
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
    const traitErr = validateTraits(body.traits, req.actor)
    if (traitErr) return reply.code(403).send(traitErr)
    const id = uuidv7()
    const clientSecret = generateClientSecret()
    const secretHash = await hashClientSecret(clientSecret)
    const { rows } = await fastify.db.query(
      `INSERT INTO applications (id, zone_id, name, registration_method, credential_type, client_secret_hash, traits)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, zone_id, name, registration_method, expires_at, created_at`,
      [id, params.zoneId, body.name, body.registration_method, 'token', secretHash, body.traits ?? []],
    )
    return reply.code(201).send({ ...rows[0], client_secret: clientSecret })
  })

  fastify.patch('/zones/:zoneId/applications/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const parsed = PatchBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_application' })
    const body = parsed.data
    const traitErr = validateTraits(body.traits, req.actor)
    if (traitErr) return reply.code(403).send(traitErr)
    if (body.client_secret !== undefined) {
      const { rows: existing } = await fastify.db.query(
        `SELECT client_secret_hash FROM applications WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`,
        [params.id, params.zoneId],
      )
      if (!existing[0]) return reply.code(404).send({ error: 'application_not_found' })
      if (!existing[0].client_secret_hash) return reply.code(400).send({ error: 'client_secret_not_configured' })
    }
    const patchedHash = body.client_secret === undefined ? undefined : await hashClientSecret(body.client_secret)
    const update = buildPatchUpdate([params.id, params.zoneId], [
      patchColumn('name', body.name),
      patchColumn('client_secret_hash', patchedHash),
      patchColumn('traits', body.traits),
    ])
    if (!update) return reply.code(400).send({ error: 'no_fields' })
    const { rows } = await fastify.db.query(
      `UPDATE applications SET ${update.sets.join(', ')}
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
    const { rowCount } = await fastify.db.query(
      `UPDATE applications SET archived_at = now()
       WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`,
      [params.id, params.zoneId],
    )
    if (!rowCount) return reply.code(404).send({ error: 'application_not_found' })
    return reply.code(204).send()
  })

  fastify.post('/zones/:zoneId/applications/dcr', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const parsed = DCRBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_application' })
    const body = parsed.data

    const rlKey = `rl:dcr:${params.zoneId}:${req.actor.id}`
    await fastify.redis.set(rlKey, 0, 'EX', 1, 'NX')
    const rlCount = await fastify.redis.incr(rlKey)
    if (rlCount > 10) {
      return reply.code(429).send({ error: 'dcr_rate_limit_exceeded' })
    }

    const id = uuidv7()
    return withTransaction(fastify.db, async (client) => {
      const { rows: zones } = await client.query(
        `SELECT dcr_enabled FROM zones WHERE id = $1 AND archived_at IS NULL FOR UPDATE`,
        [params.zoneId],
      )
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
      const { rows } = await client.query(
        `INSERT INTO applications (id, zone_id, name, registration_method, credential_type, client_secret_hash, traits, expires_at)
         VALUES ($1, $2, $3, 'dcr', $4, $5, $6, now() + ($7::int * interval '1 second'))
         RETURNING id, zone_id, name, registration_method, expires_at, created_at`,
        [id, params.zoneId, body.name, 'token', dcrSecretHash, [], body.expires_in],
      )
      return reply.code(201).send({ ...rows[0], client_secret: clientSecret })
    })
  })
}
