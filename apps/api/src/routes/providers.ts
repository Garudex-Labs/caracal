// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Provider CRUD routes: OAuth, OIDC, apikey, and workload IdP variants.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { loadZoneKek, seal } from '@caracalai/shared'
import { buildPatchUpdate, patchColumn, patchExpression } from './patch.js'
import { ZoneIdParams, ZoneParams, parseParams } from './params.js'
import { zoneExists } from '../zone-guard.js'

const ProviderBody = z.object({
  name: z.string().min(1).optional(),
  identifier: z.string().min(1),
  kind: z.enum(['oauth2', 'oidc', 'apikey', 'workload']).optional(),
  owner_type: z.string().optional(),
  client_id: z.string().optional(),
  config_json: z.record(z.unknown()).optional(),
})

// Keys whose values are credential material. They are stripped from config_json,
// sealed under ZONE_KEK, and never returned over the wire.
const SECRET_KEY_PATTERN = /(secret|password|token|api[_-]?key|private[_-]?key|credential|passphrase)/i

interface SplitConfig {
  publicConfig: Record<string, unknown>
  secretKeys: string[]
  sealed: { ciphertext: Buffer; nonce: Buffer } | null
}

function splitConfig(input: Record<string, unknown> | undefined, kind: string | undefined): SplitConfig {
  const publicConfig: Record<string, unknown> = {}
  const secretConfig: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input ?? {})) {
    if (SECRET_KEY_PATTERN.test(key)) secretConfig[key] = value
    else publicConfig[key] = value
  }
  if (kind) publicConfig.kind = kind
  const secretKeys = Object.keys(secretConfig).sort()
  if (secretKeys.length === 0) {
    return { publicConfig, secretKeys, sealed: null }
  }
  const sealed = seal(loadZoneKek(), Buffer.from(JSON.stringify(secretConfig), 'utf8'))
  return { publicConfig, secretKeys, sealed }
}

function scrubConfigJSON(config: unknown): unknown {
  if (!config || typeof config !== 'object') return config
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) continue
    out[key] = value
  }
  return out
}

interface ProviderRow {
  id: string
  zone_id: string
  name: string
  identifier: string
  kind: string | null
  owner_type: string
  client_id: string | null
  config_json: unknown
  secret_config_keys: string[]
  created_at: string
  updated_at: string
}

function projectProvider(row: ProviderRow) {
  return { ...row, config_json: scrubConfigJSON(row.config_json) }
}

const RETURNING = `id, zone_id, name, identifier, config_json->>'kind' AS kind,
                  owner_type, client_id, config_json, secret_config_keys, created_at, updated_at`

export const providersRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones/:zoneId/providers', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query<ProviderRow>(
      `SELECT ${RETURNING}
       FROM providers WHERE zone_id = $1 AND archived_at IS NULL ORDER BY created_at DESC`,
      [params.zoneId],
    )
    return rows.map(projectProvider)
  })

  fastify.get('/zones/:zoneId/providers/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query<ProviderRow>(
      `SELECT ${RETURNING}
       FROM providers WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`,
      [params.id, params.zoneId],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'provider_not_found' })
    return projectProvider(rows[0])
  })

  fastify.post('/zones/:zoneId/providers', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    if (!(await zoneExists(fastify.db, params.zoneId))) {
      return reply.code(404).send({ error: 'zone_not_found' })
    }
    const body = ProviderBody.parse(req.body)
    const id = uuidv7()
    const split = splitConfig(body.config_json, body.kind)
    const { rows } = await fastify.db.query<ProviderRow>(
      `INSERT INTO providers (id, zone_id, name, identifier, owner_type, client_id,
                              config_json, secret_config_ct, secret_config_nonce, secret_config_keys)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
       RETURNING ${RETURNING}`,
      [
        id,
        params.zoneId,
        body.name ?? body.identifier,
        body.identifier,
        body.owner_type ?? 'customer',
        body.client_id ?? null,
        JSON.stringify(split.publicConfig),
        split.sealed?.ciphertext ?? null,
        split.sealed?.nonce ?? null,
        split.secretKeys,
      ],
    )
    return reply.code(201).send(projectProvider(rows[0]))
  })

  fastify.patch('/zones/:zoneId/providers/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const body = ProviderBody.partial().parse(req.body)

    const split = body.config_json !== undefined || body.kind !== undefined
      ? splitConfig(body.config_json, body.kind)
      : null

    const update = buildPatchUpdate([params.id, params.zoneId], [
      patchColumn('name', body.name),
      patchColumn('identifier', body.identifier),
      patchColumn('owner_type', body.owner_type),
      patchColumn('client_id', body.client_id),
      patchExpression(
        split ? JSON.stringify(split.publicConfig) : undefined,
        (placeholder) => `config_json = config_json || ${placeholder}::jsonb`,
      ),
      patchColumn('secret_config_ct', split?.sealed?.ciphertext ?? undefined),
      patchColumn('secret_config_nonce', split?.sealed?.nonce ?? undefined),
      patchColumn('secret_config_keys', split?.secretKeys),
    ])
    if (!update) return reply.code(400).send({ error: 'no_fields' })
    const { rows } = await fastify.db.query<ProviderRow>(
      `UPDATE providers SET ${update.sets.join(', ')}, updated_at = now()
       WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL
       RETURNING ${RETURNING}`,
      update.values,
    )
    if (!rows[0]) return reply.code(404).send({ error: 'provider_not_found' })
    return projectProvider(rows[0])
  })

  fastify.delete('/zones/:zoneId/providers/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { rowCount } = await fastify.db.query(
      `UPDATE providers SET archived_at = now(), updated_at = now()
       WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`,
      [params.id, params.zoneId],
    )
    if (!rowCount) return reply.code(404).send({ error: 'provider_not_found' })
    return reply.code(204).send()
  })
}
