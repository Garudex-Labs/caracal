// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Provider CRUD routes for upstream credential and mandate forwarding sources.

import type { FastifyPluginAsync } from 'fastify'
import { loadZoneKek, seal } from '@caracalai/core'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { buildPatchUpdate, patchColumn, patchExpression } from './patch.js'
import { ZoneIdParams, ZoneParams, parseParams } from './params.js'
import { zoneExists } from '../zone-guard.js'
import { appendKeysetCondition, parseListPagination, setNextLink } from './list-pagination.js'
import { assertReservedNamespace } from '../reserved-namespace.js'
import { PROVIDER_KINDS, PUBLIC_PROVIDER_CONFIG_KEYS, SECRET_PROVIDER_CONFIG_KEYS } from '../provider-config.js'
import {
  buildTokenRequest,
  ensureAllowedTokenEndpoint,
  exchangeProviderToken,
  openSecretConfig,
  recordConfig,
  stringConfig,
  stringListConfig,
} from '../provider-token.js'

const ProviderKind = z.enum(PROVIDER_KINDS)
type ProviderKind = z.infer<typeof ProviderKind>
const APIKeyAuthLocation = z.enum(['header', 'query'])
type APIKeyAuthLocation = z.infer<typeof APIKeyAuthLocation>
const OAuthClientAuthMethod = z.enum(['client_secret_basic', 'client_secret_post', 'private_key_jwt', 'none'])
type OAuthClientAuthMethod = z.infer<typeof OAuthClientAuthMethod>
const PROVIDER_IDENTIFIER_PREFIX = 'provider://'
const PROVIDER_IDENTIFIER_PATTERN = /^provider:\/\/[a-z0-9]+(?:-[a-z0-9]+)*$/
const PROVIDER_IDENTIFIER_UNIQUE_INDEX = 'providers_zone_identifier_active_uidx'
const HEADER_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const AUTH_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/
const OAUTH_PARAM_PATTERN = /^[A-Za-z0-9._~-]+$/
const HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/
const RESERVED_OAUTH_AUTHORIZATION_PARAMS = new Set([
  'client_id',
  'code_challenge',
  'code_challenge_method',
  'redirect_uri',
  'response_type',
  'scope',
  'state',
])
const RESERVED_OAUTH_TOKEN_PARAMS = new Set([
  'client_assertion',
  'client_assertion_type',
  'client_id',
  'client_secret',
  'code',
  'code_verifier',
  'grant_type',
  'redirect_uri',
  'refresh_token',
  'scope',
])
const OptionalText = z.preprocess(
  (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
  z.string().trim().min(1).optional(),
)

const ProviderCreateBody = z
  .object({
    name: OptionalText,
    identifier: OptionalText,
    kind: ProviderKind,
    config_json: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((body) => body.name !== undefined || body.identifier !== undefined, { message: 'name_or_identifier_required' })

const ProviderPatchBody = z.object({
  name: OptionalText,
  identifier: OptionalText,
  kind: ProviderKind.optional(),
  config_json: z.record(z.string(), z.unknown()).optional(),
})

function slugValue(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'provider'
  )
}

function providerIdentifierFromName(name: string): string {
  const text = name.trim()
  const base = text.startsWith(PROVIDER_IDENTIFIER_PREFIX) ? text.slice(PROVIDER_IDENTIFIER_PREFIX.length) : text
  return `${PROVIDER_IDENTIFIER_PREFIX}${slugValue(base)}`
}

interface ProviderQueryClient {
  query<T = unknown>(text: string, values?: unknown[]): Promise<{ rows: T[] }>
}

async function providerIdentifierExists(client: ProviderQueryClient, zoneId: string, identifier: string): Promise<boolean> {
  const { rows } = await client.query(`SELECT 1 FROM providers WHERE zone_id = $1 AND identifier = $2 AND archived_at IS NULL`, [
    zoneId,
    identifier,
  ])
  return rows.length > 0
}

async function nextProviderIdentifier(client: ProviderQueryClient, zoneId: string, name: string): Promise<string> {
  const base = providerIdentifierFromName(name)
  for (let suffix = 1; suffix < 1000; suffix++) {
    const identifier = suffix === 1 ? base : `${base}-${suffix}`
    if (!(await providerIdentifierExists(client, zoneId, identifier))) return identifier
  }
  return `${base}-${uuidv7().replace(/-/g, '')}`
}

function isProviderIdentifierConflict(err: unknown): boolean {
  return Boolean(
    err &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505' &&
    'constraint' in err &&
    (err as { constraint?: unknown }).constraint === PROVIDER_IDENTIFIER_UNIQUE_INDEX,
  )
}

function providerIdentifierError(identifier: string | undefined): string | undefined {
  if (identifier === undefined || PROVIDER_IDENTIFIER_PATTERN.test(identifier)) return undefined
  return 'provider identifier must start with provider:// and use lowercase letters, numbers, or hyphens'
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

function requireHttpsUrl(config: Record<string, unknown>, key: string, message: string): void {
  requireString(config, key, message)
  const value = config[key] as string
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(message)
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) throw new Error(message)
}

function requireAbsoluteUri(config: Record<string, unknown>, key: string, message: string): void {
  requireString(config, key, message)
  const value = config[key] as string
  try {
    const url = new URL(value)
    if (!url.protocol || (!url.hostname && (url.protocol === 'http:' || url.protocol === 'https:'))) throw new Error()
  } catch {
    throw new Error(message)
  }
}

function requireOptionalHeaderName(config: Record<string, unknown>, key: string, message: string): void {
  const value = config[key]
  if (value === undefined) return
  if (typeof value !== 'string' || !HEADER_TOKEN_PATTERN.test(value.trim())) throw new Error(message)
  config[key] = value.trim()
}

function requireOptionalAuthScheme(config: Record<string, unknown>, key: string, message: string): void {
  const value = config[key]
  if (value === undefined) return
  if (typeof value !== 'string' || !AUTH_SCHEME_PATTERN.test(value.trim())) throw new Error(message)
  config[key] = value.trim()
}

function requireOptionalBoolean(config: Record<string, unknown>, key: string, message: string): void {
  if (config[key] !== undefined && typeof config[key] !== 'boolean') throw new Error(message)
}

function requireOptionalStringList(config: Record<string, unknown>, key: string, message: string): void {
  if (config[key] !== undefined) requireStringList(config, key, message)
}

function requireOptionalHostList(config: Record<string, unknown>, key: string, message: string): void {
  const value = config[key]
  if (value === undefined) return
  requireStringList(config, key, message)
  config[key] = (value as string[]).map((item) => {
    const host = item.trim().toLowerCase()
    if (!HOST_PATTERN.test(host) || host.includes('..')) throw new Error(message)
    return host
  })
}

function requireOptionalText(config: Record<string, unknown>, key: string, message: string): void {
  const value = config[key]
  if (value === undefined) return
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(message)
  config[key] = value.trim()
}

function requireOptionalStringRecord(config: Record<string, unknown>, key: string, reserved: ReadonlySet<string>, message: string): void {
  const value = config[key]
  if (value === undefined) return
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  const params = value as Record<string, string>
  for (const [name, item] of Object.entries(value)) {
    if (reserved.has(name) || !OAUTH_PARAM_PATTERN.test(name) || typeof item !== 'string' || item.trim().length === 0) {
      throw new Error(message)
    }
    params[name] = item.trim()
  }
}

function requireOptionalOAuthClientAuthMethod(config: Record<string, unknown>): OAuthClientAuthMethod {
  const method = config.client_auth_method
  if (method === undefined) return 'client_secret_basic'
  const parsed = OAuthClientAuthMethod.safeParse(method)
  if (!parsed.success) throw new Error('oauth2 provider config client_auth_method is invalid')
  return parsed.data
}

function requireAPIKeyAuthLocation(config: Record<string, unknown>): APIKeyAuthLocation {
  const location = config.auth_location
  if (location === undefined) {
    config.auth_location = 'header'
    return 'header'
  }
  const parsed = APIKeyAuthLocation.safeParse(location)
  if (!parsed.success) throw new Error('api_key provider config auth_location must be header or query')
  return parsed.data
}

function splitProviderConfig(
  kind: ProviderKind,
  input: Record<string, unknown> | undefined,
  requireSecrets: boolean,
): {
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
      if (typeof value !== 'string' || value.trim().length === 0)
        throw new Error(`${kind} provider config ${key} must be a non-empty string`)
      secretConfig[key] = value
    } else {
      publicConfig[key] = value
    }
  }

  if (kind === 'none' || kind === 'caracal_mandate') {
    return { publicConfig, secretConfig, secretKeys: [] }
  }
  if (kind === 'api_key') {
    const location = requireAPIKeyAuthLocation(publicConfig)
    if (location === 'header') {
      requireString(publicConfig, 'header_name', 'api_key provider config requires header_name')
      requireOptionalHeaderName(publicConfig, 'header_name', 'api_key provider config header_name must be an HTTP header name')
    } else {
      requireString(publicConfig, 'query_param_name', 'api_key provider config requires query_param_name')
      requireOptionalText(publicConfig, 'query_param_name', 'api_key provider config query_param_name must be a query parameter name')
      if (!OAUTH_PARAM_PATTERN.test(publicConfig.query_param_name as string)) {
        throw new Error('api_key provider config query_param_name must be a query parameter name')
      }
      if (publicConfig.auth_scheme !== undefined) {
        throw new Error('api_key provider config auth_scheme applies only to header auth')
      }
    }
    if (requireSecrets && !secretConfig.api_key) throw new Error('api_key provider config requires api_key')
  } else if (kind === 'bearer_token') {
    if (requireSecrets && !secretConfig.bearer_token) throw new Error('bearer_token provider config requires bearer_token')
    requireOptionalHostList(publicConfig, 'allowed_token_hosts', 'bearer_token provider config allowed_token_hosts must be DNS hostnames')
    requireOptionalHeaderName(publicConfig, 'auth_header', 'bearer_token provider config auth_header must be an HTTP header name')
  } else {
    requireHttpsUrl(publicConfig, 'token_endpoint', `${kind} provider config token_endpoint must be an HTTPS URL`)
    requireString(publicConfig, 'client_id', `${kind} provider config requires client_id`)
    if (publicConfig.allowed_token_hosts === undefined) {
      publicConfig.allowed_token_hosts = [new URL(publicConfig.token_endpoint as string).hostname.toLowerCase()]
    }
    requireStringList(publicConfig, 'allowed_token_hosts', `${kind} provider config requires allowed_token_hosts`)
    requireOptionalStringList(publicConfig, 'scopes', `${kind} provider config scopes must be a list of strings`)
    requireOptionalStringRecord(
      publicConfig,
      'token_params',
      RESERVED_OAUTH_TOKEN_PARAMS,
      `${kind} provider config token_params must be non-reserved string key/value pairs`,
    )
    requireOptionalHeaderName(publicConfig, 'auth_header', `${kind} provider config auth_header must be an HTTP header name`)
    if (kind === 'oauth2_client_credentials') {
      requireOptionalText(publicConfig, 'audience', 'oauth2_client_credentials provider config audience must be a non-empty string')
      requireOptionalText(publicConfig, 'resource', 'oauth2_client_credentials provider config resource must be a non-empty string')
      requireOptionalText(publicConfig, 'key_id', 'oauth2_client_credentials provider config key_id must be a non-empty string')
    }
    const clientAuthMethod = requireOptionalOAuthClientAuthMethod(publicConfig)
    publicConfig.client_auth_method = clientAuthMethod
    if (kind === 'oauth2_authorization_code' && clientAuthMethod === 'private_key_jwt') {
      throw new Error('oauth2_authorization_code provider config client_auth_method is not supported')
    }
    if (kind === 'oauth2_authorization_code') {
      requireHttpsUrl(
        publicConfig,
        'authorization_endpoint',
        'oauth2_authorization_code provider config authorization_endpoint must be an HTTPS URL',
      )
      requireAbsoluteUri(publicConfig, 'redirect_uri', 'oauth2_authorization_code provider config redirect_uri must be an absolute URI')
      requireOptionalStringRecord(
        publicConfig,
        'authorization_params',
        RESERVED_OAUTH_AUTHORIZATION_PARAMS,
        'oauth2_authorization_code provider config authorization_params must be non-reserved string key/value pairs',
      )
    }
    if (clientAuthMethod === 'private_key_jwt') {
      if (secretConfig.client_secret) {
        throw new Error(`${kind} provider config client_secret is not used with private_key_jwt`)
      }
      if (requireSecrets && !secretConfig.private_key) {
        throw new Error(`${kind} provider config requires private_key`)
      }
    } else if (secretConfig.private_key) {
      throw new Error(`${kind} provider config private_key requires private_key_jwt`)
    } else if (publicConfig.key_id !== undefined) {
      throw new Error(`${kind} provider config key_id requires private_key_jwt`)
    } else if (requireSecrets && clientAuthMethod !== 'none' && !secretConfig.client_secret) {
      throw new Error(`${kind} provider config requires client_secret`)
    }
  }
  requireOptionalAuthScheme(publicConfig, 'auth_scheme', `${kind} provider config auth_scheme must be an auth scheme token`)
  requireOptionalBoolean(publicConfig, 'forward_caracal_identity', `${kind} provider config forward_caracal_identity must be a boolean`)
  requireOptionalBoolean(publicConfig, 'allow_runtime_injection', `${kind} provider config allow_runtime_injection must be a boolean`)
  return { publicConfig, secretConfig, secretKeys: Object.keys(secretConfig).sort() }
}

function sealSecretConfig(secretConfig: Record<string, string>): { ciphertext: Buffer; nonce: Buffer } | null {
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

interface ProviderKindRow {
  kind: ProviderKind
  secret_config_keys: string[]
}

function requireExistingOAuthSecret(
  kind: ProviderKind,
  publicConfig: Record<string, unknown>,
  secretConfig: Record<string, string>,
  secretKeys: readonly string[],
): void {
  if (kind !== 'oauth2_authorization_code' && kind !== 'oauth2_client_credentials') return
  const method = publicConfig.client_auth_method
  if (method === 'private_key_jwt') {
    if (!secretConfig.private_key && !secretKeys.includes('private_key')) {
      throw new Error(`${kind} provider config requires private_key`)
    }
    return
  }
  if (method !== 'none' && !secretConfig.client_secret && !secretKeys.includes('client_secret')) {
    throw new Error(`${kind} provider config requires client_secret`)
  }
}

const RETURNING = `id, zone_id, name, identifier, provider_kind AS kind,
                  config_json, secret_config_keys, created_at, updated_at`

// Connection tests reach outside the platform, so they are capped per zone per minute
// to keep the control plane from being used as a request amplifier.
const PROVIDER_TEST_RATE_LIMIT = 10

interface ProviderTestRow {
  kind: ProviderKind
  config_json: Record<string, unknown>
  secret_config_ct: Buffer | null
  secret_config_nonce: Buffer | null
}

interface ProviderTestResult {
  status: 'ok' | 'auth_failed' | 'unreachable' | 'endpoint_error' | 'config_error' | 'untestable'
  detail: string
  checked_at: string
}

// Only the standard OAuth error code is taken from the upstream response, so nothing
// the provider returns can flow back to the caller beyond a fixed-vocabulary token.
function oauthErrorCode(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    return typeof parsed.error === 'string' && /^[a-z_]{1,64}$/.test(parsed.error) ? parsed.error : ''
  } catch {
    return ''
  }
}

export const providersRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones/:zoneId/providers', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const page = parseListPagination(req, reply)
    if (!page) return
    const keyset = appendKeysetCondition({ conds: ['zone_id = $1', 'archived_at IS NULL'], values: [params.zoneId] }, page)
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
    const identifierError = providerIdentifierError(body.identifier)
    if (identifierError) return reply.code(400).send({ error: 'invalid_provider_identifier', message: identifierError })
    let config: ReturnType<typeof splitProviderConfig>
    try {
      config = splitProviderConfig(body.kind, body.config_json, true)
    } catch (err) {
      return reply.code(400).send({ error: 'invalid_provider_config', message: err instanceof Error ? err.message : String(err) })
    }
    const sealed = sealSecretConfig(config.secretConfig)
    const explicitIdentifier = body.identifier !== undefined
    let identifier = body.identifier
    if (identifier === undefined) {
      identifier = await nextProviderIdentifier(fastify.db, params.zoneId, body.name ?? `${body.kind} provider`)
    }
    const reservedErr = assertReservedNamespace('providerIdentifier', identifier, req.actor)
    if (reservedErr) return reply.code(409).send(reservedErr)
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = uuidv7()
      try {
        const { rows } = await fastify.db.query<ProviderRow>(
          `INSERT INTO providers (id, zone_id, name, identifier, provider_kind, config_json,
                                  secret_config_ct, secret_config_nonce, secret_config_keys)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
           RETURNING ${RETURNING}`,
          [
            id,
            params.zoneId,
            body.name ?? identifier,
            identifier,
            body.kind,
            JSON.stringify(config.publicConfig),
            sealed?.ciphertext ?? null,
            sealed?.nonce ?? null,
            config.secretKeys,
          ],
        )
        return reply.code(201).send(rows[0])
      } catch (err) {
        if (!isProviderIdentifierConflict(err)) throw err
        if (explicitIdentifier) {
          return reply.code(409).send({ error: 'provider_identifier_conflict' })
        }
        identifier = await nextProviderIdentifier(fastify.db, params.zoneId, body.name ?? `${body.kind} provider`)
      }
    }
    return reply.code(409).send({ error: 'provider_identifier_conflict' })
  })

  fastify.patch('/zones/:zoneId/providers/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const parsed = ProviderPatchBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_provider' })
    const body = parsed.data
    const identifierError = providerIdentifierError(body.identifier)
    if (identifierError) return reply.code(400).send({ error: 'invalid_provider_identifier', message: identifierError })
    const reservedErr = assertReservedNamespace('providerIdentifier', body.identifier, req.actor)
    if (reservedErr) return reply.code(409).send(reservedErr)

    if (body.kind !== undefined && body.config_json === undefined) {
      return reply.code(400).send({ error: 'provider_config_required' })
    }
    let config: ReturnType<typeof splitProviderConfig> | undefined
    let sealed: { ciphertext: Buffer; nonce: Buffer } | null = null
    if (body.config_json !== undefined) {
      let kind = body.kind
      let secretKeys: string[] = []
      if (!kind) {
        const { rows } = await fastify.db.query<ProviderKindRow>(
          `SELECT provider_kind AS kind, secret_config_keys FROM providers WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`,
          [params.id, params.zoneId],
        )
        if (!rows[0]) return reply.code(404).send({ error: 'provider_not_found' })
        kind = rows[0].kind
        secretKeys = rows[0].secret_config_keys ?? []
      }
      try {
        config = splitProviderConfig(kind, body.config_json, body.kind !== undefined)
        if (body.kind === undefined) {
          requireExistingOAuthSecret(kind, config.publicConfig, config.secretConfig, secretKeys)
        }
        sealed = sealSecretConfig(config.secretConfig)
      } catch (err) {
        return reply.code(400).send({ error: 'invalid_provider_config', message: err instanceof Error ? err.message : String(err) })
      }
    }

    const clearSecrets = body.kind !== undefined && config !== undefined && sealed === null
    const update = buildPatchUpdate(
      [params.id, params.zoneId],
      [
        patchColumn('name', body.name),
        patchColumn('identifier', body.identifier),
        patchColumn('provider_kind', body.kind),
        patchExpression(config ? JSON.stringify(config.publicConfig) : undefined, (placeholder) => `config_json = ${placeholder}::jsonb`),
        patchColumn('secret_config_ct', sealed?.ciphertext ?? (clearSecrets ? null : undefined)),
        patchColumn('secret_config_nonce', sealed?.nonce ?? (clearSecrets ? null : undefined)),
        patchColumn('secret_config_keys', config && (sealed || clearSecrets) ? config.secretKeys : undefined),
      ],
    )
    if (!update) return reply.code(400).send({ error: 'no_fields' })
    let rows: ProviderRow[]
    try {
      const result = await fastify.db.query<ProviderRow>(
        `UPDATE providers SET ${update.sets.join(', ')}, updated_at = now()
         WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL
         RETURNING ${RETURNING}`,
        update.values,
      )
      rows = result.rows
    } catch (err) {
      if (isProviderIdentifierConflict(err)) return reply.code(409).send({ error: 'provider_identifier_conflict' })
      throw err
    }
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

  // Verifies reachability and client authentication against the provider's own
  // allowlisted HTTPS token endpoint. No caller-supplied URL or payload is ever used,
  // DNS resolution is pinned away from private address space, and the response is
  // reduced to a fixed classification so no upstream data or secret can leak back.
  fastify.post('/zones/:zoneId/providers/:id/test', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const rlKey = `rl:providertest:${params.zoneId}`
    await fastify.redis.set(rlKey, 0, 'EX', 60, 'NX')
    const rlCount = await fastify.redis.incr(rlKey)
    if (rlCount > PROVIDER_TEST_RATE_LIMIT) {
      return reply.code(429).send({ error: 'provider_test_rate_limited' })
    }
    const { rows } = await fastify.db.query<ProviderTestRow>(
      `SELECT provider_kind AS kind, config_json, secret_config_ct, secret_config_nonce
       FROM providers WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`,
      [params.id, params.zoneId],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'provider_not_found' })
    const row = rows[0]
    const result = (status: ProviderTestResult['status'], detail: string): ProviderTestResult => ({
      status,
      detail,
      checked_at: new Date().toISOString(),
    })

    if (row.kind === 'none' || row.kind === 'caracal_mandate') {
      return result('untestable', 'This provider makes no upstream credential request, so there is nothing to test.')
    }
    if (row.kind === 'api_key' || row.kind === 'bearer_token') {
      return result(
        'untestable',
        'Static credentials are attached to upstream requests as-is; the provider has no endpoint of its own to test.',
      )
    }

    const config = row.config_json
    const method = stringConfig(config, 'client_auth_method') || 'client_secret_basic'
    if (method === 'private_key_jwt') {
      return result('untestable', 'private_key_jwt assertions are signed per token request and cannot be verified without one.')
    }
    const secrets = openSecretConfig(row.secret_config_ct, row.secret_config_nonce)
    const clientId = stringConfig(config, 'client_id')
    const clientSecret = secrets.client_secret ?? ''
    if (!clientId || (method !== 'none' && !clientSecret)) {
      return result('config_error', 'The provider client configuration is incomplete.')
    }
    let endpoint: URL
    try {
      endpoint = ensureAllowedTokenEndpoint(stringConfig(config, 'token_endpoint'), stringListConfig(config, 'allowed_token_hosts'))
    } catch (err) {
      return result('config_error', err instanceof Error ? err.message : String(err))
    }

    // client_credentials providers perform a real token request; authorization_code
    // providers submit a placeholder code, which a healthy endpoint rejects with
    // invalid_grant after accepting the client credentials.
    const form =
      row.kind === 'oauth2_client_credentials'
        ? new URLSearchParams({ grant_type: 'client_credentials' })
        : new URLSearchParams({
            grant_type: 'authorization_code',
            code: 'caracal-connection-test',
            redirect_uri: stringConfig(config, 'redirect_uri'),
          })
    const scopes = stringListConfig(config, 'scopes')
    if (row.kind === 'oauth2_client_credentials') {
      if (scopes.length > 0) form.set('scope', scopes.join(' '))
      const audience = stringConfig(config, 'audience')
      if (audience) form.set('audience', audience)
      const resource = stringConfig(config, 'resource')
      if (resource) form.set('resource', resource)
    }
    for (const [key, value] of Object.entries(recordConfig(config, 'token_params'))) {
      form.set(key, value)
    }

    let response: { statusCode: number; body: string }
    try {
      response = await exchangeProviderToken(endpoint, buildTokenRequest(form, clientId, clientSecret, method))
    } catch (err) {
      req.log.warn({ err, providerId: params.id }, 'provider connection test failed to reach the token endpoint')
      return result('unreachable', err instanceof Error ? err.message : 'The token endpoint could not be reached.')
    }

    const errCode = oauthErrorCode(response.body)
    if (row.kind === 'oauth2_client_credentials') {
      if (response.statusCode === 200) {
        // The issued token is parsed for presence only and discarded, never stored or returned.
        let issued = false
        try {
          issued = typeof (JSON.parse(response.body) as Record<string, unknown>).access_token === 'string'
        } catch {
          issued = false
        }
        return issued
          ? result('ok', 'The provider authenticated the client and issued a token.')
          : result('endpoint_error', 'The token endpoint returned HTTP 200 without an access token.')
      }
      if (errCode === 'invalid_client' || errCode === 'unauthorized_client' || response.statusCode === 401) {
        return result('auth_failed', 'The provider rejected the client credentials.')
      }
      return result('endpoint_error', `The token endpoint responded with HTTP ${response.statusCode}${errCode ? ` (${errCode})` : ''}.`)
    }
    if (errCode === 'invalid_grant') {
      return result('ok', 'The provider authenticated the client and rejected the placeholder code, as expected.')
    }
    if (errCode === 'invalid_client' || response.statusCode === 401) {
      return result('auth_failed', 'The provider rejected the client credentials.')
    }
    return result('endpoint_error', `The token endpoint responded with HTTP ${response.statusCode}${errCode ? ` (${errCode})` : ''}.`)
  })
}
