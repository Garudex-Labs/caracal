// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Resource CRUD routes: identifier, scopes, and provider binding per zone.

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { buildPatchUpdate, patchColumn } from './patch.js'

const HttpURL = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol
  return protocol === 'http:' || protocol === 'https:'
}, 'upstream_url must use http or https')

const ResourceBody = z.object({
  name: z.string().min(1).optional(),
  identifier: z.string().min(1),
  upstream_url: HttpURL.optional(),
  prefix: z.boolean().optional(),
  scopes: z.array(z.string()).min(1),
  credential_provider_id: z.string().optional(),
})

async function providerExists(fastify: FastifyInstance, zoneId: string, providerId: string): Promise<boolean> {
  const { rows } = await fastify.db.query(
    `SELECT 1 FROM providers WHERE id = $1 AND zone_id = $2`,
    [providerId, zoneId],
  )
  return rows.length > 0
}

export const resourcesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones/:zoneId/resources', async (req) => {
    const { zoneId } = req.params as { zoneId: string }
    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, name, identifier, upstream_url, prefix, scopes, credential_provider_id, created_at, updated_at
       FROM resources WHERE zone_id = $1 ORDER BY created_at DESC`,
      [zoneId],
    )
    return rows
  })

  fastify.get('/zones/:zoneId/resources/:id', async (req, reply) => {
    const { zoneId, id } = req.params as { zoneId: string; id: string }
    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, name, identifier, upstream_url, prefix, scopes, credential_provider_id, created_at, updated_at
       FROM resources WHERE id = $1 AND zone_id = $2`,
      [id, zoneId],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'resource_not_found' })
    return rows[0]
  })

  fastify.post('/zones/:zoneId/resources', async (req, reply) => {
    const { zoneId } = req.params as { zoneId: string }
    const body = ResourceBody.parse(req.body)
    if (body.credential_provider_id && !(await providerExists(fastify, zoneId, body.credential_provider_id))) {
      return reply.code(404).send({ error: 'provider_not_found' })
    }
    const id = uuidv7()
    const { rows } = await fastify.db.query(
      `INSERT INTO resources (id, zone_id, name, identifier, upstream_url, prefix, scopes, credential_provider_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, zone_id, name, identifier, upstream_url, prefix, scopes, credential_provider_id, created_at, updated_at`,
      [id, zoneId, body.name ?? body.identifier, body.identifier, body.upstream_url ?? null, body.prefix ?? false, body.scopes, body.credential_provider_id ?? null],
    )
    return reply.code(201).send(rows[0])
  })

  fastify.patch('/zones/:zoneId/resources/:id', async (req, reply) => {
    const { zoneId, id } = req.params as { zoneId: string; id: string }
    const body = ResourceBody.partial().parse(req.body)
    if (body.credential_provider_id !== undefined) {
      if (!(await providerExists(fastify, zoneId, body.credential_provider_id))) {
        return reply.code(404).send({ error: 'provider_not_found' })
      }
    }
    const update = buildPatchUpdate([id, zoneId], [
      patchColumn('name', body.name),
      patchColumn('identifier', body.identifier),
      patchColumn('upstream_url', body.upstream_url),
      patchColumn('prefix', body.prefix),
      patchColumn('scopes', body.scopes),
      patchColumn('credential_provider_id', body.credential_provider_id),
    ])
    if (!update) return reply.code(400).send({ error: 'no_fields' })
    const { rows } = await fastify.db.query(
      `UPDATE resources SET ${update.sets.join(', ')}, updated_at = now() WHERE id = $1 AND zone_id = $2
       RETURNING id, zone_id, name, identifier, upstream_url, prefix, scopes, credential_provider_id, created_at, updated_at`,
      update.values,
    )
    if (!rows[0]) return reply.code(404).send({ error: 'resource_not_found' })
    return rows[0]
  })

  fastify.delete('/zones/:zoneId/resources/:id', async (req, reply) => {
    const { zoneId, id } = req.params as { zoneId: string; id: string }
    await fastify.db.query('DELETE FROM resources WHERE id = $1 AND zone_id = $2', [id, zoneId])
    return reply.code(204).send()
  })
}
