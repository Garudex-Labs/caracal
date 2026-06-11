// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Step-up challenge metadata endpoints: inspection and external satisfaction.

import type { FastifyPluginAsync } from 'fastify'
import { ZoneIdParams, ZoneParams, parseParams } from './params.js'
import { appendKeysetCondition, parseListPagination, setNextLink } from './list-pagination.js'

export const stepUpChallengesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones/:zoneId/step-up-challenges', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const page = parseListPagination(req, reply)
    if (!page) return
    const keyset = appendKeysetCondition(
      { conds: ['zone_id = $1'], values: [params.zoneId] },
      page,
    )
    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, session_id, challenge_type, metadata_json,
              created_at, expires_at, satisfied_at, approver_subject_id
       FROM step_up_challenges WHERE ${keyset.conds.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ${keyset.limitPlaceholder}`,
      keyset.values,
    )
    setNextLink(req, reply, rows, page.limit)
    return rows
  })

  fastify.get('/zones/:zoneId/step-up-challenges/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, session_id, challenge_type, metadata_json,
              created_at, expires_at, satisfied_at, approver_subject_id
       FROM step_up_challenges WHERE id = $1 AND zone_id = $2`,
      [params.id, params.zoneId],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'challenge_not_found' })
    return rows[0]
  })

  fastify.post('/zones/:zoneId/step-up-challenges/:id/satisfy', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const approverId = `admin:${req.actor.id}`

    const { rows } = await fastify.db.query(
      `UPDATE step_up_challenges c
       SET satisfied_at = now(), approver_subject_id = $3
       FROM sessions s
       WHERE c.id = $1 AND c.zone_id = $2
         AND c.satisfied_at IS NULL AND c.expires_at > now()
         AND c.session_id = s.id
         AND (s.subject_id IS NULL OR s.subject_id <> $3)
       RETURNING c.id, c.satisfied_at, c.approver_subject_id`,
      [params.id, params.zoneId, approverId],
    )
    if (!rows[0]) {
      return reply.code(409).send({ error: 'challenge_not_satisfiable' })
    }
    return rows[0]
  })
}
