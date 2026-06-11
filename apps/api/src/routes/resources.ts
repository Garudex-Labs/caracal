// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Resource CRUD routes for Gateway-routed protected upstreams.

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { buildPatchUpdate, patchColumn } from './patch.js'
import { ZoneIdParams, ZoneParams, parseParams } from './params.js'
import { zoneExists } from '../zone-guard.js'
import { withTransaction, TxAbort } from '../db.js'
import { appendKeysetCondition, parseListPagination, setNextLink } from './list-pagination.js'

const HttpURL = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol
  return protocol === 'http:' || protocol === 'https:'
}, 'upstream_url must use http or https')

const ResourceBodyBase = z.object({
  name: z.string().min(1).optional(),
  identifier: z.string().min(1).optional(),
  upstream_url: HttpURL.nullable().optional(),
  scopes: z.array(z.string()).min(1),
  credential_provider_id: z.string().nullable().optional(),
  gateway_application_id: z.string().min(1).nullable().optional(),
})
const ResourceBody = ResourceBodyBase.refine((body) => body.name !== undefined || body.identifier !== undefined, { message: 'name_or_identifier_required' })
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
  const { rows } = await fastify.db.query(
    `SELECT 1 FROM providers WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`,
    [providerId, zoneId],
  )
  return rows.length > 0
}

async function gatewayApplicationError(
  fastify: FastifyInstance,
  zoneId: string,
  applicationId: string,
): Promise<'gateway_application_not_found' | 'gateway_exchange_application_must_be_managed' | null> {
  const { rows } = await fastify.db.query<{ registration_method: string }>(
    `SELECT registration_method FROM applications
     WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())`,
    [applicationId, zoneId],
  )
  if (rows.length === 0) return 'gateway_application_not_found'
  if (rows[0].registration_method !== 'managed') return 'gateway_exchange_application_must_be_managed'
  return null
}

function slugValue(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'resource'
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
  const { rows } = await client.query(
    `SELECT 1 FROM resources WHERE zone_id = $1 AND identifier = $2`,
    [zoneId, identifier],
  )
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
    err
    && typeof err === 'object'
    && 'code' in err
    && (err as { code?: unknown }).code === '23505'
    && 'constraint' in err
    && (err as { constraint?: unknown }).constraint === RESOURCE_IDENTIFIER_UNIQUE_CONSTRAINT,
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

function validateGatewayBinding(
  identifier: string,
  upstreamURL: string | null | undefined,
  gatewayApplicationID: string | null | undefined,
  credentialProviderID: string | null | undefined,
): string | null {
  if (isControlResource(identifier)) return null
  if (!credentialProviderID) return 'credential_provider_required'
  if (!upstreamURL) return 'upstream_url_required'
  if (!gatewayApplicationID) return 'gateway_application_required'
  return null
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

async function syncGatewayBinding(
  client: PoolClient,
  zoneId: string,
  resourceIdentifier: string,
  gatewayApplicationID: string | null,
): Promise<void> {
  if (!gatewayApplicationID) {
    await client.query(
      `DELETE FROM gateway_resource_bindings
       WHERE resource_identifier = $1 AND zone_id = $2`,
      [resourceIdentifier, zoneId],
    )
    await bumpGatewayBindingRevision(client)
    return
  }
  await client.query(
    `INSERT INTO gateway_resource_bindings (resource_identifier, zone_id, application_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (zone_id, resource_identifier)
     DO UPDATE SET zone_id = EXCLUDED.zone_id,
                   application_id = EXCLUDED.application_id,
                    updated_at = now()`,
    [resourceIdentifier, zoneId, gatewayApplicationID],
  )
  await bumpGatewayBindingRevision(client)
}

async function bumpGatewayBindingRevision(client: PoolClient): Promise<void> {
  await client.query(
    `UPDATE gateway_binding_revision
     SET version = version + 1,
         updated_at = now()
     WHERE id = true`,
  )
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
    const keyset = appendKeysetCondition(
      base,
      page,
      'r.created_at',
      'r.id',
    )
    const { rows } = await fastify.db.query(
      `SELECT r.id, r.zone_id, r.name, r.identifier, r.upstream_url, r.scopes,
              r.credential_provider_id, b.application_id AS gateway_application_id,
              r.created_at, r.updated_at
       FROM resources r
       LEFT JOIN gateway_resource_bindings b
         ON b.zone_id = r.zone_id AND b.resource_identifier = r.identifier
       WHERE ${keyset.conds.join(' AND ')}
       ORDER BY r.created_at DESC, r.id DESC LIMIT ${keyset.limitPlaceholder}`,
      keyset.values,
    )
    setNextLink(req, reply, rows, page.limit)
    return rows
  })

  fastify.get('/zones/:zoneId/resources/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `SELECT r.id, r.zone_id, r.name, r.identifier, r.upstream_url, r.scopes,
              r.credential_provider_id, b.application_id AS gateway_application_id,
              r.created_at, r.updated_at
       FROM resources r
       LEFT JOIN gateway_resource_bindings b
         ON b.zone_id = r.zone_id AND b.resource_identifier = r.identifier
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
    const identifier = body.identifier ?? await nextResourceIdentifier(fastify.db, params.zoneId, body.name ?? 'resource')
    const identifierError = validateResourceIdentifier(identifier)
    if (identifierError) return reply.code(400).send({ error: 'invalid_resource_identifier', message: identifierError })
    if (isControlResource(identifier) && !isControlResourceOperation(req)) {
      return reply.code(409).send({ error: 'protected_resource', detail: 'control API resource is managed only through the Control console path' })
    }
    const credentialProviderID = body.credential_provider_id ?? (
      isControlResource(identifier) && isControlResourceOperation(req)
        ? await ensureNoneProvider(fastify.db, params.zoneId)
        : null
    )
    if (credentialProviderID && !(await providerExists(fastify, params.zoneId, credentialProviderID))) {
      return reply.code(404).send({ error: 'provider_not_found' })
    }
    const gatewayError = validateGatewayBinding(identifier, body.upstream_url, body.gateway_application_id, credentialProviderID)
    if (gatewayError) return reply.code(400).send({ error: gatewayError })
    if (body.gateway_application_id) {
      const gwError = await gatewayApplicationError(fastify, params.zoneId, body.gateway_application_id)
      if (gwError) return reply.code(gwError === 'gateway_application_not_found' ? 404 : 400).send({ error: gwError })
    }
    if (await resourceQuotaExceeded(fastify, params.zoneId)) {
      return reply.code(409).send({ error: 'resource_quota_exceeded' })
    }
    const id = uuidv7()
    if (!body.gateway_application_id) {
      try {
        const { rows } = await fastify.db.query(
          `INSERT INTO resources (id, zone_id, name, identifier, upstream_url, scopes, credential_provider_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, zone_id, name, identifier, upstream_url, scopes, credential_provider_id, created_at, updated_at`,
          [id, params.zoneId, body.name ?? identifier, identifier, body.upstream_url ?? null, body.scopes, credentialProviderID],
        )
        return reply.code(201).send({ ...rows[0], gateway_application_id: null })
      } catch (err) {
        if (isResourceIdentifierConflict(err)) return reply.code(409).send({ error: 'resource_identifier_conflict' })
        throw err
      }
    }
    const gatewayApplicationId = body.gateway_application_id
    try {
      return await withTransaction(fastify.db, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO resources (id, zone_id, name, identifier, upstream_url, scopes, credential_provider_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, zone_id, name, identifier, upstream_url, scopes, credential_provider_id, created_at, updated_at`,
          [id, params.zoneId, body.name ?? identifier, identifier, body.upstream_url, body.scopes, credentialProviderID],
        )
        await syncGatewayBinding(client, params.zoneId, identifier, gatewayApplicationId)
        return reply.code(201).send({ ...rows[0], gateway_application_id: gatewayApplicationId })
      })
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
    if (body.gateway_application_id) {
      const gwError = await gatewayApplicationError(fastify, params.zoneId, body.gateway_application_id)
      if (gwError) return reply.code(gwError === 'gateway_application_not_found' ? 404 : 400).send({ error: gwError })
    }
    try {
      return await withTransaction(fastify.db, async (client) => {
        const { rows: currentRows } = await client.query<{
          identifier: string
          upstream_url: string | null
          credential_provider_id: string | null
          gateway_application_id: string | null
        }>(
          `SELECT r.identifier, r.upstream_url, r.credential_provider_id, b.application_id AS gateway_application_id
           FROM resources r
           LEFT JOIN gateway_resource_bindings b
             ON b.zone_id = r.zone_id AND b.resource_identifier = r.identifier
           WHERE r.id = $1 AND r.zone_id = $2 AND r.archived_at IS NULL
           FOR UPDATE OF r`,
          [params.id, params.zoneId],
        )
        const current = currentRows[0]
        if (!current) throw new TxAbort(reply.code(404).send({ error: 'resource_not_found' }))
        const nextIdentifier = body.identifier ?? current.identifier
        const identifierError = validateResourceIdentifier(nextIdentifier)
        if (identifierError) {
          throw new TxAbort(reply.code(400).send({ error: 'invalid_resource_identifier', message: identifierError }))
        }
        if ((isControlResource(current.identifier) || isControlResource(nextIdentifier)) && !isControlResourceOperation(req)) {
          throw new TxAbort(reply.code(409).send({ error: 'protected_resource', detail: 'control API resource is managed only through the Control console path' }))
        }
        const nextUpstreamURL = body.upstream_url !== undefined ? body.upstream_url : current.upstream_url
        const nextGatewayApplicationID = body.gateway_application_id !== undefined
          ? body.gateway_application_id
          : current.gateway_application_id
        let nextCredentialProviderID = body.credential_provider_id !== undefined
          ? body.credential_provider_id
          : current.credential_provider_id
        if (isControlResource(nextIdentifier) && isControlResourceOperation(req) && !nextCredentialProviderID) {
          nextCredentialProviderID = await ensureNoneProvider(client, params.zoneId)
          body.credential_provider_id = nextCredentialProviderID
        }
        const gatewayError = validateGatewayBinding(nextIdentifier, nextUpstreamURL, nextGatewayApplicationID, nextCredentialProviderID)
        if (gatewayError) throw new TxAbort(reply.code(400).send({ error: gatewayError }))
        const update = buildPatchUpdate([params.id, params.zoneId], [
          patchColumn('name', body.name),
          patchColumn('identifier', body.identifier),
          patchColumn('upstream_url', body.upstream_url),
          patchColumn('scopes', body.scopes),
          patchColumn('credential_provider_id', body.credential_provider_id),
        ])
        if (!update && body.gateway_application_id === undefined) {
          throw new TxAbort(reply.code(400).send({ error: 'no_fields' }))
        }
        let row: unknown
        if (update) {
          const { rows } = await client.query(
            `UPDATE resources SET ${update.sets.join(', ')}, updated_at = now()
             WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL
             RETURNING id, zone_id, name, identifier, upstream_url, scopes, credential_provider_id, created_at, updated_at`,
            update.values,
          )
          row = rows[0]
        } else {
          const { rows } = await client.query(
            `SELECT id, zone_id, name, identifier, upstream_url, scopes, credential_provider_id, created_at, updated_at
             FROM resources WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`,
            [params.id, params.zoneId],
          )
          row = rows[0]
        }
        if (current.identifier !== nextIdentifier) {
          await syncGatewayBinding(client, params.zoneId, current.identifier, null)
        }
        await syncGatewayBinding(client, params.zoneId, nextIdentifier, isControlResource(nextIdentifier) ? null : nextGatewayApplicationID)
        return { ...(row as Record<string, unknown>), gateway_application_id: isControlResource(nextIdentifier) ? null : nextGatewayApplicationID }
      })
    } catch (err) {
      if (isResourceIdentifierConflict(err)) return reply.code(409).send({ error: 'resource_identifier_conflict' })
      throw err
    }
  })

  fastify.delete('/zones/:zoneId/resources/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
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
        throw new TxAbort(reply.code(409).send({ error: 'protected_resource', detail: 'control API resource cannot be deleted' }))
      }
      await client.query(
        `UPDATE resources SET archived_at = now(), updated_at = now()
         WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`,
        [params.id, params.zoneId],
      )
      await syncGatewayBinding(client, params.zoneId, current.identifier, null)
      return reply.code(204).send()
    })
  })
}
