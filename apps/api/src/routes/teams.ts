// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Team management routes: CRUD for zone teams with member management.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { buildPatchUpdate, patchColumn } from './patch.js'
import { ZoneIdParams, ZoneParams, parseParams } from './params.js'

const TeamBody = z.object({
  name: z.string().min(1),
  members: z.array(z.object({ id: z.string(), role: z.string() })).default([]),
})

export const teamsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones/:zoneId/teams', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, name, members_json, created_at, updated_at
       FROM teams WHERE zone_id = $1 ORDER BY name`,
      [params.zoneId],
    )
    return rows
  })

  fastify.get('/zones/:zoneId/teams/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, name, members_json, created_at, updated_at
       FROM teams WHERE id = $1 AND zone_id = $2`,
      [params.id, params.zoneId],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'team_not_found' })
    return rows[0]
  })

  fastify.post('/zones/:zoneId/teams', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const body = TeamBody.parse(req.body)
    const id = uuidv7()
    const { rows } = await fastify.db.query(
      `INSERT INTO teams (id, zone_id, name, members_json)
       VALUES ($1, $2, $3, $4)
       RETURNING id, zone_id, name, members_json, created_at, updated_at`,
      [id, params.zoneId, body.name, JSON.stringify(body.members)],
    )
    return reply.code(201).send(rows[0])
  })

  fastify.patch('/zones/:zoneId/teams/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const body = TeamBody.partial().parse(req.body)
    const update = buildPatchUpdate([params.id, params.zoneId], [
      patchColumn('name', body.name),
      patchColumn('members_json', body.members === undefined ? undefined : JSON.stringify(body.members)),
    ])
    if (!update) return reply.code(400).send({ error: 'no_fields' })
    const { rows } = await fastify.db.query(
      `UPDATE teams SET ${update.sets.join(', ')}, updated_at = now() WHERE id = $1 AND zone_id = $2
       RETURNING id, zone_id, name, members_json, created_at, updated_at`,
      update.values,
    )
    if (!rows[0]) return reply.code(404).send({ error: 'team_not_found' })
    return rows[0]
  })

  fastify.delete('/zones/:zoneId/teams/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { rowCount } = await fastify.db.query(
      `DELETE FROM teams WHERE id = $1 AND zone_id = $2`,
      [params.id, params.zoneId],
    )
    if (!rowCount) return reply.code(404).send({ error: 'team_not_found' })
    return reply.code(204).send()
  })
}
