// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Delegated grant CRUD routes: creation and revocation with session invalidation.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { STREAM_SESSIONS_REVOKE } from '../redis.js'
import { enqueueOutbox } from '../outbox.js'
import { ZoneIdParams, ZoneParams, parseParams } from './params.js'
import { zoneExists } from '../zone-guard.js'

const GrantBody = z.object({
  application_id: z.string().min(1),
  user_id: z.string().min(1),
  resource_id: z.string().min(1),
  scopes: z.array(z.string()).min(1),
})

function scopesAllowed(requested: string[], available: string[]): boolean {
  const allowed = new Set(available)
  return requested.every(scope => allowed.has(scope))
}

export const grantsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones/:zoneId/grants', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, application_id, user_id, resource_id, scopes, status, created_at
       FROM delegated_grants WHERE zone_id = $1 ORDER BY created_at DESC`,
      [params.zoneId],
    )
    return rows
  })

  fastify.get('/zones/:zoneId/grants/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, application_id, user_id, resource_id, scopes, status, created_at
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
    const { rows: refs } = await fastify.db.query(
      `SELECT
         EXISTS (
           SELECT 1 FROM applications
           WHERE id = $2 AND zone_id = $1 AND archived_at IS NULL
             AND (expires_at IS NULL OR expires_at > now())
         ) AS application_exists,
         (SELECT scopes FROM resources WHERE id = $3 AND zone_id = $1 AND archived_at IS NULL) AS resource_scopes`,
      [params.zoneId, body.application_id, body.resource_id],
    )
    if (!refs[0]?.application_exists) {
      return reply.code(404).send({ error: 'application_not_found' })
    }
    if (!refs[0].resource_scopes) {
      return reply.code(404).send({ error: 'resource_not_found' })
    }
    if (!scopesAllowed(body.scopes, refs[0].resource_scopes)) {
      return reply.code(403).send({ error: 'grant_scopes_exceed_resource' })
    }
    const id = uuidv7()
    const { rows } = await fastify.db.query(
      `INSERT INTO delegated_grants (id, zone_id, application_id, user_id, resource_id, scopes, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'active')
       RETURNING id, zone_id, application_id, user_id, resource_id, scopes, status, created_at`,
      [id, params.zoneId, body.application_id, body.user_id, body.resource_id, body.scopes],
    )
    return reply.code(201).send(rows[0])
  })

  fastify.delete('/zones/:zoneId/grants/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<{ user_id: string }>(
        `UPDATE delegated_grants SET status = 'revoked'
         WHERE id = $1 AND zone_id = $2
         RETURNING user_id`,
        [params.id, params.zoneId],
      )
      if (!rows[0]) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'grant_not_found' })
      }

      const { rows: sessions } = await client.query<{ id: string }>(
        `UPDATE sessions SET status = 'revoked'
         WHERE zone_id = $1 AND status = 'active' AND subject_id = $2
         RETURNING id`,
        [params.zoneId, rows[0].user_id],
      )

      for (const s of sessions) {
        await enqueueOutbox(client, {
          streamName: STREAM_SESSIONS_REVOKE,
          payload: { zone_id: params.zoneId, session_id: s.id, reason: 'grant_revoked', grant_id: params.id },
          requestId: req.id,
        })
      }

      await client.query('COMMIT')
      return reply.code(204).send()
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })
}
