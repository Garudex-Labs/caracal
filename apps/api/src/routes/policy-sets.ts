// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Policy set CRUD and activation routes: atomic version pinning with durable STS invalidation.

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { GATEWAY_REQUEST_HEADER, GATEWAY_SIGNATURE_HEADER, GATEWAY_TIMESTAMP_HEADER, sha256Hex, signGatewayExchange } from '@caracalai/core'
import { v7 as uuidv7 } from 'uuid'
import { STREAM_POLICY_INVALIDATE } from '../redis.js'
import { enqueueOutbox } from '../outbox.js'
import { ZoneIdParams, ZoneParams, parseParams } from './params.js'
import { zoneExists } from '../zone-guard.js'
import { OPA_INPUT_SCHEMA_VERSION, validateAuthzPolicy, validatePolicySchemaVersion } from '../rego.js'
import { appendKeysetCondition, parseListPagination, setNextLink } from './list-pagination.js'
import type { Queryable } from '../db.js'
import { withTransaction, TxAbort } from '../db.js'

const MANIFEST_MAX_ENTRIES = 256

const PolicySetBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
})

const PolicySetVersionBody = z.object({
  manifest: z
    .array(z.object({ policy_version_id: z.string().min(1) }))
    .min(1)
    .max(MANIFEST_MAX_ENTRIES),
  schema_version: z.string().default(OPA_INPUT_SCHEMA_VERSION),
})

const ActivateBody = z.object({
  version_id: z.string().min(1),
  shadow_version_id: z.string().min(1).optional(),
})
const ActivationStatusQuery = z.object({
  version_id: z.string().min(1).optional(),
  outbox_id: z.string().min(1).optional(),
})
const SimulateBody = z.object({
  version_id: z.string().min(1),
  input: z.record(z.string(), z.unknown()).optional(),
})

const VersionParams = z.object({
  zoneId: z.string().regex(/^[A-Za-z0-9_.\-:]{1,128}$/),
  id: z.string().regex(/^[A-Za-z0-9_.\-:]{1,128}$/),
  versionId: z.string().regex(/^[A-Za-z0-9_.\-:]{1,128}$/),
})

export const policySetsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones/:zoneId/policy-sets', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const page = parseListPagination(req, reply)
    if (!page) return
    const keyset = appendKeysetCondition(
      { conds: ['ps.zone_id = $1', 'ps.archived_at IS NULL'], values: [params.zoneId] },
      page,
      'ps.created_at',
      'ps.id',
    )
    const { rows } = await fastify.db.query(
      `SELECT ps.id, ps.zone_id, ps.name, ps.description, ps.created_at,
              psb.active_version_id
       FROM policy_sets ps
       LEFT JOIN policy_set_bindings psb ON psb.policy_set_id = ps.id AND psb.zone_id = ps.zone_id
       WHERE ${keyset.conds.join(' AND ')}
       ORDER BY ps.created_at DESC, ps.id DESC LIMIT ${keyset.limitPlaceholder}`,
      keyset.values,
    )
    setNextLink(req, reply, rows, page.limit)
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

    return withTransaction(fastify.db, async (client) => {
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
      return reply.code(201).send(rows[0])
    })
  })

  fastify.post('/zones/:zoneId/policy-sets/:id/versions', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const body = PolicySetVersionBody.parse(req.body)
    const schemaErr = validatePolicySchemaVersion(body.schema_version)
    if (schemaErr) return reply.code(422).send({ error: 'invalid_schema_version', detail: schemaErr })

    const { rows: psRows } = await fastify.db.query(`SELECT id FROM policy_sets WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`, [
      params.id,
      params.zoneId,
    ])
    if (!psRows[0]) return reply.code(404).send({ error: 'policy_set_not_found' })

    const contractErr = await policySetContractError(fastify.db, params.zoneId, body.manifest, body.schema_version)
    if (contractErr) return reply.code(422).send({ error: 'invalid_policy_contract', detail: contractErr })

    return withTransaction(fastify.db, async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [params.id])
      const manifestJSON = JSON.stringify(body.manifest)
      const manifestSHA = sha256Hex(manifestJSON)
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
      return reply.code(201).send({ version_id: rows[0].id, ...rows[0] })
    })
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

    const { rows: vRows } = await fastify.db.query<{ id: string; manifest_json: PolicyManifest; schema_version: string }>(
      `SELECT psv.id, psv.manifest_json, psv.schema_version
       FROM policy_set_versions psv
       JOIN policy_sets ps ON ps.id = psv.policy_set_id
       WHERE psv.id = $1 AND psv.policy_set_id = $2 AND ps.zone_id = $3 AND ps.archived_at IS NULL`,
      [body.version_id, params.id, params.zoneId],
    )
    if (!vRows[0]) return reply.code(404).send({ error: 'version_not_found' })
    const contractErr = await policySetContractError(fastify.db, params.zoneId, vRows[0].manifest_json, vRows[0].schema_version)
    if (contractErr) return reply.code(422).send({ error: 'invalid_policy_contract', detail: contractErr })

    if (body.shadow_version_id) {
      const { rows: shadowRows } = await fastify.db.query<{ id: string; manifest_json: PolicyManifest; schema_version: string }>(
        `SELECT psv.id, psv.manifest_json, psv.schema_version
         FROM policy_set_versions psv
         JOIN policy_sets ps ON ps.id = psv.policy_set_id
         WHERE psv.id = $1 AND psv.policy_set_id = $2 AND ps.zone_id = $3 AND ps.archived_at IS NULL`,
        [body.shadow_version_id, params.id, params.zoneId],
      )
      if (!shadowRows[0]) return reply.code(404).send({ error: 'shadow_version_not_found' })
      const shadowErr = await policySetContractError(fastify.db, params.zoneId, shadowRows[0].manifest_json, shadowRows[0].schema_version)
      if (shadowErr) return reply.code(422).send({ error: 'invalid_shadow_policy_contract', detail: shadowErr })
    }

    const outboxId = await withTransaction(fastify.db, async (client) => {
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
        const { rowCount: lockedCount } = await client.query(`SELECT id FROM policy_versions WHERE id = ANY($1::text[]) FOR SHARE`, [
          Array.from(new Set(referencedIds)),
        ])
        if ((lockedCount ?? 0) !== new Set(referencedIds).size) {
          throw new TxAbort(reply.code(409).send({ error: 'referenced_policy_version_missing' }))
        }
      }
      const { rowCount } = await client.query(
        `UPDATE policy_set_bindings
         SET active_version_id = $1, shadow_version_id = $2, updated_at = now()
         WHERE zone_id = $3 AND policy_set_id = $4`,
        [body.version_id, body.shadow_version_id ?? null, params.zoneId, params.id],
      )
      if (!rowCount) {
        throw new TxAbort(reply.code(404).send({ error: 'policy_set_binding_not_found' }))
      }
      return enqueueOutbox(client, {
        streamName: STREAM_POLICY_INVALIDATE,
        payload: {
          zone_id: params.zoneId,
          policy_set_id: params.id,
          policy_set_version_id: body.version_id,
          shadow_version_id: body.shadow_version_id ?? null,
        },
        requestId: req.id,
      })
    })

    if (reply.sent) return reply

    return reply.code(202).send({
      activated: true,
      version_id: body.version_id,
      shadow_version_id: body.shadow_version_id ?? null,
      outbox_id: outboxId,
      status_url: `/v1/zones/${encodeURIComponent(params.zoneId)}/policy-sets/${encodeURIComponent(params.id)}/activation-status?version_id=${encodeURIComponent(body.version_id)}&outbox_id=${encodeURIComponent(outboxId)}`,
    })
  })

  fastify.get('/zones/:zoneId/policy-sets/:id/activation-status', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const query = ActivationStatusQuery.parse(req.query)
    const { rows } = await fastify.db.query<{
      active_version_id: string | null
      shadow_version_id: string | null
      manifest_sha256: string | null
    }>(
      `SELECT psb.active_version_id, psb.shadow_version_id, psv.manifest_sha256
       FROM policy_set_bindings psb
       JOIN policy_sets ps ON ps.id = psb.policy_set_id AND ps.zone_id = psb.zone_id
       LEFT JOIN policy_set_versions psv ON psv.id = psb.active_version_id
       WHERE psb.zone_id = $1 AND psb.policy_set_id = $2 AND ps.archived_at IS NULL`,
      [params.zoneId, params.id],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'policy_set_binding_not_found' })
    const versionId = query.version_id ?? rows[0].active_version_id
    if (!versionId) return reply.code(404).send({ error: 'active_policy_set_version_not_found' })
    const outbox = await policyActivationOutboxStatus(fastify.db, {
      zoneId: params.zoneId,
      policySetId: params.id,
      versionId,
      outboxId: query.outbox_id,
    })
    const sts = await fetchSTSPolicyStatus(fastify, params.zoneId)
    const active = rows[0].active_version_id === versionId
    const stsLoaded = sts.loaded === true && sts.policy_set_version_id === versionId
    return {
      zone_id: params.zoneId,
      policy_set_id: params.id,
      version_id: versionId,
      active,
      active_version_id: rows[0].active_version_id,
      shadow_version_id: rows[0].shadow_version_id,
      manifest_sha256: rows[0].manifest_sha256,
      propagation_status: activationPropagationStatus(active, outbox.state, stsLoaded, sts.state),
      outbox,
      sts,
    }
  })

  fastify.post('/zones/:zoneId/policy-sets/:id/simulate', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const body = SimulateBody.parse(req.body)
    const { rows } = await fastify.db.query<{ id: string; manifest_json: PolicyManifest; manifest_sha256: string; schema_version: string }>(
      `SELECT psv.id, psv.manifest_json, psv.manifest_sha256, psv.schema_version
       FROM policy_set_versions psv
       JOIN policy_sets ps ON ps.id = psv.policy_set_id
       WHERE psv.id = $1 AND psv.policy_set_id = $2 AND ps.zone_id = $3 AND ps.archived_at IS NULL`,
      [body.version_id, params.id, params.zoneId],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'version_not_found' })
    const contract = await policySetContract(fastify.db, params.zoneId, rows[0].manifest_json, rows[0].schema_version)
    if (contract.error) return reply.code(422).send({ error: 'invalid_policy_contract', detail: contract.error })
    const inputWarnings = validateSimulationInput(body.input, params.zoneId)
    const execution = body.input
      ? await executePolicySimulation(fastify, {
          policy_set_id: params.id,
          version_id: rows[0].id,
          manifest_sha256: rows[0].manifest_sha256,
          policies: contract.policies.map((policy) => ({ id: policy.id, content: policy.content })),
          input: body.input,
        })
      : null
    return {
      dry_run: true,
      would_activate: inputWarnings.length === 0,
      policy_set_id: params.id,
      version_id: rows[0].id,
      schema_version: rows[0].schema_version,
      input_schema_version: OPA_INPUT_SCHEMA_VERSION,
      manifest_sha256: rows[0].manifest_sha256,
      policies: collectManifestIds(rows[0].manifest_json),
      warnings: [...inputWarnings, ...(execution?.warnings ?? [])],
      explanation: execution?.explanation ?? {
        evaluation: 'not_executed',
        reason: body.input
          ? 'STS simulation is not configured; rollout contract and input shape were validated without mutating active policy bindings'
          : 'simulation validates rollout contract and input shape without mutating active policy bindings',
      },
      result: execution?.result ?? null,
    }
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

interface PolicyVersionRow {
  id: string
  content: string
  zone_id: string
  schema_version: string
}

type PolicyManifest = Array<{ policy_version_id?: string }>

interface PolicySetContract {
  policies: PolicyVersionRow[]
  error: string | null
}

interface PolicySimulationRequest {
  policy_set_id: string
  version_id: string
  manifest_sha256: string
  policies: Array<{ id: string; content: string }>
  input: Record<string, unknown>
}

interface PolicySimulationExecution {
  warnings: string[]
  explanation: Record<string, unknown>
  result: Record<string, unknown> | null
}

interface PolicyActivationOutboxRequest {
  zoneId: string
  policySetId: string
  versionId: string
  outboxId?: string
}

interface PolicyActivationOutboxStatus {
  id: string | null
  state: 'dispatched' | 'pending' | 'dead' | 'missing' | 'mismatch'
  attempts: number
  last_error: string | null
  dispatched_at: string | null
}

interface STSPolicyStatus {
  state: 'loaded' | 'not_loaded' | 'not_configured' | 'unreachable' | 'failed'
  loaded?: boolean
  zone_id?: string
  policy_set_version_id?: string
  manifest_sha256?: string
  loaded_at?: string
  age_seconds?: number
  detail?: string
}

function collectManifestIds(manifest: string | PolicyManifest): string[] {
  const list = Array.isArray(manifest) ? manifest : parseManifest(manifest)
  return list.map((entry) => entry.policy_version_id).filter((id): id is string => typeof id === 'string' && id !== '')
}

function parseManifest(raw: string): PolicyManifest {
  const parsed = JSON.parse(raw)
  return Array.isArray(parsed) ? (parsed as PolicyManifest) : []
}

async function policySetContractError(
  db: Queryable,
  zoneId: string,
  manifestJSON: string | PolicyManifest,
  schemaVersion: string,
): Promise<string | null> {
  return (await policySetContract(db, zoneId, manifestJSON, schemaVersion)).error
}

async function policySetContract(
  db: Queryable,
  zoneId: string,
  manifestJSON: string | PolicyManifest,
  schemaVersion: string,
): Promise<PolicySetContract> {
  const schemaErr = validatePolicySchemaVersion(schemaVersion)
  if (schemaErr) return { policies: [], error: schemaErr }
  const manifest = Array.isArray(manifestJSON) ? manifestJSON : parseManifest(manifestJSON)
  const rawIds = collectManifestIds(manifest)
  if (rawIds.length === 0) return { policies: [], error: 'policy set manifest must reference at least one policy version' }
  if (rawIds.length > MANIFEST_MAX_ENTRIES) {
    return { policies: [], error: `policy set manifest exceeds maximum of ${MANIFEST_MAX_ENTRIES} entries` }
  }
  const ids = Array.from(new Set(rawIds))
  if (ids.length !== rawIds.length) {
    return { policies: [], error: 'policy set manifest contains duplicate policy_version_id entries' }
  }
  const { rows } = await db.query<PolicyVersionRow>(
    `SELECT pv.id, pv.content, pv.schema_version, p.zone_id
     FROM policy_versions pv
     JOIN policies p ON p.id = pv.policy_id
     WHERE pv.id = ANY($1::text[])`,
    [ids],
  )
  if (rows.length !== ids.length) return { policies: [], error: 'policy set manifest references missing policy versions' }
  for (const row of rows) {
    if (row.zone_id !== zoneId) {
      return { policies: [], error: `policy version ${row.id} belongs to a different zone` }
    }
    if (row.schema_version !== schemaVersion) {
      return {
        policies: [],
        error: `policy version ${row.id} schema ${row.schema_version} does not match policy set schema ${schemaVersion}`,
      }
    }
    const versionErr = validatePolicySchemaVersion(row.schema_version)
    if (versionErr) return { policies: [], error: `policy version ${row.id} failed schema validation: ${versionErr}` }
    const err = validateAuthzPolicy(String(row.content))
    if (err === 'must_use_package_caracal_authz') {
      return { policies: [], error: `policy version ${row.id} must use package caracal.authz` }
    }
    if (err === 'must_be_data_document') {
      return { policies: [], error: `policy version ${row.id} must be a data document marked # caracal:data-document` }
    }
    if (err === 'data_document_must_not_define_result') {
      return { policies: [], error: `policy version ${row.id} must not define result; the platform decision contract owns every decision` }
    }
    if (err) {
      return { policies: [], error: `policy version ${row.id} failed validation: ${err}` }
    }
  }
  return { policies: rows, error: null }
}

async function executePolicySimulation(
  fastify: FastifyInstance,
  request: PolicySimulationRequest,
): Promise<PolicySimulationExecution | null> {
  if (!fastify.cfg?.gatewayStsHmacKey) return null
  const body = Buffer.from(JSON.stringify(request), 'utf8')
  const requestId = uuidv7()
  const timestamp = Math.floor(Date.now() / 1000)
  let response: Response
  try {
    response = await fetch(new URL('/internal/policy/simulate', fastify.cfg.stsUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [GATEWAY_TIMESTAMP_HEADER]: String(timestamp),
        [GATEWAY_REQUEST_HEADER]: requestId,
        [GATEWAY_SIGNATURE_HEADER]: signGatewayExchange(
          fastify.cfg.gatewayStsHmacKey,
          timestamp,
          requestId,
          'POST',
          '/internal/policy/simulate',
          body,
        ),
      },
      body,
    })
  } catch (err) {
    return {
      warnings: [`sts_simulation_unreachable:${err instanceof Error ? err.message : String(err)}`],
      explanation: {
        evaluation: 'failed',
        reason: 'STS simulation endpoint is unreachable',
      },
      result: null,
    }
  }
  let payload: Record<string, unknown>
  try {
    payload = (await response.json()) as Record<string, unknown>
  } catch (err) {
    return {
      warnings: [`sts_simulation_invalid_response:${err instanceof Error ? err.message : String(err)}`],
      explanation: {
        evaluation: 'failed',
        reason: 'STS simulation returned an unparseable response',
      },
      result: null,
    }
  }
  if (!response.ok) {
    return {
      warnings: [`sts_simulation_failed:${String(payload.error ?? response.status)}`],
      explanation: {
        evaluation: 'failed',
        reason: payload.detail ?? payload.error ?? 'STS simulation failed',
      },
      result: null,
    }
  }
  return {
    warnings: [],
    explanation: {
      evaluation: 'executed',
      decision: payload.result && typeof payload.result === 'object' ? (payload.result as Record<string, unknown>).decision : undefined,
      policy_set_version_id: payload.version_id,
      manifest_sha256: payload.manifest_sha256,
      reason: 'OPA evaluated the supplied input through the STS runtime engine without mutating active policy bindings',
    },
    result: payload.result && typeof payload.result === 'object' ? (payload.result as Record<string, unknown>) : null,
  }
}

async function policyActivationOutboxStatus(db: Queryable, request: PolicyActivationOutboxRequest): Promise<PolicyActivationOutboxStatus> {
  const expected = {
    zone_id: request.zoneId,
    policy_set_id: request.policySetId,
    policy_set_version_id: request.versionId,
  }
  const params: string[] = request.outboxId ? [request.outboxId] : [STREAM_POLICY_INVALIDATE, JSON.stringify(expected)]
  const sql = request.outboxId
    ? `SELECT id, stream_name, payload_json, attempts, last_error, dispatched_at, available_at
       FROM event_outbox WHERE id = $1`
    : `SELECT id, stream_name, payload_json, attempts, last_error, dispatched_at, available_at
       FROM event_outbox
       WHERE stream_name = $1 AND payload_json @> $2::jsonb
       ORDER BY created_at DESC LIMIT 1`
  const { rows } = await db.query<{
    id: string
    stream_name: string
    payload_json: Record<string, unknown>
    attempts: number
    last_error: string | null
    dispatched_at: Date | string | null
    available_at: Date | string | null
  }>(sql, params)
  const row = rows[0]
  if (!row) {
    return { id: request.outboxId ?? null, state: 'missing', attempts: 0, last_error: null, dispatched_at: null }
  }
  if (
    row.stream_name !== STREAM_POLICY_INVALIDATE ||
    row.payload_json.zone_id !== request.zoneId ||
    row.payload_json.policy_set_id !== request.policySetId ||
    row.payload_json.policy_set_version_id !== request.versionId
  ) {
    return {
      id: row.id,
      state: 'mismatch',
      attempts: row.attempts,
      last_error: row.last_error,
      dispatched_at: formatDate(row.dispatched_at),
    }
  }
  const state = row.dispatched_at ? 'dispatched' : String(row.available_at) === 'infinity' ? 'dead' : 'pending'
  return { id: row.id, state, attempts: row.attempts, last_error: row.last_error, dispatched_at: formatDate(row.dispatched_at) }
}

async function fetchSTSPolicyStatus(fastify: FastifyInstance, zoneId: string): Promise<STSPolicyStatus> {
  if (!fastify.cfg?.gatewayStsHmacKey) return { state: 'not_configured', detail: 'GATEWAY_STS_HMAC_KEY is not configured' }
  const path = `/internal/policy/status/${encodeURIComponent(zoneId)}`
  const requestId = uuidv7()
  const timestamp = Math.floor(Date.now() / 1000)
  let response: Response
  try {
    response = await fetch(new URL(path, fastify.cfg.stsUrl), {
      method: 'GET',
      headers: {
        [GATEWAY_TIMESTAMP_HEADER]: String(timestamp),
        [GATEWAY_REQUEST_HEADER]: requestId,
        [GATEWAY_SIGNATURE_HEADER]: signGatewayExchange(fastify.cfg.gatewayStsHmacKey, timestamp, requestId, 'GET', path, Buffer.alloc(0)),
      },
    })
  } catch (err) {
    return { state: 'unreachable', detail: err instanceof Error ? err.message : String(err) }
  }
  let payload: Record<string, unknown>
  try {
    payload = (await response.json()) as Record<string, unknown>
  } catch (err) {
    return { state: 'failed', detail: `invalid STS response: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!response.ok) {
    return { state: 'failed', detail: String(payload.detail ?? payload.error ?? response.status) }
  }
  const loaded = payload.loaded === true
  return {
    state: loaded ? 'loaded' : 'not_loaded',
    loaded,
    zone_id: typeof payload.zone_id === 'string' ? payload.zone_id : undefined,
    policy_set_version_id: typeof payload.policy_set_version_id === 'string' ? payload.policy_set_version_id : undefined,
    manifest_sha256: typeof payload.manifest_sha256 === 'string' ? payload.manifest_sha256 : undefined,
    loaded_at: typeof payload.loaded_at === 'string' ? payload.loaded_at : undefined,
    age_seconds: typeof payload.age_seconds === 'number' ? payload.age_seconds : undefined,
  }
}

function activationPropagationStatus(
  active: boolean,
  outboxState: PolicyActivationOutboxStatus['state'],
  stsLoaded: boolean,
  stsState: STSPolicyStatus['state'],
): 'loaded' | 'waiting_for_activation' | 'waiting_for_outbox' | 'waiting_for_sts' | 'failed' {
  if (!active) return 'waiting_for_activation'
  if (outboxState === 'dead' || outboxState === 'mismatch') return 'failed'
  if (outboxState !== 'dispatched') return 'waiting_for_outbox'
  if (stsLoaded) return 'loaded'
  if (stsState === 'failed') return 'failed'
  return 'waiting_for_sts'
}

function formatDate(value: Date | string | null): string | null {
  if (!value) return null
  return value instanceof Date ? value.toISOString() : value
}

function validateSimulationInput(input: Record<string, unknown> | undefined, zoneId: string): string[] {
  if (!input) return []
  const warnings: string[] = []
  if (input.schema_version !== undefined && input.schema_version !== OPA_INPUT_SCHEMA_VERSION) {
    warnings.push(`input_schema_mismatch:${String(input.schema_version)}`)
  }
  const principal = input.principal as Record<string, unknown> | undefined
  if (!principal || principal.zone_id !== zoneId) warnings.push('principal_zone_mismatch')
  if (!input.resource || typeof input.resource !== 'object') warnings.push('missing_resource')
  if (!input.action || typeof input.action !== 'object') warnings.push('missing_action')
  if (!input.context || typeof input.context !== 'object') warnings.push('missing_context')
  return warnings
}
