// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Policy CRUD routes: immutable Rego versions with SHA-256 stamping.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { createHash } from 'crypto'
import { v7 as uuidv7 } from 'uuid'
import { ZoneIdParams, ZoneParams, parseParams } from './params.js'
import { zoneExists } from '../zone-guard.js'

const PolicyBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  owner_type: z.string().optional(),
  content: z.string().min(1),
  schema_version: z.string().default('2026-03-16'),
})

const VersionBody = z.object({
  content: z.string().min(1),
  schema_version: z.string().default('2026-03-16'),
})

function sha256(s: string) {
  return createHash('sha256').update(s).digest('hex')
}

function validateRego(content: string): string | null {
  if (!/^\s*package\s+[a-zA-Z0-9_.]+/m.test(content)) {
    return 'missing_package_declaration'
  }
  return null
}

export const policiesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones/:zoneId/policies', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, name, description, owner_type, created_by, created_at
       FROM policies WHERE zone_id = $1 AND archived_at IS NULL ORDER BY created_at DESC`,
      [params.zoneId],
    )
    return rows
  })

  fastify.get('/zones/:zoneId/policies/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `SELECT p.id, p.zone_id, p.name, p.description, p.owner_type, p.created_at,
              json_agg(pv ORDER BY pv.version DESC) AS versions
       FROM policies p
       LEFT JOIN policy_versions pv ON pv.policy_id = p.id
       WHERE p.id = $1 AND p.zone_id = $2 AND p.archived_at IS NULL
       GROUP BY p.id`,
      [params.id, params.zoneId],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'policy_not_found' })
    return rows[0]
  })

  fastify.post('/zones/:zoneId/policies', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    if (!(await zoneExists(fastify.db, params.zoneId))) {
      return reply.code(404).send({ error: 'zone_not_found' })
    }
    const body = PolicyBody.parse(req.body)
    const regoErr = validateRego(body.content)
    if (regoErr) return reply.code(422).send({ error: 'invalid_rego', detail: regoErr })
    const policyId = uuidv7()
    const versionId = uuidv7()
    const contentSHA = sha256(body.content)
    const createdBy = req.actor.name

    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO policies (id, zone_id, name, description, owner_type, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [policyId, params.zoneId, body.name, body.description ?? null, body.owner_type ?? 'customer', createdBy],
      )
      const { rows } = await client.query(
        `INSERT INTO policy_versions (id, policy_id, version, content, content_sha256, schema_version, created_by)
         VALUES ($1, $2, 1, $3, $4, $5, $6)
         RETURNING id, policy_id, version, content_sha256, schema_version, created_at`,
        [versionId, policyId, body.content, contentSHA, body.schema_version, createdBy],
      )
      await client.query('COMMIT')
      return reply.code(201).send({ id: policyId, zone_id: params.zoneId, name: body.name, description: body.description ?? null, version: rows[0] })
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  fastify.post('/zones/:zoneId/policies/:id/versions', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const body = VersionBody.parse(req.body)
    const regoErr = validateRego(body.content)
    if (regoErr) return reply.code(422).send({ error: 'invalid_rego', detail: regoErr })

    const versionId = uuidv7()
    const contentSHA = sha256(body.content)
    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [params.id])
      const { rows: policyRows } = await client.query(
        `SELECT id FROM policies WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`,
        [params.id, params.zoneId],
      )
      if (!policyRows[0]) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'policy_not_found' })
      }
      const { rows } = await client.query(
        `WITH next AS (
           SELECT COALESCE(MAX(version), 0) + 1 AS v
           FROM policy_versions WHERE policy_id = $2
         )
         INSERT INTO policy_versions (id, policy_id, version, content, content_sha256, schema_version, created_by)
         SELECT $1, $2, next.v, $3, $4, $5, $6 FROM next
         RETURNING id, policy_id, version, content_sha256, schema_version, created_at`,
        [versionId, params.id, body.content, contentSHA, body.schema_version, req.actor.name],
      )
      await client.query('COMMIT')
      return reply.code(201).send(rows[0])
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  fastify.delete('/zones/:zoneId/policies/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { rowCount } = await fastify.db.query(
      `UPDATE policies SET archived_at = now() WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`,
      [params.id, params.zoneId],
    )
    if (!rowCount) return reply.code(404).send({ error: 'policy_not_found' })
    return reply.code(204).send()
  })
}
