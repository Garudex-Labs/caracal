// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Zone CRUD routes: create, read, update, delete.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { buildPatchUpdate, patchColumn } from './patch.js'
import { IdParams, parseParams } from './params.js'

const ZoneBody = z.object({
  org_id: z.string().min(1).default('default'),
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/).optional(),
  dcr_enabled: z.boolean().optional(),
  pkce_required: z.boolean().optional(),
  login_flow: z.string().optional(),
})

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export const zonesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones', async () => {
    const { rows } = await fastify.db.query(
      `SELECT id, org_id, name, slug, dcr_enabled, pkce_required, login_flow, created_at, updated_at
       FROM zones WHERE archived_at IS NULL ORDER BY created_at DESC`,
    )
    return rows
  })

  fastify.post('/zones', async (req, reply) => {
    const parsed = ZoneBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_zone' })
    const body = parsed.data
    const id = uuidv7()
    const { rows } = await fastify.db.query(
      `INSERT INTO zones (id, org_id, name, slug, dek_ciphertext, dcr_enabled, pkce_required, login_flow)
       VALUES ($1, $2, $3, $4, gen_random_bytes(32), $5, $6, $7)
       RETURNING id, org_id, name, slug, dcr_enabled, pkce_required, login_flow, created_at, updated_at`,
      [
        id,
        body.org_id,
        body.name,
        body.slug ?? slugify(body.name),
        body.dcr_enabled ?? false,
        body.pkce_required ?? true,
        body.login_flow ?? 'default',
      ],
    )
    return reply.code(201).send(rows[0])
  })

  fastify.get('/zones/:id', async (req, reply) => {
    const params = parseParams(IdParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `SELECT id, org_id, name, slug, dcr_enabled, pkce_required, login_flow, created_at, updated_at
       FROM zones WHERE id = $1 AND archived_at IS NULL`,
      [params.id],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'zone_not_found' })
    return rows[0]
  })

  fastify.patch('/zones/:id', async (req, reply) => {
    const params = parseParams(IdParams, req, reply)
    if (!params) return
    const parsed = ZoneBody.partial().safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_zone' })
    const body = parsed.data
    const update = buildPatchUpdate([params.id], [
      patchColumn('org_id', body.org_id),
      patchColumn('name', body.name),
      patchColumn('slug', body.slug),
      patchColumn('dcr_enabled', body.dcr_enabled),
      patchColumn('pkce_required', body.pkce_required),
      patchColumn('login_flow', body.login_flow),
    ])
    if (!update) return reply.code(400).send({ error: 'no_fields' })
    const { rows } = await fastify.db.query(
      `UPDATE zones SET ${update.sets.join(', ')}, updated_at = now()
       WHERE id = $1 AND archived_at IS NULL
       RETURNING id, org_id, name, slug, dcr_enabled, pkce_required, login_flow, created_at, updated_at`,
      update.values,
    )
    if (!rows[0]) return reply.code(404).send({ error: 'zone_not_found' })
    return rows[0]
  })

  fastify.delete('/zones/:id', async (req, reply) => {
    const params = parseParams(IdParams, req, reply)
    if (!params) return
    const { rowCount } = await fastify.db.query(
      `UPDATE zones SET archived_at = now(), updated_at = now()
       WHERE id = $1 AND archived_at IS NULL`,
      [params.id],
    )
    if (!rowCount) return reply.code(404).send({ error: 'zone_not_found' })
    return reply.code(204).send()
  })
}
