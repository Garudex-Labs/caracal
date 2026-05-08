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
import { ZoneIdParams, ZoneParams, parseParams } from './params.js'
import { zoneExists } from '../zone-guard.js'
import { validateAuthzPolicy } from '../rego.js'
import { publicAppsReferencedByContents } from '../policy-invariants.js'

const MANIFEST_MAX_ENTRIES = 256

const PolicySetBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
})

const PolicySetVersionBody = z.object({
  manifest: z.array(z.object({ policy_version_id: z.string().min(1) })).min(1).max(MANIFEST_MAX_ENTRIES),
  schema_version: z.string().default('2026-03-16'),
})

const ActivateBody = z.object({
  version_id: z.string().min(1),
  shadow_version_id: z.string().min(1).optional(),
})

const VersionParams = z.object({ zoneId: z.string().regex(/^[A-Za-z0-9_.\-:]{1,128}$/), id: z.string().regex(/^[A-Za-z0-9_.\-:]{1,128}$/), versionId: z.string().regex(/^[A-Za-z0-9_.\-:]{1,128}$/) })

export const policySetsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones/:zoneId/policy-sets', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `SELECT ps.id, ps.zone_id, ps.name, ps.description, ps.created_at,
              psb.active_version_id
       FROM policy_sets ps
       LEFT JOIN policy_set_bindings psb ON psb.policy_set_id = ps.id AND psb.zone_id = ps.zone_id
       WHERE ps.zone_id = $1 AND ps.archived_at IS NULL ORDER BY ps.created_at DESC`,
      [params.zoneId],
    )
    return rows
  })

  fastify.get('/zones/:zoneId/policy-sets/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `SELECT ps.id, ps.zone_id, ps.name, ps.description, ps.created_at,
              psb.active_version_id
       FROM policy_sets ps
       LEFT JOIN policy_set_bindings psb ON psb.policy_set_id = ps.id AND psb.zone_id = ps.zone_id
       WHERE ps.id = $1 AND ps.zone_id = $2 AND ps.archived_at IS NULL`,
      [params.id, params.zoneId],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'policy_set_not_found' })
    return rows[0]
  })

  fastify.post('/zones/:zoneId/policy-sets', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    if (!(await zoneExists(fastify.db, params.zoneId))) {
      return reply.code(404).send({ error: 'zone_not_found' })
    }
    const body = PolicySetBody.parse(req.body)
    const id = uuidv7()

    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `INSERT INTO policy_sets (id, zone_id, name, description, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, zone_id, name, description, created_at`,
        [id, params.zoneId, body.name, body.description ?? null, req.actor.name],
      )
      await client.query(
        `INSERT INTO policy_set_bindings (zone_id, policy_set_id)
         VALUES ($1, $2)`,
        [params.zoneId, id],
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
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const body = PolicySetVersionBody.parse(req.body)

    const { rows: psRows } = await fastify.db.query(
      `SELECT id FROM policy_sets WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`,
      [params.id, params.zoneId],
    )
    if (!psRows[0]) return reply.code(404).send({ error: 'policy_set_not_found' })

    const contractErr = await policySetContractError(fastify.db, params.zoneId, body.manifest)
    if (contractErr) return reply.code(422).send({ error: 'invalid_policy_contract', detail: contractErr })

    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [params.id])
      const manifestJSON = JSON.stringify(body.manifest)
      const manifestSHA = createHash('sha256').update(manifestJSON).digest('hex')
      const versionId = uuidv7()

      const { rows } = await client.query(
        `WITH next AS (
           SELECT COALESCE(MAX(version), 0) + 1 AS v
           FROM policy_set_versions WHERE policy_set_id = $2
         )
         INSERT INTO policy_set_versions (id, policy_set_id, version, manifest_json, manifest_sha256, schema_version, created_by)
         SELECT $1, $2, next.v, $3::jsonb, $4, $5, $6 FROM next
         RETURNING id, policy_set_id, version, manifest_sha256, schema_version, created_at`,
        [versionId, params.id, manifestJSON, manifestSHA, body.schema_version, req.actor.name],
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
    const params = parseParams(VersionParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `SELECT psv.id, psv.policy_set_id, psv.version, psv.manifest_json, psv.manifest_sha256,
              psv.schema_version, psv.created_at,
              (SELECT json_agg(entry->>'policy_version_id')
               FROM jsonb_array_elements(psv.manifest_json) AS entry) AS policies
       FROM policy_set_versions psv
       JOIN policy_sets ps ON ps.id = psv.policy_set_id
       WHERE psv.id = $1 AND psv.policy_set_id = $2 AND ps.zone_id = $3`,
      [params.versionId, params.id, params.zoneId],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'policy_set_version_not_found' })
    return rows[0]
  })

  fastify.post('/zones/:zoneId/policy-sets/:id/activate', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const body = ActivateBody.parse(req.body)

    const { rows: vRows } = await fastify.db.query<{ id: string; manifest_json: PolicyManifest }>(
      `SELECT psv.id, psv.manifest_json
       FROM policy_set_versions psv
       JOIN policy_sets ps ON ps.id = psv.policy_set_id
       WHERE psv.id = $1 AND psv.policy_set_id = $2 AND ps.zone_id = $3 AND ps.archived_at IS NULL`,
      [body.version_id, params.id, params.zoneId],
    )
    if (!vRows[0]) return reply.code(404).send({ error: 'version_not_found' })
    const contractErr = await policySetContractError(fastify.db, params.zoneId, vRows[0].manifest_json)
    if (contractErr) return reply.code(422).send({ error: 'invalid_policy_contract', detail: contractErr })

    if (body.shadow_version_id) {
      const { rows: shadowRows } = await fastify.db.query<{ id: string; manifest_json: PolicyManifest }>(
        `SELECT psv.id, psv.manifest_json
         FROM policy_set_versions psv
         JOIN policy_sets ps ON ps.id = psv.policy_set_id
         WHERE psv.id = $1 AND psv.policy_set_id = $2 AND ps.zone_id = $3 AND ps.archived_at IS NULL`,
        [body.shadow_version_id, params.id, params.zoneId],
      )
      if (!shadowRows[0]) return reply.code(404).send({ error: 'shadow_version_not_found' })
      const shadowErr = await policySetContractError(fastify.db, params.zoneId, shadowRows[0].manifest_json)
      if (shadowErr) return reply.code(422).send({ error: 'invalid_shadow_policy_contract', detail: shadowErr })
    }

    const client = await fastify.db.connect()
    let outboxId: string
    try {
      await client.query('BEGIN')
      const referencedIds = collectManifestIds(vRows[0].manifest_json)
      if (body.shadow_version_id) {
        const { rows: shadowVer } = await client.query<{ manifest_json: PolicyManifest }>(
          `SELECT manifest_json FROM policy_set_versions WHERE id = $1`,
          [body.shadow_version_id],
        )
        if (shadowVer[0]) referencedIds.push(...collectManifestIds(shadowVer[0].manifest_json))
      }
      // Hold SHARE locks on every referenced policy_version row so a concurrent
      // delete of one of them blocks until activation commits. This closes the
      // TOCTOU between policySetContractError and the UPDATE below.
      if (referencedIds.length > 0) {
        const { rows: locked } = await client.query<{ id: string }>(
          `SELECT id FROM policy_versions WHERE id = ANY($1::text[]) FOR SHARE`,
          [Array.from(new Set(referencedIds))],
        )
        if (locked.length !== new Set(referencedIds).size) {
          await client.query('ROLLBACK')
          return reply.code(409).send({ error: 'referenced_policy_version_missing' })
        }
      }
      const { rowCount } = await client.query(
        `UPDATE policy_set_bindings
         SET active_version_id = $1, shadow_version_id = $2, updated_at = now()
         WHERE zone_id = $3 AND policy_set_id = $4`,
        [body.version_id, body.shadow_version_id ?? null, params.zoneId, params.id],
      )
      if (!rowCount) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'policy_set_binding_not_found' })
      }
      outboxId = await enqueueOutbox(client, {
        streamName: STREAM_POLICY_INVALIDATE,
        payload: {
          zone_id: params.zoneId,
          policy_set_id: params.id,
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
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { rowCount } = await fastify.db.query(
      `UPDATE policy_sets SET archived_at = now(), updated_at = now()
       WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`,
      [params.id, params.zoneId],
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

function collectManifestIds(manifest: string | PolicyManifest): string[] {
  const list = Array.isArray(manifest) ? manifest : safeParseManifest(manifest)
  return list
    .map((entry) => entry.policy_version_id)
    .filter((id): id is string => typeof id === 'string' && id !== '')
}

function safeParseManifest(raw: string): PolicyManifest {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed as PolicyManifest : []
  } catch {
    return []
  }
}

async function policySetContractError(
  db: Queryable,
  zoneId: string,
  manifestJSON: string | PolicyManifest,
): Promise<string | null> {
  const manifest = Array.isArray(manifestJSON) ? manifestJSON : safeParseManifest(manifestJSON)
  const rawIds = collectManifestIds(manifest)
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
    const err = validateAuthzPolicy(String(row.content))
    if (err === 'must_use_package_caracal_authz') {
      return `policy version ${row.id} must use package caracal.authz`
    }
    if (err === 'must_define_result_rule') {
      return `policy version ${row.id} must emit data.caracal.authz.result`
    }
    if (err) {
      return `policy version ${row.id} failed validation: ${err}`
    }
  }
  const publicHits = await publicAppsReferencedByContents(
    db,
    zoneId,
    rows.map((r) => String(r.content)),
  )
  if (publicHits.length > 0) {
    return `policy references public application(s): ${publicHits.join(', ')}`
  }
  return null
}
