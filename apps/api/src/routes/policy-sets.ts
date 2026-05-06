// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Policy set CRUD and activation routes: atomic version pinning with durable STS invalidation.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { createHash } from 'crypto'
import { v7 as uuidv7 } from 'uuid'
import { STREAM_POLICY_INVALIDATE } from '../redis.js'
import { enqueueOutbox } from '../outbox.js'

const MANIFEST_MAX_ENTRIES = 256

const PolicySetBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  created_by: z.string().default('api'),
})

const PolicySetVersionBody = z.object({
  manifest: z.array(z.object({ policy_version_id: z.string().min(1) })).min(1).max(MANIFEST_MAX_ENTRIES),
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

    const contractErr = await policySetContractError(fastify.db, zoneId, body.manifest)
    if (contractErr) return reply.code(422).send({ error: 'invalid_policy_contract', detail: contractErr })

    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      const { rows: maxRows } = await client.query<{ max_v: string }>(
        `SELECT COALESCE(MAX(version), 0) AS max_v FROM policy_set_versions
         WHERE policy_set_id = $1 FOR UPDATE`,
        [id],
      )
      const nextVersion = parseInt(maxRows[0].max_v, 10) + 1
      const manifestJSON = JSON.stringify(body.manifest)
      const manifestSHA = createHash('sha256').update(manifestJSON).digest('hex')
      const versionId = uuidv7()

      const { rows } = await client.query(
        `INSERT INTO policy_set_versions (id, policy_set_id, version, manifest_json, manifest_sha256, schema_version, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
         RETURNING id, policy_set_id, version, manifest_sha256, schema_version, created_at`,
        [versionId, id, nextVersion, manifestJSON, manifestSHA, body.schema_version, body.created_by],
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

  fastify.post('/zones/:zoneId/policy-sets/:id/activate', async (req, reply) => {
    const { zoneId, id } = req.params as { zoneId: string; id: string }
    const body = ActivateBody.parse(req.body)

    const { rows: vRows } = await fastify.db.query<{ id: string; manifest_json: PolicyManifest }>(
      `SELECT psv.id, psv.manifest_json
       FROM policy_set_versions psv
       JOIN policy_sets ps ON ps.id = psv.policy_set_id
       WHERE psv.id = $1 AND psv.policy_set_id = $2 AND ps.zone_id = $3`,
      [body.version_id, id, zoneId],
    )
    if (!vRows[0]) return reply.code(404).send({ error: 'version_not_found' })
    const contractErr = await policySetContractError(fastify.db, zoneId, vRows[0].manifest_json)
    if (contractErr) return reply.code(422).send({ error: 'invalid_policy_contract', detail: contractErr })

    if (body.shadow_version_id) {
      const { rows: shadowRows } = await fastify.db.query<{ id: string; manifest_json: PolicyManifest }>(
        `SELECT psv.id, psv.manifest_json
         FROM policy_set_versions psv
         JOIN policy_sets ps ON ps.id = psv.policy_set_id
         WHERE psv.id = $1 AND psv.policy_set_id = $2 AND ps.zone_id = $3`,
        [body.shadow_version_id, id, zoneId],
      )
      if (!shadowRows[0]) return reply.code(404).send({ error: 'shadow_version_not_found' })
      const shadowErr = await policySetContractError(fastify.db, zoneId, shadowRows[0].manifest_json)
      if (shadowErr) return reply.code(422).send({ error: 'invalid_shadow_policy_contract', detail: shadowErr })
    }

    const client = await fastify.db.connect()
    let outboxId: string
    try {
      await client.query('BEGIN')
      const { rowCount } = await client.query(
        `UPDATE policy_set_bindings
         SET active_version_id = $1, shadow_version_id = $2, updated_at = now()
         WHERE zone_id = $3 AND policy_set_id = $4`,
        [body.version_id, body.shadow_version_id ?? null, zoneId, id],
      )
      if (!rowCount) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'policy_set_binding_not_found' })
      }
      outboxId = await enqueueOutbox(client, {
        streamName: STREAM_POLICY_INVALIDATE,
        payload: {
          zone_id: zoneId,
          policy_set_id: id,
          policy_set_version_id: body.version_id,
          shadow_version_id: body.shadow_version_id ?? null,
        },
        requestId: req.id,
      })
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    return reply.code(202).send({
      activated: true,
      version_id: body.version_id,
      shadow_version_id: body.shadow_version_id ?? null,
      outbox_id: outboxId,
    })
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
  zone_id: string
}

type Queryable = {
  query: <T = PolicyVersionRow>(text: string, params?: QueryParam[]) => Promise<{ rows: T[] }>
}

type PolicyManifest = Array<{ policy_version_id?: string }>

async function policySetContractError(
  db: Queryable,
  zoneId: string,
  manifestJSON: string | PolicyManifest,
): Promise<string | null> {
  const manifest = Array.isArray(manifestJSON) ? manifestJSON : JSON.parse(manifestJSON) as PolicyManifest
  const rawIds = manifest
    .map((entry) => entry.policy_version_id)
    .filter((id): id is string => typeof id === 'string' && id !== '')
  if (rawIds.length === 0) return 'policy set manifest must reference at least one policy version'
  if (rawIds.length > MANIFEST_MAX_ENTRIES) {
    return `policy set manifest exceeds maximum of ${MANIFEST_MAX_ENTRIES} entries`
  }
  const ids = Array.from(new Set(rawIds))
  if (ids.length !== rawIds.length) {
    return 'policy set manifest contains duplicate policy_version_id entries'
  }
  const { rows } = await db.query<PolicyVersionRow>(
    `SELECT pv.id, pv.content, p.zone_id
     FROM policy_versions pv
     JOIN policies p ON p.id = pv.policy_id
     WHERE pv.id = ANY($1::text[])`,
    [ids],
  )
  if (rows.length !== ids.length) return 'policy set manifest references missing policy versions'
  for (const row of rows) {
    if (row.zone_id !== zoneId) {
      return `policy version ${row.id} belongs to a different zone`
    }
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
