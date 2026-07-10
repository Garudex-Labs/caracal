// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Coordinator dead-outbox recovery route.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { requireScope } from '../auth.js'

const Params = z.object({ zoneId: z.string().uuid(), id: z.string().uuid() })

export const outboxRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/zones/:zoneId/outbox/:id/requeue', async (req, reply) => {
    if (!requireScope(req, 'coordinator.admin')) {
      return reply.code(403).send({ error: 'coordinator_admin_required' })
    }
    const { zoneId, id } = Params.parse(req.params)
    const { rows } = await fastify.db.query<{ id: string }>(
      `UPDATE caracal_outbox
       SET status = 'pending', attempts = 0, available_at = now(),
           published_at = NULL, updated_at = now()
       WHERE id = $1 AND producer = 'coordinator' AND status = 'dead'
         AND payload_json->>'zone_id' = $2
       RETURNING id`,
      [id, zoneId],
    )
    if (!rows[0]) {
      return reply.code(404).send({ error: 'dead_outbox_not_found' })
    }
    return { id: rows[0].id, status: 'pending' }
  })
}
