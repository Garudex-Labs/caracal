// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Resource CRUD routes: identifier, scopes, and provider binding per zone.

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { buildPatchUpdate, patchColumn } from './patch.js'
import { ZoneIdParams, ZoneParams, parseParams } from './params.js'
import { zoneExists } from '../zone-guard.js'

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
    `SELECT 1 FROM providers WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`,
    [providerId, zoneId],
  )
  return rows.length > 0
}

export const resourcesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones/:zoneId/resources', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, name, identifier, upstream_url, prefix, scopes, credential_provider_id, created_at, updated_at
       FROM resources WHERE zone_id = $1 AND archived_at IS NULL ORDER BY created_at DESC`,
      [params.zoneId],
    )
    return rows
  })

  fastify.get('/zones/:zoneId/resources/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, name, identifier, upstream_url, prefix, scopes, credential_provider_id, created_at, updated_at
       FROM resources WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`,
      [params.id, params.zoneId],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'resource_not_found' })
    return rows[0]
  })

  fastify.post('/zones/:zoneId/resources', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    if (!(await zoneExists(fastify.db, params.zoneId))) {
      return reply.code(404).send({ error: 'zone_not_found' })
    }
    const body = ResourceBody.parse(req.body)
    if (body.credential_provider_id && !(await providerExists(fastify, params.zoneId, body.credential_provider_id))) {
      return reply.code(404).send({ error: 'provider_not_found' })
    }
    const id = uuidv7()
    const { rows } = await fastify.db.query(
      `INSERT INTO resources (id, zone_id, name, identifier, upstream_url, prefix, scopes, credential_provider_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, zone_id, name, identifier, upstream_url, prefix, scopes, credential_provider_id, created_at, updated_at`,
      [id, params.zoneId, body.name ?? body.identifier, body.identifier, body.upstream_url ?? null, body.prefix ?? false, body.scopes, body.credential_provider_id ?? null],
    )
    return reply.code(201).send(rows[0])
  })

  fastify.patch('/zones/:zoneId/resources/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const body = ResourceBody.partial().parse(req.body)
    if (body.credential_provider_id !== undefined) {
      if (!(await providerExists(fastify, params.zoneId, body.credential_provider_id))) {
        return reply.code(404).send({ error: 'provider_not_found' })
      }
    }
    const update = buildPatchUpdate([params.id, params.zoneId], [
      patchColumn('name', body.name),
      patchColumn('identifier', body.identifier),
      patchColumn('upstream_url', body.upstream_url),
      patchColumn('prefix', body.prefix),
      patchColumn('scopes', body.scopes),
      patchColumn('credential_provider_id', body.credential_provider_id),
    ])
    if (!update) return reply.code(400).send({ error: 'no_fields' })
    const { rows } = await fastify.db.query(
      `UPDATE resources SET ${update.sets.join(', ')}, updated_at = now()
       WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL
       RETURNING id, zone_id, name, identifier, upstream_url, prefix, scopes, credential_provider_id, created_at, updated_at`,
      update.values,
    )
    if (!rows[0]) return reply.code(404).send({ error: 'resource_not_found' })
    return rows[0]
  })

  fastify.delete('/zones/:zoneId/resources/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { rowCount } = await fastify.db.query(
      `UPDATE resources SET archived_at = now(), updated_at = now()
       WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`,
      [params.id, params.zoneId],
    )
    if (!rowCount) return reply.code(404).send({ error: 'resource_not_found' })
    return reply.code(204).send()
  })
}
