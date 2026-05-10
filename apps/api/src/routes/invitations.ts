// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Invitation CRUD routes: create, list, and cancel zone invitations.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { ZoneIdParams, ZoneParams, parseParams } from './params.js'

const InviteBody = z.object({
  email: z.string().email(),
  role: z.string().min(1),
  invited_by: z.string().min(1),
  expires_at: z.string().datetime().optional(),
})

export const invitationsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones/:zoneId/invitations', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, email, role, invited_by, accepted_at, expires_at, created_at
       FROM invitations WHERE zone_id = $1 ORDER BY created_at DESC`,
      [params.zoneId],
    )
    return rows
  })

  fastify.post('/zones/:zoneId/invitations', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const parsed = InviteBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_invitation' })
    const body = parsed.data
    const id = uuidv7()
    const expiresAt =
      body.expires_at ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    const { rows } = await fastify.db.query(
      `INSERT INTO invitations (id, zone_id, email, role, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, zone_id, email, role, invited_by, accepted_at, expires_at, created_at`,
      [id, params.zoneId, body.email, body.role, body.invited_by, expiresAt],
    )
    return reply.code(201).send(rows[0])
  })

  fastify.delete('/zones/:zoneId/invitations/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { rowCount } = await fastify.db.query(
      `DELETE FROM invitations WHERE id = $1 AND zone_id = $2 AND accepted_at IS NULL`,
      [params.id, params.zoneId],
    )
    if (!rowCount) return reply.code(404).send({ error: 'invitation_not_found' })
    return reply.code(204).send()
  })
}
