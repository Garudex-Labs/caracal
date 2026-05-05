// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Policy set CRUD and activation routes: atomic version pinning with STS invalidation.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { createHash } from 'crypto'
import { v7 as uuidv7 } from 'uuid'
import { publishPolicyInvalidation } from '../redis.js'

const PolicySetBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  created_by: z.string().default('api'),
})

const PolicySetVersionBody = z.object({
  manifest: z.array(z.object({ policy_version_id: z.string() })).min(1),
  schema_version: z.string().default('2026-03-16'),
  created_by: z.string().default('api'),
})

const ActivateBody = z.object({
  version_id: z.string().min(1),
  shadow_version_id: z.string().min(1).optional(),
})

export const policySetsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones/:zoneId/policy-sets', async (req) => {
    const { zoneId } = req.params as { zoneId: string }
    const { rows } = await fastify.db.query(
      `SELECT ps.id, ps.zone_id, ps.name, ps.description, ps.created_at,
              psb.active_version_id
       FROM policy_sets ps
       LEFT JOIN policy_set_bindings psb ON psb.policy_set_id = ps.id AND psb.zone_id = ps.zone_id
       WHERE ps.zone_id = $1 AND ps.archived_at IS NULL ORDER BY ps.created_at DESC`,
      [zoneId],
    )
    return rows
  })

  fastify.get('/zones/:zoneId/policy-sets/:id', async (req, reply) => {
    const { zoneId, id } = req.params as { zoneId: string; id: string }
    const { rows } = await fastify.db.query(
      `SELECT ps.id, ps.zone_id, ps.name, ps.description, ps.created_at,
              psb.active_version_id
       FROM policy_sets ps
       LEFT JOIN policy_set_bindings psb ON psb.policy_set_id = ps.id AND psb.zone_id = ps.zone_id
       WHERE ps.id = $1 AND ps.zone_id = $2`,
      [id, zoneId],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'policy_set_not_found' })
    return rows[0]
  })

  fastify.post('/zones/:zoneId/policy-sets', async (req, reply) => {
    const { zoneId } = req.params as { zoneId: string }
    const body = PolicySetBody.parse(req.body)
    const id = uuidv7()

    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `INSERT INTO policy_sets (id, zone_id, name, description, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, zone_id, name, description, created_at`,
        [id, zoneId, body.name, body.description ?? null, body.created_by],
      )
      // Create binding row (no active version yet)
      await client.query(
        `INSERT INTO policy_set_bindings (zone_id, policy_set_id)
         VALUES ($1, $2)`,
        [zoneId, id],
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

  fastify.post('/zones/:zoneId/policy-sets/:id/versions', async (req, reply) => {
    const { zoneId, id } = req.params as { zoneId: string; id: string }
    const body = PolicySetVersionBody.parse(req.body)

    const { rows: psRows } = await fastify.db.query(
      'SELECT id FROM policy_sets WHERE id = $1 AND zone_id = $2',
      [id, zoneId],
    )
    if (!psRows[0]) return reply.code(404).send({ error: 'policy_set_not_found' })

    const { rows: maxRows } = await fastify.db.query(
      'SELECT COALESCE(MAX(version), 0) AS max_v FROM policy_set_versions WHERE policy_set_id = $1',
      [id],
    )
    const nextVersion = parseInt(maxRows[0].max_v, 10) + 1
    const manifestJSON = JSON.stringify(body.manifest)
    const manifestSHA = createHash('sha256').update(manifestJSON).digest('hex')
    const versionId = uuidv7()

    const { rows } = await fastify.db.query(
      `INSERT INTO policy_set_versions (id, policy_set_id, version, manifest_json, manifest_sha256, schema_version, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
       RETURNING id, policy_set_id, version, manifest_sha256, schema_version, created_at`,
      [versionId, id, nextVersion, manifestJSON, manifestSHA, body.schema_version, body.created_by],
    )
    return reply.code(201).send(rows[0])
  })

  fastify.get('/zones/:zoneId/policy-sets/:id/versions/:versionId', async (req, reply) => {
    const { zoneId, id, versionId } = req.params as { zoneId: string; id: string; versionId: string }
    const { rows } = await fastify.db.query(
            `SELECT psv.id, psv.policy_set_id, psv.version, psv.manifest_json, psv.manifest_sha256,
              psv.schema_version, psv.created_at,
              (SELECT json_agg(entry->>'policy_version_id')
               FROM jsonb_array_elements(psv.manifest_json) AS entry) AS policies
       FROM policy_set_versions psv
       JOIN policy_sets ps ON ps.id = psv.policy_set_id
       WHERE psv.id = $1 AND psv.policy_set_id = $2 AND ps.zone_id = $3`,
      [versionId, id, zoneId],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'policy_set_version_not_found' })
    return rows[0]
  })

  // Atomically sets active_version_id and emits invalidation event to STS.
  fastify.post('/zones/:zoneId/policy-sets/:id/activate', async (req, reply) => {
    const { zoneId, id } = req.params as { zoneId: string; id: string }
    const body = ActivateBody.parse(req.body)

    const { rows: vRows } = await fastify.db.query(
      'SELECT id, manifest_json FROM policy_set_versions WHERE id = $1 AND policy_set_id = $2',
      [body.version_id, id],
    )
    if (!vRows[0]) return reply.code(404).send({ error: 'version_not_found' })
    const contractErr = await policySetContractError(fastify.db, vRows[0].manifest_json)
    if (contractErr) return reply.code(422).send({ error: 'invalid_policy_contract', detail: contractErr })

    if (body.shadow_version_id) {
      const { rows: shadowRows } = await fastify.db.query(
        'SELECT id, manifest_json FROM policy_set_versions WHERE id = $1 AND policy_set_id = $2',
        [body.shadow_version_id, id],
      )
      if (!shadowRows[0]) return reply.code(404).send({ error: 'shadow_version_not_found' })
      const shadowErr = await policySetContractError(fastify.db, shadowRows[0].manifest_json)
      if (shadowErr) return reply.code(422).send({ error: 'invalid_shadow_policy_contract', detail: shadowErr })
    }

    await fastify.db.query(
      `UPDATE policy_set_bindings SET active_version_id = $1, shadow_version_id = $2, updated_at = now()
       WHERE zone_id = $3 AND policy_set_id = $4`,
      [body.version_id, body.shadow_version_id ?? null, zoneId, id],
    )

    await publishPolicyInvalidation(fastify.redis, zoneId, body.version_id)

    return { activated: true, version_id: body.version_id, shadow_version_id: body.shadow_version_id ?? null }
  })

  fastify.delete('/zones/:zoneId/policy-sets/:id', async (req, reply) => {
    const { zoneId, id } = req.params as { zoneId: string; id: string }
    const { rowCount } = await fastify.db.query(
      'UPDATE policy_sets SET archived_at = now(), updated_at = now() WHERE id = $1 AND zone_id = $2',
      [id, zoneId],
    )
    if (!rowCount) return reply.code(404).send({ error: 'policy_set_not_found' })
    return reply.code(204).send()
  })
}

type QueryParam = string | number | boolean | null | string[]

interface PolicyVersionRow {
  id: string
  content: string
}

type Queryable = {
  query: (text: string, params?: QueryParam[]) => Promise<{ rows: PolicyVersionRow[] }>
}

type PolicyManifest = Array<{ policy_version_id?: string }>

async function policySetContractError(db: Queryable, manifestJSON: string | PolicyManifest): Promise<string | null> {
  const manifest = Array.isArray(manifestJSON) ? manifestJSON : JSON.parse(manifestJSON) as PolicyManifest
  const ids = manifest
    .map((entry) => entry.policy_version_id)
    .filter((id): id is string => typeof id === 'string' && id !== '')
  if (ids.length === 0) return 'policy set manifest must reference at least one policy version'
  const { rows } = await db.query(
    `SELECT id, content FROM policy_versions WHERE id = ANY($1::text[])`,
    [ids],
  )
  if (rows.length !== ids.length) return 'policy set manifest references missing policy versions'
  for (const row of rows) {
    const content = String(row.content)
    if (!/package\s+caracal\.authz\b/.test(content)) {
      return `policy version ${row.id} must use package caracal.authz`
    }
    if (!/\bresult\b/.test(content)) {
      return `policy version ${row.id} must emit data.caracal.authz.result`
    }
  }
  return null
}
