// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Resource CRUD routes: identifier, scopes, and provider binding per zone.

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { buildPatchUpdate, patchColumn } from './patch.js'
import { ZoneIdParams, ZoneParams, parseParams } from './params.js'
import { zoneExists } from '../zone-guard.js'
import { appendKeysetCondition, parseListPagination, setNextLink } from './list-pagination.js'

const HttpURL = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol
  return protocol === 'http:' || protocol === 'https:'
}, 'upstream_url must use http or https')

const ResourceBody = z.object({
  name: z.string().min(1).optional(),
  identifier: z.string().min(1),
  upstream_url: HttpURL.nullable().optional(),
  prefix: z.boolean().optional(),
  scopes: z.array(z.string()).min(1),
  credential_provider_id: z.string().optional(),
  gateway_application_id: z.string().min(1).nullable().optional(),
})

const DEFAULT_CONTROL_AUDIENCE = 'caracal-control'
const CONTROL_RESOURCE_HEADER = 'x-caracal-control-resource'

async function providerExists(fastify: FastifyInstance, zoneId: string, providerId: string): Promise<boolean> {
  const { rows } = await fastify.db.query(
    `SELECT 1 FROM providers WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`,
    [providerId, zoneId],
  )
  return rows.length > 0
}

async function applicationExists(fastify: FastifyInstance, zoneId: string, applicationId: string): Promise<boolean> {
  const { rows } = await fastify.db.query(
    `SELECT 1 FROM applications
     WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())`,
    [applicationId, zoneId],
  )
  return rows.length > 0
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

function validateGatewayBinding(upstreamURL: string | null | undefined, gatewayApplicationID: string | null | undefined): string | null {
  if (upstreamURL && !gatewayApplicationID) return 'gateway_application_required'
  if (!upstreamURL && gatewayApplicationID) return 'gateway_application_requires_upstream'
  return null
}

function controlAudience(): string {
  return process.env.CONTROL_AUDIENCE ?? DEFAULT_CONTROL_AUDIENCE
}

function isControlResource(identifier: string): boolean {
  return identifier === controlAudience()
}

function isControlResourceOperation(req: FastifyRequest): boolean {
  return req.headers[CONTROL_RESOURCE_HEADER] === 'manage'
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
      `SELECT r.id, r.zone_id, r.name, r.identifier, r.upstream_url, r.prefix, r.scopes,
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
      `SELECT r.id, r.zone_id, r.name, r.identifier, r.upstream_url, r.prefix, r.scopes,
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
    const body = ResourceBody.parse(req.body)
    if (isControlResource(body.identifier) && !isControlResourceOperation(req)) {
      return reply.code(409).send({ error: 'protected_resource', detail: 'control API resource is managed only through the Control console path' })
    }
    if (body.credential_provider_id && !(await providerExists(fastify, params.zoneId, body.credential_provider_id))) {
      return reply.code(404).send({ error: 'provider_not_found' })
    }
    const gatewayError = validateGatewayBinding(body.upstream_url, body.gateway_application_id)
    if (gatewayError) return reply.code(400).send({ error: gatewayError })
    if (body.gateway_application_id && !(await applicationExists(fastify, params.zoneId, body.gateway_application_id))) {
      return reply.code(404).send({ error: 'gateway_application_not_found' })
    }
    if (await resourceQuotaExceeded(fastify, params.zoneId)) {
      return reply.code(409).send({ error: 'resource_quota_exceeded' })
    }
    const id = uuidv7()
    if (!body.gateway_application_id) {
      const { rows } = await fastify.db.query(
        `INSERT INTO resources (id, zone_id, name, identifier, upstream_url, prefix, scopes, credential_provider_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, zone_id, name, identifier, upstream_url, prefix, scopes, credential_provider_id, created_at, updated_at`,
        [id, params.zoneId, body.name ?? body.identifier, body.identifier, body.upstream_url ?? null, body.prefix ?? false, body.scopes, body.credential_provider_id ?? null],
      )
      return reply.code(201).send({ ...rows[0], gateway_application_id: null })
    }
    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `INSERT INTO resources (id, zone_id, name, identifier, upstream_url, prefix, scopes, credential_provider_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, zone_id, name, identifier, upstream_url, prefix, scopes, credential_provider_id, created_at, updated_at`,
        [id, params.zoneId, body.name ?? body.identifier, body.identifier, body.upstream_url, body.prefix ?? false, body.scopes, body.credential_provider_id ?? null],
      )
      await syncGatewayBinding(client, params.zoneId, body.identifier, body.gateway_application_id)
      await client.query('COMMIT')
      return reply.code(201).send({ ...rows[0], gateway_application_id: body.gateway_application_id })
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  fastify.patch('/zones/:zoneId/resources/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const body = ResourceBody.partial().parse(req.body)
    if (body.credential_provider_id !== undefined) {
      if (!(await providerExists(fastify, params.zoneId, body.credential_provider_id))) {
        return reply.code(404).send({ error: 'provider_not_found' })
      }
    }
    if (body.gateway_application_id && !(await applicationExists(fastify, params.zoneId, body.gateway_application_id))) {
      return reply.code(404).send({ error: 'gateway_application_not_found' })
    }
    const update = buildPatchUpdate([params.id, params.zoneId], [
      patchColumn('name', body.name),
      patchColumn('identifier', body.identifier),
      patchColumn('upstream_url', body.upstream_url),
      patchColumn('prefix', body.prefix),
      patchColumn('scopes', body.scopes),
      patchColumn('credential_provider_id', body.credential_provider_id),
    ])
    if (!update && body.gateway_application_id === undefined) return reply.code(400).send({ error: 'no_fields' })
    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      const { rows: currentRows } = await client.query<{
        identifier: string
        upstream_url: string | null
        gateway_application_id: string | null
      }>(
        `SELECT r.identifier, r.upstream_url, b.application_id AS gateway_application_id
         FROM resources r
         LEFT JOIN gateway_resource_bindings b
           ON b.zone_id = r.zone_id AND b.resource_identifier = r.identifier
         WHERE r.id = $1 AND r.zone_id = $2 AND r.archived_at IS NULL
         FOR UPDATE OF r`,
        [params.id, params.zoneId],
      )
      const current = currentRows[0]
      if (!current) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'resource_not_found' })
      }
      const nextIdentifier = body.identifier ?? current.identifier
      if ((isControlResource(current.identifier) || isControlResource(nextIdentifier)) && !isControlResourceOperation(req)) {
        await client.query('ROLLBACK')
        return reply.code(409).send({ error: 'protected_resource', detail: 'control API resource is managed only through the Control console path' })
      }
      const nextUpstreamURL = body.upstream_url !== undefined ? body.upstream_url : current.upstream_url
      const nextGatewayApplicationID = body.gateway_application_id !== undefined
        ? body.gateway_application_id
        : current.gateway_application_id
      const gatewayError = validateGatewayBinding(nextUpstreamURL, nextGatewayApplicationID)
      if (gatewayError) {
        await client.query('ROLLBACK')
        return reply.code(400).send({ error: gatewayError })
      }
      let row: unknown
      if (update) {
        const { rows } = await client.query(
          `UPDATE resources SET ${update.sets.join(', ')}, updated_at = now()
           WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL
           RETURNING id, zone_id, name, identifier, upstream_url, prefix, scopes, credential_provider_id, created_at, updated_at`,
          update.values,
        )
        row = rows[0]
      } else {
        const { rows } = await client.query(
          `SELECT id, zone_id, name, identifier, upstream_url, prefix, scopes, credential_provider_id, created_at, updated_at
           FROM resources WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`,
          [params.id, params.zoneId],
        )
        row = rows[0]
      }
      if (current.identifier !== nextIdentifier) {
        await syncGatewayBinding(client, params.zoneId, current.identifier, null)
      }
      await syncGatewayBinding(client, params.zoneId, nextIdentifier, nextUpstreamURL ? nextGatewayApplicationID : null)
      await client.query('COMMIT')
      return { ...(row as Record<string, unknown>), gateway_application_id: nextUpstreamURL ? nextGatewayApplicationID : null }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  fastify.delete('/zones/:zoneId/resources/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')
      const { rows: currentRows } = await client.query<{ identifier: string }>(
        `SELECT identifier FROM resources
         WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL
         FOR UPDATE`,
        [params.id, params.zoneId],
      )
      const current = currentRows[0]
      if (!current) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'resource_not_found' })
      }
      if (isControlResource(current.identifier)) {
        await client.query('ROLLBACK')
        return reply.code(409).send({ error: 'protected_resource', detail: 'control API resource cannot be deleted' })
      }
      await client.query(
        `UPDATE resources SET archived_at = now(), updated_at = now()
         WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`,
        [params.id, params.zoneId],
      )
      await syncGatewayBinding(client, params.zoneId, current.identifier, null)
      await client.query('COMMIT')
      return reply.code(204).send()
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })
}
