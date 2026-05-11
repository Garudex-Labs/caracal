// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Application CRUD routes: managed and DCR app registration.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { hashClientSecret } from '../hash-secret.js'
import { buildPatchUpdate, patchColumn } from './patch.js'
import { ZoneIdParams, ZoneParams, parseParams } from './params.js'
import { zoneExists } from '../zone-guard.js'
import { activePolicyReferencesApp } from '../policy-invariants.js'

const AppBody = z.object({
  name: z.string().min(1),
  registration_method: z.enum(['managed', 'dcr']),
  credential_type: z.enum(['token', 'password', 'public-key', 'url', 'public']).optional(),
  client_secret: z.string().min(1).optional(),
  traits: z.array(z.string()).optional(),
  consent: z.boolean().optional(),
})

const DCRBody = z.object({
  name: z.string().min(1),
  credential_type: z.enum(['token', 'password', 'public-key', 'url', 'public']).optional(),
  client_secret: z.string().min(1).optional(),
  traits: z.array(z.string()).optional(),
  expires_in: z.number().int().positive().optional(),
})

export const applicationsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones/:zoneId/applications', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, name, registration_method, credential_type, traits, consent, created_at
       FROM applications WHERE zone_id = $1 AND archived_at IS NULL ORDER BY created_at DESC`,
      [params.zoneId],
    )
    return rows
  })

  fastify.get('/zones/:zoneId/applications/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, name, registration_method, credential_type, traits, consent, created_at
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
    const body = AppBody.parse(req.body)
    const id = uuidv7()
    const secretHash = body.client_secret ? await hashClientSecret(body.client_secret) : null
    const { rows } = await fastify.db.query(
      `INSERT INTO applications (id, zone_id, name, registration_method, credential_type, client_secret_hash, traits, consent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, zone_id, name, registration_method, credential_type, traits, consent, created_at`,
      [id, params.zoneId, body.name, body.registration_method, body.credential_type ?? 'public', secretHash, body.traits ?? [], body.consent ? 'required' : 'implicit'],
    )
    return reply.code(201).send(rows[0])
  })

  fastify.patch('/zones/:zoneId/applications/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const body = AppBody.partial().parse(req.body)
    if (body.credential_type === 'public' && await activePolicyReferencesApp(fastify.db, params.zoneId, params.id)) {
      return reply.code(409).send({ error: 'app_referenced_by_active_policy' })
    }
    const patchedHash = body.client_secret === undefined ? undefined : await hashClientSecret(body.client_secret)
    const update = buildPatchUpdate([params.id, params.zoneId], [
      patchColumn('name', body.name),
      patchColumn('credential_type', body.credential_type),
      patchColumn('client_secret_hash', patchedHash),
      patchColumn('traits', body.traits),
      patchColumn('consent', body.consent === undefined ? undefined : body.consent ? 'required' : 'implicit'),
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
      `UPDATE applications SET archived_at = now(), updated_at = now()
       WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`,
      [params.id, params.zoneId],
    )
    if (!rowCount) return reply.code(404).send({ error: 'application_not_found' })
    return reply.code(204).send()
  })

  fastify.post('/zones/:zoneId/applications/dcr', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const body = DCRBody.parse(req.body)

    const rlKey = `rl:dcr:${params.zoneId}`
    await fastify.redis.set(rlKey, 0, 'EX', 1, 'NX')
    const rlCount = await fastify.redis.incr(rlKey)
    if (rlCount > 10) {
      return reply.code(429).send({ error: 'dcr_rate_limit_exceeded' })
    }

    const id = uuidv7()
    const expiresAt = body.expires_in
      ? new Date(Date.now() + body.expires_in * 1000)
      : null
    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      const { rows: zones } = await client.query(
        `SELECT dcr_enabled FROM zones WHERE id = $1 AND archived_at IS NULL FOR UPDATE`,
        [params.zoneId],
      )
      if (!zones[0]) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'zone_not_found' })
      }
      if (!zones[0].dcr_enabled) {
        await client.query('ROLLBACK')
        return reply.code(403).send({ error: 'dcr_disabled' })
      }
      const { rows: cnt } = await client.query(
        `SELECT COUNT(*) AS n FROM applications
         WHERE zone_id = $1 AND registration_method = 'dcr'
           AND archived_at IS NULL
           AND (expires_at IS NULL OR expires_at > now())`,
        [params.zoneId],
      )
      if (parseInt(cnt[0].n, 10) >= 1000) {
        await client.query('ROLLBACK')
        return reply.code(429).send({ error: 'dcr_limit_exceeded' })
      }
      const dcrSecretHash = body.client_secret ? await hashClientSecret(body.client_secret) : null
      const { rows } = await client.query(
        `INSERT INTO applications (id, zone_id, name, registration_method, credential_type, client_secret_hash, traits, expires_at)
         VALUES ($1, $2, $3, 'dcr', $4, $5, $6, $7)
         RETURNING id, zone_id, name, registration_method, credential_type, expires_at, created_at`,
        [id, params.zoneId, body.name, body.credential_type ?? 'public', dcrSecretHash, body.traits ?? [], expiresAt],
      )
      await client.query('COMMIT')
      return reply.code(201).send(rows[0])
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })
}
