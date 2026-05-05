// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Provider CRUD routes: OAuth, OIDC, apikey, and workload IdP variants.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { buildPatchUpdate, patchColumn, patchExpression } from './patch.js'

const ProviderBody = z.object({
  name: z.string().min(1).optional(),
  identifier: z.string().min(1),
  kind: z.enum(['oauth2', 'oidc', 'apikey', 'workload']).optional(),
  owner_type: z.string().optional(),
  client_id: z.string().optional(),
  config_json: z.record(z.unknown()).optional(),
})

export const providersRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones/:zoneId/providers', async (req) => {
    const { zoneId } = req.params as { zoneId: string }
    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, name, identifier, config_json->>'kind' AS kind, owner_type, client_id, config_json, created_at, updated_at
       FROM providers WHERE zone_id = $1 ORDER BY created_at DESC`,
      [zoneId],
    )
    return rows
  })

  fastify.get('/zones/:zoneId/providers/:id', async (req, reply) => {
    const { zoneId, id } = req.params as { zoneId: string; id: string }
    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, name, identifier, config_json->>'kind' AS kind, owner_type, client_id, config_json, created_at, updated_at
       FROM providers WHERE id = $1 AND zone_id = $2`,
      [id, zoneId],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'provider_not_found' })
    return rows[0]
  })

  fastify.post('/zones/:zoneId/providers', async (req, reply) => {
    const { zoneId } = req.params as { zoneId: string }
    const body = ProviderBody.parse(req.body)
    const id = uuidv7()
    const config = { ...(body.config_json ?? {}), ...(body.kind ? { kind: body.kind } : {}) }
    const { rows } = await fastify.db.query(
      `INSERT INTO providers (id, zone_id, name, identifier, owner_type, client_id, config_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING id, zone_id, name, identifier, config_json->>'kind' AS kind, owner_type, client_id, config_json, created_at, updated_at`,
      [id, zoneId, body.name ?? body.identifier, body.identifier, body.owner_type ?? 'customer', body.client_id ?? null, JSON.stringify(config)],
    )
    return reply.code(201).send(rows[0])
  })

  fastify.patch('/zones/:zoneId/providers/:id', async (req, reply) => {
    const { zoneId, id } = req.params as { zoneId: string; id: string }
    const body = ProviderBody.partial().parse(req.body)
    const configJSON = body.config_json !== undefined || body.kind !== undefined
      ? JSON.stringify({ ...(body.config_json ?? {}), ...(body.kind ? { kind: body.kind } : {}) })
      : undefined
    const update = buildPatchUpdate([id, zoneId], [
      patchColumn('name', body.name),
      patchColumn('identifier', body.identifier),
      patchColumn('owner_type', body.owner_type),
      patchColumn('client_id', body.client_id),
      patchExpression(configJSON, (placeholder) => `config_json = config_json || ${placeholder}::jsonb`),
    ])
    if (!update) return reply.code(400).send({ error: 'no_fields' })
    const { rows } = await fastify.db.query(
      `UPDATE providers SET ${update.sets.join(', ')}, updated_at = now() WHERE id = $1 AND zone_id = $2
       RETURNING id, zone_id, name, identifier, config_json->>'kind' AS kind, owner_type, client_id, config_json, created_at, updated_at`,
      update.values,
    )
    if (!rows[0]) return reply.code(404).send({ error: 'provider_not_found' })
    return rows[0]
  })

  fastify.delete('/zones/:zoneId/providers/:id', async (req, reply) => {
    const { zoneId, id } = req.params as { zoneId: string; id: string }
    await fastify.db.query('DELETE FROM providers WHERE id = $1 AND zone_id = $2', [id, zoneId])
    return reply.code(204).send()
  })
}
