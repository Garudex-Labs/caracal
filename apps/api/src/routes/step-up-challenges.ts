// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Step-up challenge metadata endpoints: inspection and external satisfaction.

import type { FastifyPluginAsync } from 'fastify'
import { ZoneIdParams, ZoneParams, parseParams } from './params.js'

export const stepUpChallengesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones/:zoneId/step-up-challenges', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, session_id, challenge_type, metadata_json,
              created_at, expires_at, satisfied_at
       FROM step_up_challenges WHERE zone_id = $1 ORDER BY created_at DESC`,
      [params.zoneId],
    )
    return rows
  })

  fastify.get('/zones/:zoneId/step-up-challenges/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, session_id, challenge_type, metadata_json,
              created_at, expires_at, satisfied_at
       FROM step_up_challenges WHERE id = $1 AND zone_id = $2`,
      [params.id, params.zoneId],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'challenge_not_found' })
    return rows[0]
  })

  fastify.post('/zones/:zoneId/step-up-challenges/:id/satisfy', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `UPDATE step_up_challenges
       SET satisfied_at = now()
       WHERE id = $1 AND zone_id = $2 AND satisfied_at IS NULL AND expires_at > now()
       RETURNING id, satisfied_at`,
      [params.id, params.zoneId],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'challenge_not_found_or_expired' })
    return rows[0]
  })
}
