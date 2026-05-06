// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Delegated grant CRUD routes: creation and revocation with session invalidation.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { STREAM_SESSIONS_REVOKE } from '../redis.js'
import { enqueueOutbox } from '../outbox.js'

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
  fastify.get('/zones/:zoneId/grants', async (req) => {
    const { zoneId } = req.params as { zoneId: string }
    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, application_id, user_id, resource_id, scopes, status, created_at
       FROM delegated_grants WHERE zone_id = $1 ORDER BY created_at DESC`,
      [zoneId],
    )
    return rows
  })

  fastify.get('/zones/:zoneId/grants/:id', async (req, reply) => {
    const { zoneId, id } = req.params as { zoneId: string; id: string }
    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, application_id, user_id, resource_id, scopes, status, created_at
       FROM delegated_grants WHERE id = $1 AND zone_id = $2`,
      [id, zoneId],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'grant_not_found' })
    return rows[0]
  })

  fastify.post('/zones/:zoneId/grants', async (req, reply) => {
    const { zoneId } = req.params as { zoneId: string }
    const body = GrantBody.parse(req.body)
    const { rows: refs } = await fastify.db.query(
      `SELECT
         EXISTS (
           SELECT 1 FROM applications
           WHERE id = $2 AND zone_id = $1 AND archived_at IS NULL
             AND (expires_at IS NULL OR expires_at > now())
         ) AS application_exists,
         (SELECT scopes FROM resources WHERE id = $3 AND zone_id = $1) AS resource_scopes`,
      [zoneId, body.application_id, body.resource_id],
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
      [id, zoneId, body.application_id, body.user_id, body.resource_id, body.scopes],
    )
    return reply.code(201).send(rows[0])
  })

  fastify.delete('/zones/:zoneId/grants/:id', async (req, reply) => {
    const { zoneId, id } = req.params as { zoneId: string; id: string }
    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<{ user_id: string }>(
        `UPDATE delegated_grants SET status = 'revoked'
         WHERE id = $1 AND zone_id = $2
         RETURNING user_id`,
        [id, zoneId],
      )
      if (!rows[0]) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'grant_not_found' })
      }

      const { rows: sessions } = await client.query<{ id: string }>(
        `UPDATE sessions SET status = 'revoked'
         WHERE zone_id = $1 AND status = 'active' AND subject_id = $2
         RETURNING id`,
        [zoneId, rows[0].user_id],
      )

      for (const s of sessions) {
        await enqueueOutbox(client, {
          streamName: STREAM_SESSIONS_REVOKE,
          payload: { zone_id: zoneId, session_id: s.id, reason: 'grant_revoked', grant_id: id },
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
