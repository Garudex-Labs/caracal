// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Resource CRUD routes for Gateway-routed protected upstreams.

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { buildPatchUpdate, patchColumn, patchExpression, appendAttribution } from './patch.js'
import { resolveAttribution } from '../attribution.js'
import { ZoneIdParams, ZoneParams, parseParams } from './params.js'
import { zoneExists } from '../zone-guard.js'
import { withTransaction, TxAbort } from '../db.js'
import { appendKeysetCondition, listPage, parseListPagination } from './list-pagination.js'
import { assertReservedNamespace } from '../reserved-namespace.js'

const HttpURL = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  }, 'upstream_url must use http or https')

const ResourceOperation = z.object({
  method: z.string().min(1).max(16),
  path: z.string().min(1).max(512),
  scope: z.string().min(1).max(200),
})

const RESOURCE_SELECT = `id, zone_id, name, identifier, upstream_url, scopes, credential_provider_id, allowed_application_ids, operations, operation_enforcement,
           created_by, created_via_operator, updated_by, updated_via_operator, created_at, updated_at`

const ResourceBodyBase = z.object({
  name: z.string().min(1).max(200).optional(),
  identifier: z.string().min(1).max(512).optional(),
  upstream_url: HttpURL.nullable().optional(),
  scopes: z.array(z.string().min(1).max(200)).min(1).max(64),
  credential_provider_id: z.string().nullable().optional(),
  allowed_application_ids: z.array(z.string().min(1).max(200)).max(64).optional(),
  operations: z.array(ResourceOperation).max(256).optional(),
  operation_enforcement: z.enum(['enforced', 'transport_uniform']).optional(),
})
const ResourceBody = ResourceBodyBase.refine((body) => body.name !== undefined || body.identifier !== undefined, {
  message: 'name_or_identifier_required',
})
const ResourcePatchBody = ResourceBodyBase.partial()

const DEFAULT_CONTROL_AUDIENCE = 'caracal-control'
const NONE_PROVIDER_ID_PREFIX = 'provider-none-'
const NONE_PROVIDER_IDENTIFIER = 'provider://none'
const RESOURCE_IDENTIFIER_PREFIX = 'resource://'
const RESOURCE_IDENTIFIER_UNIQUE_CONSTRAINT = 'resources_zone_id_identifier_key'

interface ResourceQueryClient {
  query<T = unknown>(text: string, values?: unknown[]): Promise<{ rows: T[] }>
}

async function providerExists(fastify: FastifyInstance, zoneId: string, providerId: string): Promise<boolean> {
  const { rows } = await fastify.db.query(`SELECT 1 FROM providers WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`, [
    providerId,
    zoneId,
  ])
  return rows.length > 0
}

async function allowedApplicationsError(
  fastify: FastifyInstance,
  zoneId: string,
  applicationIds: string[],
): Promise<'allowed_application_not_found' | null> {
  if (applicationIds.length === 0) return null
  const { rows } = await fastify.db.query<{ id: string }>(
    `SELECT id FROM applications
     WHERE zone_id = $1 AND id = ANY($2) AND archived_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())`,
    [zoneId, applicationIds],
  )
  const found = new Set(rows.map((row) => row.id))
  return applicationIds.every((id) => found.has(id)) ? null : 'allowed_application_not_found'
}

function dedupeIds(ids: string[]): string[] {
  return [...new Set(ids)]
}

function slugValue(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'resource'
  )
}

function resourceIdentifierFromName(name: string): string {
  const text = name.trim()
  return text.startsWith(RESOURCE_IDENTIFIER_PREFIX) ? text : `${RESOURCE_IDENTIFIER_PREFIX}${slugValue(text)}`
}

function validateResourceIdentifier(identifier: string): string | null {
  if (isControlResource(identifier)) return null
  try {
    const url = new URL(identifier)
    if (url.protocol === 'provider:' || url.username || url.password) throw new Error()
    return null
  } catch {
    return 'resource identifier must be an absolute resource audience URI and must not use the provider:// namespace'
  }
}

async function resourceIdentifierExists(client: ResourceQueryClient, zoneId: string, identifier: string): Promise<boolean> {
  const { rows } = await client.query(`SELECT 1 FROM resources WHERE zone_id = $1 AND identifier = $2`, [zoneId, identifier])
  return rows.length > 0
}

async function nextResourceIdentifier(client: ResourceQueryClient, zoneId: string, name: string): Promise<string> {
  const base = resourceIdentifierFromName(name)
  for (let suffix = 1; suffix < 1000; suffix++) {
    const identifier = suffix === 1 ? base : `${base}-${suffix}`
    if (!(await resourceIdentifierExists(client, zoneId, identifier))) return identifier
  }
  return `${base}-${uuidv7().replace(/-/g, '')}`
}

function isResourceIdentifierConflict(err: unknown): boolean {
  return Boolean(
    err &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505' &&
    'constraint' in err &&
    (err as { constraint?: unknown }).constraint === RESOURCE_IDENTIFIER_UNIQUE_CONSTRAINT,
  )
}

async function ensureNoneProvider(client: ResourceQueryClient, zoneId: string): Promise<string> {
  const id = `${NONE_PROVIDER_ID_PREFIX}${zoneId}`
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO providers (id, zone_id, name, identifier, provider_kind, config_json, secret_config_keys)
     VALUES ($1, $2, 'No credential', $3, 'none', '{}'::jsonb, '{}')
     ON CONFLICT (id) DO UPDATE SET updated_at = providers.updated_at
     RETURNING id`,
    [id, zoneId, NONE_PROVIDER_IDENTIFIER],
  )
  return rows[0]?.id ?? id
}

async function resourceQuotaExceeded(fastify: FastifyInstance, zoneId: string): Promise<boolean> {
  const maxResources = fastify.cfg?.maxResourcesPerZone ?? 0
  if (maxResources <= 0) return false
  const { rows } = await fastify.db.query(
    `SELECT count(*)::bigint AS resource_count
     FROM resources
     WHERE zone_id = $1 AND archived_at IS NULL`,
    [zoneId],
  )
  const count = Number(rows[0]?.resource_count ?? 0)
  return count >= maxResources
}

function validateGatewayRouting(
  identifier: string,
  upstreamURL: string | null | undefined,
  credentialProviderID: string | null | undefined,
): string | null {
  if (isControlResource(identifier)) return null
  if (!credentialProviderID) return 'credential_provider_required'
  if (!upstreamURL) return 'upstream_url_required'
  return null
}

interface ResourceOperationValue {
  method: string
  path: string
  scope: string
}

function normalizeOperations(
  operations: ResourceOperationValue[] | undefined,
  scopes: string[],
): { value: ResourceOperationValue[]; error: string | null } {
  if (!operations) return { value: [], error: null }
  const scopeSet = new Set(scopes)
  const seen = new Set<string>()
  const value: ResourceOperationValue[] = []
  for (const op of operations) {
    const method = op.method.trim().toUpperCase()
    const path = op.path.trim()
    if (!method || !path) return { value: [], error: 'operation_method_and_path_required' }
    if (!path.startsWith('/')) return { value: [], error: 'operation_path_must_be_absolute' }
    if (!scopeSet.has(op.scope)) return { value: [], error: 'operation_scope_not_in_resource_scopes' }
    const key = `${method} ${path}`
    if (seen.has(key)) return { value: [], error: 'operation_duplicate' }
    seen.add(key)
    value.push({ method, path, scope: op.scope })
  }
  return { value, error: null }
}

function controlAudience(): string {
  return process.env.CONTROL_AUDIENCE ?? DEFAULT_CONTROL_AUDIENCE
}

function isControlResource(identifier: string): boolean {
  return identifier === controlAudience()
}

// Managing the control resource (the identity that fronts Caracal's own control
// plane) is restricted to global-scope operators, matching the global-only guard
// on the privileged `control:` trait namespace. Authority is derived from the
// authenticated token scope, never from a client-supplied header.
function isControlResourceOperation(req: FastifyRequest): boolean {
  return req.actor?.scope === 'global'
}

export const resourcesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones/:zoneId/resources', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const page = parseListPagination(req, reply)
    if (!page) return
    const base = { conds: ['r.zone_id = $1', 'r.archived_at IS NULL'], values: [params.zoneId] }
    if (!isControlResourceOperation(req)) {
      base.values.push(controlAudience())
      base.conds.push(`r.identifier <> $${base.values.length}`)
    }
    const keyset = appendKeysetCondition(base, page, 'r.created_at', 'r.id')
    const { rows } = await fastify.db.query(
      `SELECT r.id, r.zone_id, r.name, r.identifier, r.upstream_url, r.scopes,
              r.credential_provider_id, r.allowed_application_ids,
              r.operations, r.operation_enforcement,
              r.created_by, r.created_via_operator, r.updated_by, r.updated_via_operator,
              r.created_at, r.updated_at
       FROM resources r
       WHERE ${keyset.conds.join(' AND ')}
       ORDER BY r.created_at DESC, r.id DESC LIMIT ${keyset.limitPlaceholder}`,
      keyset.values,
    )
    return listPage(rows, page.limit)
  })

  fastify.get('/zones/:zoneId/resources/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `SELECT r.id, r.zone_id, r.name, r.identifier, r.upstream_url, r.scopes,
              r.credential_provider_id, r.allowed_application_ids,
              r.operations, r.operation_enforcement,
              r.created_by, r.created_via_operator, r.updated_by, r.updated_via_operator,
              r.created_at, r.updated_at
       FROM resources r
       WHERE r.id = $1 AND r.zone_id = $2 AND r.archived_at IS NULL`,
      [params.id, params.zoneId],
    )
    const resource = rows[0]
    if (!resource || (isControlResource(resource.identifier) && !isControlResourceOperation(req))) {
      return reply.code(404).send({ error: 'resource_not_found' })
    }
    return resource
  })

  fastify.post('/zones/:zoneId/resources', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    if (!(await zoneExists(fastify.db, params.zoneId))) {
      return reply.code(404).send({ error: 'zone_not_found' })
    }
    const parsed = ResourceBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_resource' })
    const body = parsed.data
    const identifier = body.identifier ?? (await nextResourceIdentifier(fastify.db, params.zoneId, body.name ?? 'resource'))
    const identifierError = validateResourceIdentifier(identifier)
    if (identifierError) return reply.code(400).send({ error: 'invalid_resource_identifier', error_description: identifierError })
    const reservedErr = assertReservedNamespace('resourceIdentifier', identifier, req.actor)
    if (reservedErr) return reply.code(409).send(reservedErr)
    if (isControlResource(identifier) && !isControlResourceOperation(req)) {
      return reply
        .code(409)
        .send({ error: 'protected_resource', error_description: 'control API resource is managed only through the Control console path' })
    }
    const credentialProviderID =
      body.credential_provider_id ??
      (isControlResource(identifier) && isControlResourceOperation(req) ? await ensureNoneProvider(fastify.db, params.zoneId) : null)
    if (credentialProviderID && !(await providerExists(fastify, params.zoneId, credentialProviderID))) {
      return reply.code(404).send({ error: 'provider_not_found' })
    }
    const gatewayError = validateGatewayRouting(identifier, body.upstream_url, credentialProviderID)
    if (gatewayError) return reply.code(400).send({ error: gatewayError })
    const operationCheck = normalizeOperations(body.operations, body.scopes)
    if (operationCheck.error) return reply.code(400).send({ error: operationCheck.error })
    const operationEnforcement = body.operation_enforcement ?? 'enforced'
    const allowedApplicationIds = isControlResource(identifier) ? [] : dedupeIds(body.allowed_application_ids ?? [])
    const allowedError = await allowedApplicationsError(fastify, params.zoneId, allowedApplicationIds)
    if (allowedError) return reply.code(404).send({ error: allowedError })
    if (await resourceQuotaExceeded(fastify, params.zoneId)) {
      return reply.code(409).send({ error: 'resource_quota_exceeded' })
    }
    const id = uuidv7()
    const attribution = await resolveAttribution(req, fastify.db, params.zoneId)
    try {
      const { rows } = await fastify.db.query(
        `INSERT INTO resources (id, zone_id, name, identifier, upstream_url, scopes, credential_provider_id, allowed_application_ids, operations, operation_enforcement, created_by, created_via_operator)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
         RETURNING ${RESOURCE_SELECT}`,
        [
          id,
          params.zoneId,
          body.name ?? identifier,
          identifier,
          body.upstream_url ?? null,
          body.scopes,
          credentialProviderID,
          allowedApplicationIds,
          JSON.stringify(operationCheck.value),
          operationEnforcement,
          attribution.actor,
          attribution.viaOperator,
        ],
      )
      return reply.code(201).send(rows[0])
    } catch (err) {
      if (isResourceIdentifierConflict(err)) return reply.code(409).send({ error: 'resource_identifier_conflict' })
      throw err
    }
  })

  fastify.patch('/zones/:zoneId/resources/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const parsed = ResourcePatchBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_resource' })
    const body = parsed.data
    if (body.credential_provider_id) {
      if (!(await providerExists(fastify, params.zoneId, body.credential_provider_id))) {
        return reply.code(404).send({ error: 'provider_not_found' })
      }
    }
    const requestedAllowedIds = body.allowed_application_ids !== undefined ? dedupeIds(body.allowed_application_ids) : undefined
    if (requestedAllowedIds !== undefined) {
      const allowedError = await allowedApplicationsError(fastify, params.zoneId, requestedAllowedIds)
      if (allowedError) return reply.code(404).send({ error: allowedError })
    }
    try {
      return await withTransaction(fastify.db, async (client) => {
        const { rows: currentRows } = await client.query<{
          identifier: string
          upstream_url: string | null
          credential_provider_id: string | null
          allowed_application_ids: string[]
          scopes: string[]
          operations: ResourceOperationValue[]
        }>(
          `SELECT identifier, upstream_url, credential_provider_id, allowed_application_ids, scopes, operations
           FROM resources
           WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL
           FOR UPDATE`,
          [params.id, params.zoneId],
        )
        const current = currentRows[0]
        if (!current) throw new TxAbort(reply.code(404).send({ error: 'resource_not_found' }))
        const nextIdentifier = body.identifier ?? current.identifier
        const identifierError = validateResourceIdentifier(nextIdentifier)
        if (identifierError) {
          throw new TxAbort(reply.code(400).send({ error: 'invalid_resource_identifier', error_description: identifierError }))
        }
        const reservedErr = assertReservedNamespace('resourceIdentifier', nextIdentifier, req.actor)
        if (reservedErr) {
          throw new TxAbort(reply.code(409).send(reservedErr))
        }
        if ((isControlResource(current.identifier) || isControlResource(nextIdentifier)) && !isControlResourceOperation(req)) {
          throw new TxAbort(
            reply.code(409).send({
              error: 'protected_resource',
              error_description: 'control API resource is managed only through the Control console path',
            }),
          )
        }
        const nextUpstreamURL = body.upstream_url !== undefined ? body.upstream_url : current.upstream_url
        let nextCredentialProviderID =
          body.credential_provider_id !== undefined ? body.credential_provider_id : current.credential_provider_id
        if (isControlResource(nextIdentifier) && isControlResourceOperation(req) && !nextCredentialProviderID) {
          nextCredentialProviderID = await ensureNoneProvider(client, params.zoneId)
          body.credential_provider_id = nextCredentialProviderID
        }
        const gatewayError = validateGatewayRouting(nextIdentifier, nextUpstreamURL, nextCredentialProviderID)
        if (gatewayError) throw new TxAbort(reply.code(400).send({ error: gatewayError }))
        const nextAllowedApplicationIds = isControlResource(nextIdentifier) ? [] : (requestedAllowedIds ?? current.allowed_application_ids)
        const writeAllowedIds =
          requestedAllowedIds !== undefined || (isControlResource(nextIdentifier) && current.allowed_application_ids.length > 0)
        const effectiveScopes = body.scopes ?? current.scopes
        const effectiveOperations = body.operations ?? current.operations
        const operationCheck = normalizeOperations(effectiveOperations, effectiveScopes)
        if (operationCheck.error) throw new TxAbort(reply.code(400).send({ error: operationCheck.error }))
        const update = buildPatchUpdate(
          [params.id, params.zoneId],
          [
            patchColumn('name', body.name),
            patchColumn('identifier', body.identifier),
            patchColumn('upstream_url', body.upstream_url),
            patchColumn('scopes', body.scopes),
            patchColumn('credential_provider_id', body.credential_provider_id),
            patchExpression(
              writeAllowedIds ? nextAllowedApplicationIds : undefined,
              (placeholder) => `allowed_application_ids = ${placeholder}`,
            ),
            patchExpression(
              body.operations !== undefined ? JSON.stringify(operationCheck.value) : undefined,
              (placeholder) => `operations = ${placeholder}::jsonb`,
            ),
            patchColumn('operation_enforcement', body.operation_enforcement),
          ],
        )
        if (!update) {
          throw new TxAbort(reply.code(400).send({ error: 'no_fields' }))
        }
        appendAttribution(update, await resolveAttribution(req, client, params.zoneId))
        const { rows } = await client.query(
          `UPDATE resources SET ${update.sets.join(', ')}, updated_at = now()
           WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL
           RETURNING ${RESOURCE_SELECT}`,
          update.values,
        )
        return rows[0]
      })
    } catch (err) {
      if (isResourceIdentifierConflict(err)) return reply.code(409).send({ error: 'resource_identifier_conflict' })
      throw err
    }
  })

  fastify.delete('/zones/:zoneId/resources/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const attribution = await resolveAttribution(req, fastify.db, params.zoneId)
    return withTransaction(fastify.db, async (client) => {
      const { rows: currentRows } = await client.query<{ identifier: string }>(
        `SELECT identifier FROM resources
         WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL
         FOR UPDATE`,
        [params.id, params.zoneId],
      )
      const current = currentRows[0]
      if (!current) throw new TxAbort(reply.code(404).send({ error: 'resource_not_found' }))
      if (isControlResource(current.identifier)) {
        throw new TxAbort(
          reply.code(409).send({ error: 'protected_resource', error_description: 'control API resource cannot be deleted' }),
        )
      }
      await client.query(
        `UPDATE resources SET archived_at = now(), updated_at = now(), updated_by = $3, updated_via_operator = $4
         WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`,
        [params.id, params.zoneId, attribution.actor, attribution.viaOperator],
      )
      return reply.code(204).send()
    })
  })
}
