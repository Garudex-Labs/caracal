// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Policy CRUD routes: immutable Rego versions with SHA-256 stamping.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { sha256Hex } from '@caracalai/server-core'
import { v7 as uuidv7 } from 'uuid'
import { ZoneIdParams, ZoneParams, parseParams } from './params.js'
import { zoneExists } from '../zone-guard.js'
import { withTransaction, TxAbort } from '../db.js'
import { OPA_INPUT_SCHEMA_VERSION, previewAuthzPolicy, validateAuthzPolicy, validatePolicySchemaVersion } from '../rego.js'
import { appendKeysetCondition, listPage, parseListPagination } from './list-pagination.js'
import { assertReservedNamespace } from '../reserved-namespace.js'
import { resolveAttribution } from '../attribution.js'

const PolicyBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  owner_type: z.string().optional(),
  content: z.string().min(1),
  schema_version: z.string().default(OPA_INPUT_SCHEMA_VERSION),
})

const VersionBody = z.object({
  content: z.string().min(1),
  schema_version: z.string().default(OPA_INPUT_SCHEMA_VERSION),
})

const ValidateBody = z.object({
  content: z.string().min(1),
  schema_version: z.string().default(OPA_INPUT_SCHEMA_VERSION),
})

function validateRego(content: string): string | null {
  return validateAuthzPolicy(content)
}

export const policiesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/policies/validate', async (req, reply) => {
    const body = ValidateBody.parse(req.body)
    const schemaErr = validatePolicySchemaVersion(body.schema_version)
    if (schemaErr) return reply.code(422).send({ valid: false, error: 'invalid_schema_version', error_description: schemaErr })
    const regoErr = validateRego(body.content)
    if (regoErr) return reply.code(422).send({ valid: false, error: 'invalid_rego', error_description: regoErr })
    return {
      valid: true,
      schema_version: body.schema_version,
      input_schema_version: OPA_INPUT_SCHEMA_VERSION,
      output_contract: {
        package: 'caracal.authz',
        rule: 'result',
        decision: ['allow', 'deny'],
        evaluation_status: ['complete'],
      },
      preview: previewAuthzPolicy(body.content),
    }
  })

  fastify.get('/zones/:zoneId/policies', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const page = parseListPagination(req, reply)
    if (!page) return
    const keyset = appendKeysetCondition({ conds: ['zone_id = $1', 'archived_at IS NULL'], values: [params.zoneId] }, page)
    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, name, description, owner_type, created_by, created_via_operator, updated_by, updated_via_operator, created_at, updated_at
       FROM policies WHERE ${keyset.conds.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ${keyset.limitPlaceholder}`,
      keyset.values,
    )
    return listPage(rows, page.limit)
  })

  fastify.get('/zones/:zoneId/policies/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `SELECT p.id, p.zone_id, p.name, p.description, p.owner_type, p.created_by, p.created_via_operator,
              p.updated_by, p.updated_via_operator, p.created_at, p.updated_at,
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
    const reservedErr = assertReservedNamespace('policyName', body.name, req.actor)
    if (reservedErr) return reply.code(409).send(reservedErr)
    const schemaErr = validatePolicySchemaVersion(body.schema_version)
    if (schemaErr) return reply.code(422).send({ error: 'invalid_schema_version', error_description: schemaErr })
    const regoErr = validateRego(body.content)
    if (regoErr) return reply.code(422).send({ error: 'invalid_rego', error_description: regoErr })
    const policyId = uuidv7()
    const versionId = uuidv7()
    const contentSHA = sha256Hex(body.content)
    const attribution = await resolveAttribution(req, fastify.db, params.zoneId)

    return withTransaction(fastify.db, async (client) => {
      await client.query(
        `INSERT INTO policies (id, zone_id, name, description, owner_type, created_by, created_via_operator)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          policyId,
          params.zoneId,
          body.name,
          body.description ?? null,
          body.owner_type ?? 'customer',
          attribution.actor,
          attribution.viaOperator,
        ],
      )
      const { rows } = await client.query(
        `INSERT INTO policy_versions (id, policy_id, version, content, content_sha256, schema_version, created_by, created_via_operator)
         VALUES ($1, $2, 1, $3, $4, $5, $6, $7)
         RETURNING id, policy_id, version, content_sha256, schema_version, created_at`,
        [versionId, policyId, body.content, contentSHA, body.schema_version, attribution.actor, attribution.viaOperator],
      )
      return reply.code(201).send({
        id: policyId,
        version_id: rows[0].id,
        zone_id: params.zoneId,
        name: body.name,
        description: body.description ?? null,
        version: rows[0],
      })
    })
  })

  fastify.post('/zones/:zoneId/policies/:id/versions', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const body = VersionBody.parse(req.body)
    const schemaErr = validatePolicySchemaVersion(body.schema_version)
    if (schemaErr) return reply.code(422).send({ error: 'invalid_schema_version', error_description: schemaErr })
    const regoErr = validateRego(body.content)
    if (regoErr) return reply.code(422).send({ error: 'invalid_rego', error_description: regoErr })

    const versionId = uuidv7()
    const contentSHA = sha256Hex(body.content)
    const attribution = await resolveAttribution(req, fastify.db, params.zoneId)
    return withTransaction(fastify.db, async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [params.id])
      const { rows: policyRows } = await client.query(`SELECT id FROM policies WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`, [
        params.id,
        params.zoneId,
      ])
      if (!policyRows[0]) throw new TxAbort(reply.code(404).send({ error: 'policy_not_found' }))
      const { rows } = await client.query(
        `WITH next AS (
           SELECT COALESCE(MAX(version), 0) + 1 AS v
           FROM policy_versions WHERE policy_id = $2
         )
         INSERT INTO policy_versions (id, policy_id, version, content, content_sha256, schema_version, created_by, created_via_operator)
         SELECT $1, $2, next.v, $3, $4, $5, $6, $7 FROM next
         RETURNING id, policy_id, version, content_sha256, schema_version, created_at`,
        [versionId, params.id, body.content, contentSHA, body.schema_version, attribution.actor, attribution.viaOperator],
      )
      await client.query(
        `UPDATE policies SET updated_by = $3, updated_via_operator = $4, updated_at = now() WHERE id = $1 AND zone_id = $2`,
        [params.id, params.zoneId, attribution.actor, attribution.viaOperator],
      )
      return reply.code(201).send({ version_id: rows[0].id, ...rows[0] })
    })
  })

  fastify.delete('/zones/:zoneId/policies/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const attribution = await resolveAttribution(req, fastify.db, params.zoneId)
    const { rowCount } = await fastify.db.query(
      `UPDATE policies SET archived_at = now(), updated_at = now(), updated_by = $3, updated_via_operator = $4
       WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`,
      [params.id, params.zoneId, attribution.actor, attribution.viaOperator],
    )
    if (!rowCount) return reply.code(404).send({ error: 'policy_not_found' })
    return reply.code(204).send()
  })
}
