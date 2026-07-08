// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Workload CRUD routes: launcher identities and their credential bindings for caracal run.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { randomBytes } from 'node:crypto'
import { assertCredentialEnvName } from '@caracalai/engine/runtime-config'
import { SecretBackendError, workloadSecretRef } from '@caracalai/server-core'
import { hashClientSecret } from '../hash-secret.js'
import { withTransaction, TxAbort } from '../db.js'
import { enqueueCredentialRevealAudit } from '../credential-audit.js'
import { buildPatchUpdate, patchColumn } from './patch.js'
import { ZoneIdParams, ZoneParams, parseParams } from './params.js'
import { zoneExists } from '../zone-guard.js'
import { appendKeysetCondition, listPage, parseListPagination } from './list-pagination.js'
import { resolveAttribution } from '../attribution.js'

const NAME_MAX_LENGTH = 200
const RESOURCE_MAX_LENGTH = 500
const SCOPE_MAX_LENGTH = 200
const BINDINGS_MAX = 64
const SCOPES_MAX = 32

const WorkloadBinding = z
  .object({
    env: z.string().trim().min(1).max(NAME_MAX_LENGTH),
    resource: z.string().trim().min(1).max(RESOURCE_MAX_LENGTH),
    scopes: z.array(z.string().trim().min(1).max(SCOPE_MAX_LENGTH)).max(SCOPES_MAX).default([]),
    optional: z.boolean().default(false),
    on_failure: z.enum(['warn', 'error']).default('error'),
  })
  .strict()

const CreateBody = z
  .object({
    name: z.string().trim().min(1).max(NAME_MAX_LENGTH),
  })
  .strict()

const UpdateBody = z
  .object({
    name: z.string().trim().min(1).max(NAME_MAX_LENGTH).optional(),
    bindings: z.array(WorkloadBinding).max(BINDINGS_MAX).optional(),
  })
  .strict()

// Normalizes validated bindings into their stored form: env names are checked against
// the engine's injection blocklist, duplicates are rejected, and optional-only fields
// are kept only where they apply.
function normalizeBindings(
  bindings: z.infer<typeof WorkloadBinding>[],
): { bindings: Record<string, unknown>[] } | { error: { error: string; details: { env: string } } } {
  const seen = new Set<string>()
  for (const binding of bindings) {
    try {
      assertCredentialEnvName(binding.env)
    } catch {
      return { error: { error: 'invalid_credential_env', details: { env: binding.env } } }
    }
    if (seen.has(binding.env)) return { error: { error: 'duplicate_credential_env', details: { env: binding.env } } }
    seen.add(binding.env)
  }
  return {
    bindings: bindings.map((binding) => ({
      env: binding.env,
      resource: binding.resource,
      ...(binding.scopes.length > 0 ? { scopes: binding.scopes } : {}),
      ...(binding.optional ? { optional: true, on_failure: binding.on_failure } : {}),
    })),
  }
}

function generateWorkloadSecret(): string {
  return `ws_${randomBytes(32).toString('base64url')}`
}

const WORKLOAD_SELECT =
  'id, zone_id, name, bindings, created_by, created_via_operator, created_at, updated_by, updated_via_operator, updated_at'

// Reports whether another workload in the zone already uses the name, case-insensitively,
// so launcher identities stay unambiguous. excludeId lets a rename skip the workload
// being renamed.
async function nameTaken(
  db: { query: <T = unknown>(text: string, params?: unknown[]) => Promise<{ rows: T[] }> },
  zoneId: string,
  name: string,
  excludeId?: string,
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM workloads
      WHERE zone_id = $1 AND lower(name) = lower($2) AND id IS DISTINCT FROM $3
      LIMIT 1`,
    [zoneId, name, excludeId ?? null],
  )
  return rows.length > 0
}

export const workloadsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones/:zoneId/workloads', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const page = parseListPagination(req, reply)
    if (!page) return
    const keyset = appendKeysetCondition({ conds: ['zone_id = $1'], values: [params.zoneId] }, page)
    const { rows } = await fastify.db.query(
      `SELECT ${WORKLOAD_SELECT}
       FROM workloads WHERE ${keyset.conds.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ${keyset.limitPlaceholder}`,
      keyset.values,
    )
    return listPage(rows, page.limit)
  })

  fastify.get('/zones/:zoneId/workloads/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(`SELECT ${WORKLOAD_SELECT} FROM workloads WHERE id = $1 AND zone_id = $2`, [
      params.id,
      params.zoneId,
    ])
    if (!rows[0]) return reply.code(404).send({ error: 'workload_not_found' })
    return rows[0]
  })

  fastify.post('/zones/:zoneId/workloads', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    if (!(await zoneExists(fastify.db, params.zoneId))) {
      return reply.code(404).send({ error: 'zone_not_found' })
    }
    const parsed = CreateBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_workload' })
    if (await nameTaken(fastify.db, params.zoneId, parsed.data.name)) {
      return reply.code(409).send({ error: 'workload_name_taken' })
    }
    const secret = generateWorkloadSecret()
    const secretHash = await hashClientSecret(secret)
    const attribution = await resolveAttribution(req, fastify.db, params.zoneId)
    const id = uuidv7()
    try {
      const row = await withTransaction(fastify.db, async (client) => {
        const { rows } = await client.query<Record<string, unknown>>(
          `INSERT INTO workloads (id, zone_id, name, secret_hash, created_by, created_via_operator)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING ${WORKLOAD_SELECT}`,
          [id, params.zoneId, parsed.data.name, secretHash, attribution.actor, attribution.viaOperator],
        )
        // Authentication verifies only the hash; the sealed custody copy lets operators
        // retrieve the secret later instead of couriering it at creation time.
        await fastify.secrets.put(workloadSecretRef(params.zoneId, id), Buffer.from(secret))
        return rows[0]
      })
      return reply.code(201).send({ ...row, secret })
    } catch (err) {
      if (err instanceof SecretBackendError) {
        req.log.error({ err }, 'secret backend rejected workload credential write')
        return reply.code(502).send({ error: 'secret_backend_unavailable' })
      }
      throw err
    }
  })

  fastify.put('/zones/:zoneId/workloads/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const parsed = UpdateBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_workload' })
    const body = parsed.data
    if (body.name === undefined && body.bindings === undefined) return reply.code(400).send({ error: 'no_fields' })
    if (body.name !== undefined && (await nameTaken(fastify.db, params.zoneId, body.name, params.id))) {
      return reply.code(409).send({ error: 'workload_name_taken' })
    }
    let storedBindings: string | undefined
    if (body.bindings !== undefined) {
      const normalized = normalizeBindings(body.bindings)
      if ('error' in normalized) return reply.code(400).send(normalized.error)
      storedBindings = JSON.stringify(normalized.bindings)
    }
    const attribution = await resolveAttribution(req, fastify.db, params.zoneId)
    const update = buildPatchUpdate(
      [params.id, params.zoneId],
      [
        patchColumn('name', body.name),
        patchColumn('bindings', storedBindings),
        patchColumn('updated_by', attribution.actor),
        patchColumn('updated_via_operator', attribution.viaOperator),
      ],
    )
    if (!update) return reply.code(400).send({ error: 'no_fields' })
    const { rows } = await fastify.db.query(
      `UPDATE workloads SET ${update.sets.join(', ')}, updated_at = now()
       WHERE id = $1 AND zone_id = $2
       RETURNING ${WORKLOAD_SELECT}`,
      update.values,
    )
    if (!rows[0]) return reply.code(404).send({ error: 'workload_not_found' })
    return rows[0]
  })

  fastify.post('/zones/:zoneId/workloads/:id/rotate-secret', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const secret = generateWorkloadSecret()
    const secretHash = await hashClientSecret(secret)
    const attribution = await resolveAttribution(req, fastify.db, params.zoneId)
    try {
      const row = await withTransaction(fastify.db, async (client) => {
        const { rows } = await client.query(
          `UPDATE workloads SET secret_hash = $3, updated_by = $4, updated_via_operator = $5, updated_at = now()
           WHERE id = $1 AND zone_id = $2
           RETURNING ${WORKLOAD_SELECT}`,
          [params.id, params.zoneId, secretHash, attribution.actor, attribution.viaOperator],
        )
        if (!rows[0]) throw new TxAbort(null)
        await fastify.secrets.put(workloadSecretRef(params.zoneId, params.id), Buffer.from(secret))
        return rows[0]
      })
      if (!row) return reply.code(404).send({ error: 'workload_not_found' })
      return { ...row, secret }
    } catch (err) {
      if (err instanceof SecretBackendError) {
        req.log.error({ err }, 'secret backend rejected workload credential write')
        return reply.code(502).send({ error: 'secret_backend_unavailable' })
      }
      throw err
    }
  })

  fastify.get('/zones/:zoneId/workloads/:id/secret', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query<{ name: string }>(`SELECT name FROM workloads WHERE id = $1 AND zone_id = $2`, [
      params.id,
      params.zoneId,
    ])
    if (!rows[0]) return reply.code(404).send({ error: 'workload_not_found' })
    let value: Buffer | null
    try {
      value = await fastify.secrets.get(workloadSecretRef(params.zoneId, params.id))
    } catch (err) {
      if (err instanceof SecretBackendError) {
        req.log.error({ err }, 'secret backend rejected workload credential read')
        return reply.code(502).send({ error: 'secret_backend_unavailable' })
      }
      throw err
    }
    // Workloads created before credential custody have only their hash; rotating
    // issues a fresh secret and stores it.
    if (value === null) return reply.code(404).send({ error: 'workload_secret_not_stored' })
    const attribution = await resolveAttribution(req, fastify.db, params.zoneId)
    await withTransaction(fastify.db, (client) =>
      enqueueCredentialRevealAudit(client, fastify.cfg?.auditHmacKey ?? null, req, params.zoneId, {
        credential: 'workload_secret',
        workload_id: params.id,
        workload_name: rows[0].name,
        actor: attribution.actor,
      }),
    )
    return { secret: value.toString() }
  })

  fastify.delete('/zones/:zoneId/workloads/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { rowCount } = await fastify.db.query(`DELETE FROM workloads WHERE id = $1 AND zone_id = $2`, [params.id, params.zoneId])
    if (!rowCount) return reply.code(404).send({ error: 'workload_not_found' })
    // Deletion is the authority change; custody cleanup is best-effort because the
    // deleted identity no longer authenticates anything.
    try {
      await fastify.secrets.delete(workloadSecretRef(params.zoneId, params.id))
    } catch (err) {
      req.log.warn({ err }, 'deleted workload credential could not be deleted from the secret backend')
    }
    return reply.code(204).send()
  })
}
