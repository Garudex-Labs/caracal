// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Provider CRUD routes for upstream provider-native credential sources.

import type { FastifyPluginAsync } from 'fastify'
import { loadZoneKek, seal } from '@caracalai/core'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { buildPatchUpdate, patchColumn, patchExpression } from './patch.js'
import { ZoneIdParams, ZoneParams, parseParams } from './params.js'
import { zoneExists } from '../zone-guard.js'
import { appendKeysetCondition, parseListPagination, setNextLink } from './list-pagination.js'

const ProviderKind = z.enum(['oauth2_authorization_code', 'oauth2_client_credentials', 'api_key', 'bearer_token'])
type ProviderKind = z.infer<typeof ProviderKind>
const OAuthClientAuthMethod = z.enum(['client_secret_basic', 'client_secret_post', 'none'])
type OAuthClientAuthMethod = z.infer<typeof OAuthClientAuthMethod>

const ProviderCreateBody = z.object({
  name: z.string().min(1).optional(),
  identifier: z.string().min(1),
  kind: ProviderKind,
  config_json: z.record(z.string(), z.unknown()).optional(),
})

const ProviderPatchBody = ProviderCreateBody.partial()

const PUBLIC_PROVIDER_CONFIG_KEYS: Record<ProviderKind, ReadonlySet<string>> = {
  oauth2_authorization_code: new Set([
    'authorization_endpoint',
    'token_endpoint',
    'redirect_uri',
    'client_id',
    'client_auth_method',
    'scopes',
    'allowed_token_hosts',
    'auth_header',
    'auth_scheme',
    'forward_caracal_identity',
  ]),
  oauth2_client_credentials: new Set([
    'token_endpoint',
    'client_id',
    'client_auth_method',
    'scopes',
    'allowed_token_hosts',
    'auth_header',
    'auth_scheme',
    'forward_caracal_identity',
  ]),
  api_key: new Set(['header_name', 'auth_scheme', 'forward_caracal_identity']),
  bearer_token: new Set(['auth_header', 'auth_scheme', 'forward_caracal_identity']),
}

const SECRET_PROVIDER_CONFIG_KEYS: Record<ProviderKind, ReadonlySet<string>> = {
  oauth2_authorization_code: new Set(['client_secret']),
  oauth2_client_credentials: new Set(['client_secret']),
  api_key: new Set(['api_key']),
  bearer_token: new Set(['bearer_token']),
}

function requireString(config: Record<string, unknown>, key: string, message: string): void {
  if (typeof config[key] !== 'string' || config[key].trim().length === 0) throw new Error(message)
}

function requireStringList(config: Record<string, unknown>, key: string, message: string): void {
  const value = config[key]
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    throw new Error(message)
  }
}

function requireOptionalString(config: Record<string, unknown>, key: string, message: string): void {
  if (config[key] !== undefined && typeof config[key] !== 'string') throw new Error(message)
}

function requireOptionalBoolean(config: Record<string, unknown>, key: string, message: string): void {
  if (config[key] !== undefined && typeof config[key] !== 'boolean') throw new Error(message)
}

function requireOptionalStringList(config: Record<string, unknown>, key: string, message: string): void {
  if (config[key] !== undefined) requireStringList(config, key, message)
}

function requireOptionalOAuthClientAuthMethod(config: Record<string, unknown>): OAuthClientAuthMethod {
  const method = config.client_auth_method
  if (method === undefined) return 'client_secret_basic'
  const parsed = OAuthClientAuthMethod.safeParse(method)
  if (!parsed.success) throw new Error('oauth2 provider config client_auth_method is invalid')
  return parsed.data
}

function splitProviderConfig(kind: ProviderKind, input: Record<string, unknown> | undefined, requireSecrets: boolean): {
  publicConfig: Record<string, unknown>
  secretConfig: Record<string, string>
  secretKeys: string[]
} {
  const config = input ?? {}
  const publicAllowed = PUBLIC_PROVIDER_CONFIG_KEYS[kind]
  const secretAllowed = SECRET_PROVIDER_CONFIG_KEYS[kind]
  const allowed = new Set([...publicAllowed, ...secretAllowed])
  const unknown = Object.keys(config).filter((key) => !allowed.has(key))
  if (unknown.length > 0) throw new Error(`${kind} provider config has unsupported keys: ${unknown.join(', ')}`)

  const publicConfig: Record<string, unknown> = {}
  const secretConfig: Record<string, string> = {}
  for (const [key, value] of Object.entries(config)) {
    if (secretAllowed.has(key)) {
      if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${kind} provider config ${key} must be a non-empty string`)
      secretConfig[key] = value
    } else {
      publicConfig[key] = value
    }
  }

  if (kind === 'api_key') {
    requireString(publicConfig, 'header_name', 'api_key provider config requires header_name')
    if (requireSecrets && !secretConfig.api_key) throw new Error('api_key provider config requires api_key')
  } else if (kind === 'bearer_token') {
    if (requireSecrets && !secretConfig.bearer_token) throw new Error('bearer_token provider config requires bearer_token')
    requireOptionalString(publicConfig, 'auth_header', 'bearer_token provider config auth_header must be a string')
  } else {
    requireString(publicConfig, 'token_endpoint', `${kind} provider config requires token_endpoint`)
    requireString(publicConfig, 'client_id', `${kind} provider config requires client_id`)
    requireStringList(publicConfig, 'allowed_token_hosts', `${kind} provider config requires allowed_token_hosts`)
    requireOptionalStringList(publicConfig, 'scopes', `${kind} provider config scopes must be a list of strings`)
    requireOptionalString(publicConfig, 'auth_header', `${kind} provider config auth_header must be a string`)
    const clientAuthMethod = requireOptionalOAuthClientAuthMethod(publicConfig)
    publicConfig.client_auth_method = clientAuthMethod
    if (kind === 'oauth2_authorization_code') {
      requireString(publicConfig, 'authorization_endpoint', 'oauth2_authorization_code provider config requires authorization_endpoint')
      requireString(publicConfig, 'redirect_uri', 'oauth2_authorization_code provider config requires redirect_uri')
    }
    if (requireSecrets && clientAuthMethod !== 'none' && !secretConfig.client_secret) {
      throw new Error(`${kind} provider config requires client_secret`)
    }
  }
  requireOptionalString(publicConfig, 'auth_scheme', `${kind} provider config auth_scheme must be a string`)
  requireOptionalBoolean(publicConfig, 'forward_caracal_identity', `${kind} provider config forward_caracal_identity must be a boolean`)
  return { publicConfig, secretConfig, secretKeys: Object.keys(secretConfig).sort() }
}

function sealSecretConfig(secretConfig: Record<string, string>): { ciphertext: Buffer, nonce: Buffer } | null {
  if (Object.keys(secretConfig).length === 0) return null
  return seal(loadZoneKek(), Buffer.from(JSON.stringify(secretConfig), 'utf8'))
}

interface ProviderRow {
  id: string
  zone_id: string
  name: string
  identifier: string
  kind: string
  config_json: unknown
  secret_config_keys: string[]
  created_at: string
  updated_at: string
}

const RETURNING = `id, zone_id, name, identifier, provider_kind AS kind,
                  config_json, secret_config_keys, created_at, updated_at`

export const providersRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones/:zoneId/providers', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const page = parseListPagination(req, reply)
    if (!page) return
    const keyset = appendKeysetCondition(
      { conds: ['zone_id = $1', 'archived_at IS NULL'], values: [params.zoneId] },
      page,
    )
    const { rows } = await fastify.db.query<ProviderRow>(
      `SELECT ${RETURNING}
       FROM providers WHERE ${keyset.conds.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ${keyset.limitPlaceholder}`,
      keyset.values,
    )
    setNextLink(req, reply, rows, page.limit)
    return rows
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
    return rows[0]
  })

  fastify.post('/zones/:zoneId/providers', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    if (!(await zoneExists(fastify.db, params.zoneId))) {
      return reply.code(404).send({ error: 'zone_not_found' })
    }
    const parsed = ProviderCreateBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_provider' })
    const body = parsed.data
    const id = uuidv7()
    let config: ReturnType<typeof splitProviderConfig>
    try {
      config = splitProviderConfig(body.kind, body.config_json, true)
    } catch (err) {
      return reply.code(400).send({ error: 'invalid_provider_config', message: err instanceof Error ? err.message : String(err) })
    }
    const sealed = sealSecretConfig(config.secretConfig)
    const { rows } = await fastify.db.query<ProviderRow>(
      `INSERT INTO providers (id, zone_id, name, identifier, provider_kind, config_json,
                              secret_config_ct, secret_config_nonce, secret_config_keys)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
       RETURNING ${RETURNING}`,
      [
        id,
        params.zoneId,
        body.name ?? body.identifier,
        body.identifier,
        body.kind,
        JSON.stringify(config.publicConfig),
        sealed?.ciphertext ?? null,
        sealed?.nonce ?? null,
        config.secretKeys,
      ],
    )
    return reply.code(201).send(rows[0])
  })

  fastify.patch('/zones/:zoneId/providers/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const parsed = ProviderPatchBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_provider' })
    const body = parsed.data

    if (body.kind !== undefined && body.config_json === undefined) {
      return reply.code(400).send({ error: 'provider_config_required' })
    }
    let config: ReturnType<typeof splitProviderConfig> | undefined
    let sealed: { ciphertext: Buffer, nonce: Buffer } | null = null
    if (body.config_json !== undefined) {
      let kind = body.kind
      if (!kind) {
        const { rows } = await fastify.db.query<{ kind: ProviderKind }>(
          `SELECT provider_kind AS kind FROM providers WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`,
          [params.id, params.zoneId],
        )
        if (!rows[0]) return reply.code(404).send({ error: 'provider_not_found' })
        kind = rows[0].kind
      }
      try {
        config = splitProviderConfig(kind, body.config_json, body.kind !== undefined)
        sealed = sealSecretConfig(config.secretConfig)
      } catch (err) {
        return reply.code(400).send({ error: 'invalid_provider_config', message: err instanceof Error ? err.message : String(err) })
      }
    }

    const clearSecrets = body.kind !== undefined && config !== undefined && sealed === null
    const update = buildPatchUpdate([params.id, params.zoneId], [
      patchColumn('name', body.name),
      patchColumn('identifier', body.identifier),
      patchColumn('provider_kind', body.kind),
      patchExpression(
        config ? JSON.stringify(config.publicConfig) : undefined,
        (placeholder) => `config_json = ${placeholder}::jsonb`,
      ),
      patchColumn('secret_config_ct', sealed?.ciphertext ?? (clearSecrets ? null : undefined)),
      patchColumn('secret_config_nonce', sealed?.nonce ?? (clearSecrets ? null : undefined)),
      patchColumn('secret_config_keys', config && (sealed || clearSecrets) ? config.secretKeys : undefined),
    ])
    if (!update) return reply.code(400).send({ error: 'no_fields' })
    const { rows } = await fastify.db.query<ProviderRow>(
      `UPDATE providers SET ${update.sets.join(', ')}, updated_at = now()
       WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL
       RETURNING ${RETURNING}`,
      update.values,
    )
    if (!rows[0]) return reply.code(404).send({ error: 'provider_not_found' })
    return rows[0]
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
