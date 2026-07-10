// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Provider CRUD routes for upstream credential and mandate forwarding sources.

import type { FastifyBaseLogger, FastifyInstance, FastifyPluginAsync } from 'fastify'
import { createPrivateKey, X509Certificate } from 'node:crypto'
import { SecretBackendError, providerSecretConfigRef } from '@caracalai/server-core'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { buildPatchUpdate, patchColumn, patchExpression, appendAttribution } from './patch.js'
import { resolveAttribution } from '../attribution.js'
import { TxAbort, withTransaction } from '../db.js'
import { ZoneIdParams, ZoneParams, parseParams } from './params.js'
import { zoneExists } from '../zone-guard.js'
import { appendKeysetCondition, listPage, parseListPagination } from './list-pagination.js'
import { assertReservedNamespace } from '../reserved-namespace.js'
import {
  MULTILINE_SECRET_CONFIG_KEYS,
  PROVIDER_KINDS,
  PUBLIC_PROVIDER_CONFIG_KEYS,
  SECRET_PROVIDER_CONFIG_KEYS,
} from '../provider-config.js'
import {
  buildClientAssertion,
  buildGrantAssertion,
  buildTokenRequest,
  ensureAllowedTokenEndpoint,
  exchangeProviderToken,
  fetchProviderMetadata,
  readProviderSecrets,
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
const OAuthGrantType = z.enum(['client_credentials', 'jwt_bearer'])
type OAuthGrantType = z.infer<typeof OAuthGrantType>
const PROVIDER_IDENTIFIER_PREFIX = 'provider://'
const PROVIDER_IDENTIFIER_PATTERN = /^provider:\/\/[a-z0-9]+(?:-[a-z0-9]+)*$/
const PROVIDER_IDENTIFIER_UNIQUE_INDEX = 'providers_zone_identifier_active_uidx'
const HEADER_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const AUTH_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/
const OAUTH_PARAM_PATTERN = /^[A-Za-z0-9._~-]+$/
const HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/
const RESERVED_CREDENTIAL_HEADERS = new Set([
  'baggage',
  'connection',
  'content-encoding',
  'content-length',
  'content-type',
  'expect',
  'forwarded',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'traceparent',
  'tracestate',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
  'x-real-ip',
  'x-request-id',
])
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
    check: z.boolean().optional(),
  })
  .refine((body) => body.name !== undefined || body.identifier !== undefined, { message: 'name_or_identifier_required' })

const ProviderPatchBody = z.object({
  name: OptionalText,
  identifier: OptionalText,
  kind: ProviderKind.optional(),
  config_json: z.record(z.string(), z.unknown()).optional(),
})

const ProviderDiscoveryBody = z.object({ issuer: z.string().trim().min(1).max(512) })

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
  if (typeof value !== 'string' || !HEADER_TOKEN_PATTERN.test(value.trim()) || !safeCredentialHeader(value)) throw new Error(message)
  config[key] = value.trim()
}

function safeCredentialHeader(value: string): boolean {
  const name = value.trim().toLowerCase()
  return (
    name !== '' &&
    !RESERVED_CREDENTIAL_HEADERS.has(name) &&
    !name.startsWith('x-caracal-') &&
    !name.startsWith('x-forwarded-') &&
    !name.startsWith('proxy-')
  )
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

function requireOptionalOAuthClientAuthMethod(config: Record<string, unknown>, fallback: OAuthClientAuthMethod): OAuthClientAuthMethod {
  const method = config.client_auth_method
  if (method === undefined) return fallback
  const parsed = OAuthClientAuthMethod.safeParse(method)
  if (!parsed.success) throw new Error('oauth2 provider config client_auth_method is invalid')
  return parsed.data
}

function requireOptionalOAuthGrantType(config: Record<string, unknown>): OAuthGrantType {
  const grant = config.grant_type
  if (grant === undefined) return 'client_credentials'
  const parsed = OAuthGrantType.safeParse(grant)
  if (!parsed.success) throw new Error('oauth2_client_credentials provider config grant_type must be client_credentials or jwt_bearer')
  return parsed.data
}

function requireOptionalCertificate(config: Record<string, unknown>, privateKeyPem: string | undefined): void {
  const value = config.certificate
  if (value === undefined) return
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('oauth2_client_credentials provider config certificate must be a PEM certificate')
  }
  let certificate: X509Certificate
  try {
    certificate = new X509Certificate(value.trim())
  } catch {
    throw new Error('oauth2_client_credentials provider config certificate must be a PEM certificate')
  }
  if (privateKeyPem) {
    let matches = false
    try {
      matches = certificate.checkPrivateKey(createPrivateKey(privateKeyPem))
    } catch {
      matches = false
    }
    if (!matches) throw new Error('oauth2_client_credentials provider config certificate does not match private_key')
  }
  config.certificate = value.trim()
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
      // Outer whitespace is a paste artifact: sealed verbatim it would ride into the
      // upstream credential and fail every call as an opaque transport error, so the
      // secret is trimmed at intake. Embedded control characters are the same mistake
      // in single-line credentials; only multiline secrets such as PEM keys carry
      // legitimate newlines.
      const secret = value.trim()
      if (!MULTILINE_SECRET_CONFIG_KEYS.has(key) && /[\u0000-\u001f\u007f]/.test(secret)) {
        throw new Error(`${kind} provider config ${key} must not contain control characters`)
      }
      secretConfig[key] = secret
    } else {
      publicConfig[key] = value
    }
  }

  if (kind === 'none' || kind === 'caracal_mandate') {
    return { publicConfig, secretConfig, secretKeys: [] }
  }
  if (kind === 'http_basic') {
    requireString(publicConfig, 'username', 'http_basic provider config requires username')
    requireOptionalText(publicConfig, 'username', 'http_basic provider config requires username')
    requireOptionalHostList(publicConfig, 'allowed_token_hosts', 'http_basic provider config allowed_token_hosts must be DNS hostnames')
    if (requireSecrets && !secretConfig.password) throw new Error('http_basic provider config requires password')
  } else if (kind === 'api_key') {
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
    requireOptionalHostList(publicConfig, 'allowed_token_hosts', 'api_key provider config allowed_token_hosts must be DNS hostnames')
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
    const grantType = kind === 'oauth2_client_credentials' ? requireOptionalOAuthGrantType(publicConfig) : 'client_credentials'
    if (kind === 'oauth2_client_credentials') {
      publicConfig.grant_type = grantType
      requireOptionalText(publicConfig, 'audience', 'oauth2_client_credentials provider config audience must be a non-empty string')
      requireOptionalText(publicConfig, 'resource', 'oauth2_client_credentials provider config resource must be a non-empty string')
      requireOptionalText(publicConfig, 'key_id', 'oauth2_client_credentials provider config key_id must be a non-empty string')
      requireOptionalText(
        publicConfig,
        'assertion_subject',
        'oauth2_client_credentials provider config assertion_subject must be a non-empty string',
      )
      requireOptionalText(
        publicConfig,
        'assertion_audience',
        'oauth2_client_credentials provider config assertion_audience must be a non-empty string',
      )
      if (grantType === 'jwt_bearer') {
        if (publicConfig.audience !== undefined || publicConfig.resource !== undefined) {
          throw new Error('oauth2_client_credentials provider config jwt_bearer uses assertion_audience, not audience or resource')
        }
      } else if (publicConfig.assertion_subject !== undefined || publicConfig.assertion_audience !== undefined) {
        throw new Error('oauth2_client_credentials provider config assertion fields require the jwt_bearer grant_type')
      }
    }
    // The jwt_bearer grant carries the signed assertion itself, so client authentication
    // defaults to none rather than demanding a client secret the flow never uses.
    const clientAuthMethod = requireOptionalOAuthClientAuthMethod(publicConfig, grantType === 'jwt_bearer' ? 'none' : 'client_secret_basic')
    publicConfig.client_auth_method = clientAuthMethod
    if (kind === 'oauth2_authorization_code' && clientAuthMethod === 'private_key_jwt') {
      throw new Error('oauth2_authorization_code provider config client_auth_method is not supported')
    }
    if (grantType === 'jwt_bearer' && clientAuthMethod === 'private_key_jwt') {
      throw new Error('oauth2_client_credentials provider config client_auth_method private_key_jwt cannot be combined with jwt_bearer')
    }
    if (kind === 'oauth2_authorization_code') {
      requireHttpsUrl(
        publicConfig,
        'authorization_endpoint',
        'oauth2_authorization_code provider config authorization_endpoint must be an HTTPS URL',
      )
      requireAbsoluteUri(publicConfig, 'redirect_uri', 'oauth2_authorization_code provider config redirect_uri must be an absolute URI')
      if (publicConfig.revocation_endpoint !== undefined) {
        requireHttpsUrl(
          publicConfig,
          'revocation_endpoint',
          'oauth2_authorization_code provider config revocation_endpoint must be an HTTPS URL',
        )
      }
      requireOptionalStringRecord(
        publicConfig,
        'authorization_params',
        RESERVED_OAUTH_AUTHORIZATION_PARAMS,
        'oauth2_authorization_code provider config authorization_params must be non-reserved string key/value pairs',
      )
    }
    const needsPrivateKey = clientAuthMethod === 'private_key_jwt' || grantType === 'jwt_bearer'
    if (clientAuthMethod === 'private_key_jwt' && secretConfig.client_secret) {
      throw new Error(`${kind} provider config client_secret is not used with private_key_jwt`)
    }
    if (!needsPrivateKey) {
      if (secretConfig.private_key) throw new Error(`${kind} provider config private_key requires private_key_jwt or jwt_bearer`)
      if (publicConfig.key_id !== undefined) throw new Error(`${kind} provider config key_id requires private_key_jwt or jwt_bearer`)
    }
    // A malformed signing key otherwise surfaces only when the first assertion is
    // signed - at a connectivity check the operator may skip, or worse at runtime -
    // so the PEM is parsed here and creation fails fast with a field-level error.
    if (secretConfig.private_key) {
      try {
        createPrivateKey(secretConfig.private_key)
      } catch {
        throw new Error(`${kind} provider config private_key must be a valid PEM private key`)
      }
    }
    if (clientAuthMethod === 'private_key_jwt') {
      requireOptionalCertificate(publicConfig, secretConfig.private_key)
    } else if (publicConfig.certificate !== undefined) {
      throw new Error(`${kind} provider config certificate requires private_key_jwt`)
    }
    if (requireSecrets) {
      if (needsPrivateKey && !secretConfig.private_key) throw new Error(`${kind} provider config requires private_key`)
      if (clientAuthMethod !== 'none' && clientAuthMethod !== 'private_key_jwt' && !secretConfig.client_secret) {
        throw new Error(`${kind} provider config requires client_secret`)
      }
    }
  }
  requireOptionalAuthScheme(publicConfig, 'auth_scheme', `${kind} provider config auth_scheme must be an auth scheme token`)
  // A credential pasted with its authorization scheme still attached would be composed
  // into "<scheme> <scheme> <value>" at the gateway, so it is rejected wherever a scheme
  // is in effect: always for bearer_token (Bearer default), and for api_key only when an
  // auth_scheme is configured, since a schemeless api_key value is forwarded raw and may
  // intentionally carry any prefix.
  const composed =
    kind === 'bearer_token'
      ? { key: 'bearer_token', scheme: (publicConfig.auth_scheme as string | undefined) ?? 'Bearer' }
      : kind === 'api_key' && typeof publicConfig.auth_scheme === 'string'
        ? { key: 'api_key', scheme: publicConfig.auth_scheme }
        : undefined
  if (composed && secretConfig[composed.key]?.toLowerCase().startsWith(`${composed.scheme.toLowerCase()} `)) {
    throw new Error(`${kind} provider config ${composed.key} must not start with the '${composed.scheme}' scheme; the gateway adds it`)
  }
  requireOptionalBoolean(publicConfig, 'forward_caracal_identity', `${kind} provider config forward_caracal_identity must be a boolean`)
  requireOptionalBoolean(publicConfig, 'allow_runtime_injection', `${kind} provider config allow_runtime_injection must be a boolean`)
  return { publicConfig, secretConfig, secretKeys: Object.keys(secretConfig).sort() }
}

function secretConfigPayload(secretConfig: Record<string, string>): Buffer | null {
  if (Object.keys(secretConfig).length === 0) return null
  return Buffer.from(JSON.stringify(secretConfig), 'utf8')
}

interface ProviderRow {
  id: string
  zone_id: string
  name: string
  identifier: string
  kind: string
  config_json: unknown
  secret_config_keys: string[]
  connectivity_failed_at: string | null
  created_at: string
  updated_at: string
  archived_at: string | null
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
  const needsPrivateKey = method === 'private_key_jwt' || publicConfig.grant_type === 'jwt_bearer'
  if (needsPrivateKey && !secretConfig.private_key && !secretKeys.includes('private_key')) {
    throw new Error(`${kind} provider config requires private_key`)
  }
  if (method !== 'none' && method !== 'private_key_jwt' && !secretConfig.client_secret && !secretKeys.includes('client_secret')) {
    throw new Error(`${kind} provider config requires client_secret`)
  }
}

const RETURNING = `id, zone_id, name, identifier, provider_kind AS kind,
                  config_json, secret_config_keys, connectivity_failed_at,
                  created_by, created_via_operator, updated_by, updated_via_operator, created_at, updated_at, archived_at`

// Connectivity checks and issuer discovery reach outside the platform, so each probe
// class is capped per zone per minute to keep the control plane from being used as a
// request amplifier.
const PROVIDER_TEST_RATE_LIMIT = 10

const OAUTH_PROVIDER_KINDS: ReadonlySet<ProviderKind> = new Set(['oauth2_authorization_code', 'oauth2_client_credentials'])

async function outboundProbeAllowed(redis: FastifyInstance['redis'], bucket: string): Promise<boolean> {
  const rlKey = `rl:${bucket}`
  await redis.set(rlKey, 0, 'EX', 60, 'NX')
  return (await redis.incr(rlKey)) <= PROVIDER_TEST_RATE_LIMIT
}

interface ProviderTestRow {
  kind: ProviderKind
  config_json: Record<string, unknown>
}

interface ProviderTestResult {
  status: 'ok' | 'auth_failed' | 'unreachable' | 'endpoint_error' | 'config_error'
  detail: string
  checked_at: string
}

// Only a standard OAuth error code is taken from the upstream response - JSON per RFC 6749,
// with a form-encoded fallback for endpoints that answer that way regardless of Accept - so
// nothing the provider returns can flow back to the caller beyond a fixed-vocabulary token.
function oauthErrorCode(body: string): string {
  const valid = (code: unknown): code is string => typeof code === 'string' && /^[a-z_]{1,64}$/.test(code)
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    return valid(parsed.error) ? parsed.error : ''
  } catch {
    const code = new URLSearchParams(body).get('error')
    return valid(code) ? code : ''
  }
}

// Vendor endpoints use their own vocabulary for the two signals the check cares about:
// GitHub answers HTTP 200 with incorrect_client_credentials or bad_verification_code where
// RFC 6749 servers answer 401 invalid_client or 400 invalid_grant.
const CLIENT_REJECTED_CODES: ReadonlySet<string> = new Set(['invalid_client', 'unauthorized_client', 'incorrect_client_credentials'])
const GRANT_REJECTED_CODES: ReadonlySet<string> = new Set(['invalid_grant', 'bad_verification_code'])

// Verifies an OAuth provider against its own allowlisted HTTPS token endpoint. Only OAuth
// kinds are checkable: the other kinds make no upstream credential request of their own, so
// no meaningful preflight exists and callers must reject the check instead of faking one.
// No caller-supplied URL or payload is ever used, DNS resolution is pinned away from private
// address space, and the response is reduced to a fixed classification so no upstream data
// or secret can leak.
async function runProviderCheck(
  kind: ProviderKind,
  config: Record<string, unknown>,
  secrets: Record<string, string>,
  log: FastifyBaseLogger,
): Promise<ProviderTestResult> {
  const result = (status: ProviderTestResult['status'], detail: string): ProviderTestResult => ({
    status,
    detail,
    checked_at: new Date().toISOString(),
  })

  const method = stringConfig(config, 'client_auth_method') || 'client_secret_basic'
  const grantType = kind === 'oauth2_client_credentials' ? stringConfig(config, 'grant_type') || 'client_credentials' : 'client_credentials'
  const clientId = stringConfig(config, 'client_id')
  const clientSecret = secrets.client_secret ?? ''
  if (!clientId) return result('config_error', 'The provider client configuration is incomplete.')
  if ((method === 'private_key_jwt' || grantType === 'jwt_bearer') && !secrets.private_key) {
    return result('config_error', 'The provider client configuration is incomplete.')
  }
  if (method !== 'none' && method !== 'private_key_jwt' && !clientSecret) {
    return result('config_error', 'The provider client configuration is incomplete.')
  }
  let endpoint: URL
  try {
    endpoint = ensureAllowedTokenEndpoint(stringConfig(config, 'token_endpoint'), stringListConfig(config, 'allowed_token_hosts'))
  } catch (err) {
    return result('config_error', err instanceof Error ? err.message : String(err))
  }
  let assertion: string | undefined
  if (method === 'private_key_jwt') {
    try {
      assertion = buildClientAssertion(
        endpoint.toString(),
        clientId,
        stringConfig(config, 'key_id'),
        secrets.private_key,
        stringConfig(config, 'certificate') || undefined,
      )
    } catch (err) {
      return result('config_error', err instanceof Error ? err.message : 'The private key could not sign a client assertion.')
    }
  }

  // client_credentials providers perform a real token request; jwt_bearer providers
  // submit a real signed assertion grant; authorization_code providers submit a
  // placeholder code, which a healthy endpoint rejects with invalid_grant after
  // accepting the client credentials. The placeholder verifier keeps PKCE-mandating
  // endpoints moving past request validation to code validation; endpoints without
  // PKCE ignore it.
  const scopes = stringListConfig(config, 'scopes')
  let form: URLSearchParams
  if (kind === 'oauth2_client_credentials' && grantType === 'jwt_bearer') {
    let grantAssertion: string
    try {
      grantAssertion = buildGrantAssertion({
        tokenEndpoint: endpoint.toString(),
        clientId,
        subject: stringConfig(config, 'assertion_subject') || undefined,
        audience: stringConfig(config, 'assertion_audience') || undefined,
        scopes,
        keyId: stringConfig(config, 'key_id'),
        privateKeyPem: secrets.private_key,
      })
    } catch (err) {
      return result('config_error', err instanceof Error ? err.message : 'The private key could not sign the assertion grant.')
    }
    form = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: grantAssertion })
  } else if (kind === 'oauth2_client_credentials') {
    form = new URLSearchParams({ grant_type: 'client_credentials' })
    if (scopes.length > 0) form.set('scope', scopes.join(' '))
    const audience = stringConfig(config, 'audience')
    if (audience) form.set('audience', audience)
    const resource = stringConfig(config, 'resource')
    if (resource) form.set('resource', resource)
  } else {
    form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'caracal-connection-test',
      code_verifier: 'caracal-connection-test-code-verifier-0123456789abcdefghijklmn',
      redirect_uri: stringConfig(config, 'redirect_uri'),
    })
  }
  for (const [key, value] of Object.entries(recordConfig(config, 'token_params'))) {
    form.set(key, value)
  }

  let response: { statusCode: number; body: string }
  try {
    response = await exchangeProviderToken(endpoint, buildTokenRequest(form, clientId, clientSecret, method, assertion))
  } catch (err) {
    log.warn({ err }, 'provider connectivity check failed to reach the token endpoint')
    return result('unreachable', err instanceof Error ? err.message : 'The token endpoint could not be reached.')
  }

  const errCode = oauthErrorCode(response.body)
  if (kind === 'oauth2_client_credentials') {
    if (response.statusCode === 200 && !errCode) {
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
    if (grantType === 'jwt_bearer' && GRANT_REJECTED_CODES.has(errCode)) {
      return result('auth_failed', 'The provider rejected the signed assertion. Check the key, subject, audience, and scopes.')
    }
    if (CLIENT_REJECTED_CODES.has(errCode) || response.statusCode === 401) {
      return result('auth_failed', 'The provider rejected the client credentials.')
    }
    if (errCode === 'invalid_scope' || errCode === 'invalid_target') {
      return result(
        'config_error',
        `The provider accepted the client but rejected the request (${errCode}). Align the provider's scope, audience, and resource settings with what the token endpoint expects.`,
      )
    }
    return result('endpoint_error', `The token endpoint responded with HTTP ${response.statusCode}${errCode ? ` (${errCode})` : ''}.`)
  }
  if (GRANT_REJECTED_CODES.has(errCode)) {
    return result('ok', 'The provider authenticated the client and rejected the placeholder code, as expected.')
  }
  if (CLIENT_REJECTED_CODES.has(errCode) || response.statusCode === 401) {
    return result('auth_failed', 'The provider rejected the client credentials.')
  }
  return result('endpoint_error', `The token endpoint responded with HTTP ${response.statusCode}${errCode ? ` (${errCode})` : ''}.`)
}

export const providersRoutes: FastifyPluginAsync = async (fastify) => {
  const ListStatusQuery = z.object({
    status: z.enum(['active', 'archived']).default('active'),
  })

  fastify.get('/zones/:zoneId/providers', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const page = parseListPagination(req, reply)
    if (!page) return
    const search = ListStatusQuery.safeParse(req.query ?? {})
    if (!search.success) return reply.code(400).send({ error: 'invalid_query' })
    // Archived providers stay listable for audit: their credential routing is removed
    // at archive time, so exposing the records grants nothing beyond visibility into
    // past credential sources.
    const lifecycle = search.data.status === 'archived' ? 'archived_at IS NOT NULL' : 'archived_at IS NULL'
    const keyset = appendKeysetCondition({ conds: ['zone_id = $1', lifecycle], values: [params.zoneId] }, page)
    const { rows } = await fastify.db.query<ProviderRow>(
      `SELECT ${RETURNING}
       FROM providers WHERE ${keyset.conds.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ${keyset.limitPlaceholder}`,
      keyset.values,
    )
    return listPage(rows, page.limit)
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
    if (identifierError) return reply.code(400).send({ error: 'invalid_provider_identifier', error_description: identifierError })
    let config: ReturnType<typeof splitProviderConfig>
    try {
      config = splitProviderConfig(body.kind, body.config_json, true)
    } catch (err) {
      return reply.code(400).send({ error: 'invalid_provider_config', error_description: err instanceof Error ? err.message : String(err) })
    }
    let connectivityFailedAt: Date | null = null
    if (body.check) {
      if (!OAUTH_PROVIDER_KINDS.has(body.kind)) {
        return reply.code(400).send({ error: 'provider_check_unsupported' })
      }
      if (!(await outboundProbeAllowed(fastify.redis, `providertest:${params.zoneId}`))) {
        return reply.code(429).send({ error: 'provider_test_rate_limited' })
      }
      const check = await runProviderCheck(body.kind, config.publicConfig, config.secretConfig, req.log)
      if (check.status !== 'ok') {
        return reply.code(422).send({ error: 'provider_check_failed', details: { check } })
      }
    } else if (OAUTH_PROVIDER_KINDS.has(body.kind)) {
      connectivityFailedAt = new Date()
    }
    const secretPayload = secretConfigPayload(config.secretConfig)
    const explicitIdentifier = body.identifier !== undefined
    let identifier = body.identifier
    if (identifier === undefined) {
      identifier = await nextProviderIdentifier(fastify.db, params.zoneId, body.name ?? `${body.kind} provider`)
    }
    const reservedErr = assertReservedNamespace('providerIdentifier', identifier, req.actor)
    if (reservedErr) return reply.code(409).send(reservedErr)
    const attribution = await resolveAttribution(req, fastify.db, params.zoneId)
    // The row insert and the credential write commit or fail together: the
    // transaction stays open across the put, so a backend failure rolls the row
    // back and an identifier conflict retries before any credential is written.
    const id = uuidv7()
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const row = await withTransaction(fastify.db, async (client) => {
          const { rows } = await client.query<ProviderRow>(
            `INSERT INTO providers (id, zone_id, name, identifier, provider_kind, config_json,
                                    secret_config_keys, connectivity_failed_at,
                                    created_by, created_via_operator)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
             RETURNING ${RETURNING}`,
            [
              id,
              params.zoneId,
              body.name ?? identifier,
              identifier,
              body.kind,
              JSON.stringify(config.publicConfig),
              config.secretKeys,
              connectivityFailedAt,
              attribution.actor,
              attribution.viaOperator,
            ],
          )
          if (secretPayload) {
            await fastify.secrets.put(providerSecretConfigRef(params.zoneId, id), secretPayload)
          }
          return rows[0]
        })
        return reply.code(201).send(row)
      } catch (err) {
        if (err instanceof SecretBackendError) {
          req.log.error({ err }, 'secret backend rejected provider credential write')
          return reply.code(502).send({ error: 'secret_backend_unavailable' })
        }
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
    if (identifierError) return reply.code(400).send({ error: 'invalid_provider_identifier', error_description: identifierError })
    const reservedErr = assertReservedNamespace('providerIdentifier', body.identifier, req.actor)
    if (reservedErr) return reply.code(409).send(reservedErr)

    if (body.kind !== undefined && body.config_json === undefined) {
      return reply.code(400).send({ error: 'provider_config_required' })
    }
    let config: ReturnType<typeof splitProviderConfig> | undefined
    let secretPayload: Buffer | null = null
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
        secretPayload = secretConfigPayload(config.secretConfig)
      } catch (err) {
        return reply
          .code(400)
          .send({ error: 'invalid_provider_config', error_description: err instanceof Error ? err.message : String(err) })
      }
    }

    const clearSecrets = body.kind !== undefined && config !== undefined && secretPayload === null
    const update = buildPatchUpdate(
      [params.id, params.zoneId],
      [
        patchColumn('name', body.name),
        patchColumn('identifier', body.identifier),
        patchColumn('provider_kind', body.kind),
        patchExpression(config ? JSON.stringify(config.publicConfig) : undefined, (placeholder) => `config_json = ${placeholder}::jsonb`),
        patchColumn('secret_config_keys', config && (secretPayload || clearSecrets) ? config.secretKeys : undefined),
        patchColumn('connectivity_failed_at', body.kind !== undefined && !OAUTH_PROVIDER_KINDS.has(body.kind) ? null : undefined),
      ],
    )
    if (!update) return reply.code(400).send({ error: 'no_fields' })
    appendAttribution(update, await resolveAttribution(req, fastify.db, params.zoneId))
    // The row update and the credential write commit or fail together: the
    // transaction stays open across the put, so a backend failure rolls the row
    // back to its previous state and an identifier conflict never touches the
    // stored credential document.
    const ref = providerSecretConfigRef(params.zoneId, params.id)
    let row: ProviderRow | undefined
    try {
      row = await withTransaction(fastify.db, async (client) => {
        const result = await client.query<ProviderRow>(
          `UPDATE providers SET ${update.sets.join(', ')}, updated_at = now()
           WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL
           RETURNING ${RETURNING}`,
          update.values,
        )
        if (!result.rows[0]) throw new TxAbort<ProviderRow | undefined>(undefined)
        if (secretPayload) await fastify.secrets.put(ref, secretPayload)
        else if (clearSecrets) await fastify.secrets.delete(ref)
        return result.rows[0]
      })
    } catch (err) {
      if (isProviderIdentifierConflict(err)) return reply.code(409).send({ error: 'provider_identifier_conflict' })
      if (err instanceof SecretBackendError) {
        req.log.error({ err }, 'secret backend rejected provider credential update')
        return reply.code(502).send({ error: 'secret_backend_unavailable' })
      }
      throw err
    }
    if (!row) return reply.code(404).send({ error: 'provider_not_found' })
    return row
  })

  fastify.delete('/zones/:zoneId/providers/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const attribution = await resolveAttribution(req, fastify.db, params.zoneId)
    const { rowCount } = await fastify.db.query(
      `UPDATE providers SET archived_at = now(), updated_at = now(), updated_by = $3, updated_via_operator = $4
       WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`,
      [params.id, params.zoneId, attribution.actor, attribution.viaOperator],
    )
    if (!rowCount) return reply.code(404).send({ error: 'provider_not_found' })
    // Archival is terminal for providers, so the stored credential document is
    // discarded with the row. A backend outage here cannot unwind the archive;
    // the leftover entry is unreachable and removal is retried by operators.
    try {
      await fastify.secrets.delete(providerSecretConfigRef(params.zoneId, params.id))
    } catch (err) {
      if (!(err instanceof SecretBackendError)) throw err
      req.log.warn({ err }, 'secret backend rejected credential delete for archived provider')
    }
    return reply.code(204).send()
  })

  // Runs the OAuth connectivity check on demand and records the outcome, clearing the
  // failed marker as soon as the check passes. Kinds without a checkable endpoint are
  // rejected rather than given a fake pass.
  fastify.post('/zones/:zoneId/providers/:id/test', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query<ProviderTestRow>(
      `SELECT provider_kind AS kind, config_json
       FROM providers WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`,
      [params.id, params.zoneId],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'provider_not_found' })
    const row = rows[0]
    if (!OAUTH_PROVIDER_KINDS.has(row.kind)) {
      return reply.code(400).send({ error: 'provider_check_unsupported' })
    }
    if (!(await outboundProbeAllowed(fastify.redis, `providertest:${params.zoneId}`))) {
      return reply.code(429).send({ error: 'provider_test_rate_limited' })
    }
    let secrets: Record<string, string>
    try {
      secrets = await readProviderSecrets(fastify.secrets, params.zoneId, params.id)
    } catch (err) {
      if (!(err instanceof SecretBackendError)) throw err
      return reply.code(502).send({ error: 'secret_backend_unavailable' })
    }
    const check = await runProviderCheck(row.kind, row.config_json, secrets, req.log)
    await fastify.db.query(`UPDATE providers SET connectivity_failed_at = $3 WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL`, [
      params.id,
      params.zoneId,
      check.status === 'ok' ? null : new Date(),
    ])
    return check
  })

  // Resolves OAuth endpoints from an issuer's published metadata (OIDC discovery with an
  // RFC 8414 fallback) so operators can autofill provider forms instead of hand-copying
  // endpoint URLs. The probe is outbound-safe: HTTPS-only issuers, SSRF-pinned DNS, no
  // redirects, a strict issuer match against the returned document, and endpoint fields
  // revalidated as HTTPS URLs before anything reaches the caller.
  fastify.post('/zones/:zoneId/providers/discovery', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    if (!(await zoneExists(fastify.db, params.zoneId))) {
      return reply.code(404).send({ error: 'zone_not_found' })
    }
    const parsed = ProviderDiscoveryBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_issuer' })
    let issuer: URL
    try {
      issuer = new URL(parsed.data.issuer.trim())
    } catch {
      return reply.code(400).send({ error: 'invalid_issuer', error_description: 'issuer must be an HTTPS URL' })
    }
    if (issuer.protocol !== 'https:' || !issuer.hostname || issuer.username || issuer.password || issuer.search || issuer.hash) {
      return reply
        .code(400)
        .send({ error: 'invalid_issuer', error_description: 'issuer must be an HTTPS URL without query, fragment, or credentials' })
    }
    if (!(await outboundProbeAllowed(fastify.redis, `providerdiscovery:${params.zoneId}`))) {
      return reply.code(429).send({ error: 'provider_discovery_rate_limited' })
    }
    const path = issuer.pathname.replace(/\/+$/, '')
    const candidates = [
      `${issuer.origin}${path}/.well-known/openid-configuration`,
      `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
    ]
    let metadata: Record<string, unknown> | undefined
    let failure = 'The issuer does not publish OIDC or OAuth authorization server metadata.'
    for (const candidate of candidates) {
      let response: { statusCode: number; body: string }
      try {
        response = await fetchProviderMetadata(new URL(candidate))
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err)
        continue
      }
      if (response.statusCode !== 200) continue
      try {
        const body = JSON.parse(response.body) as unknown
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          metadata = body as Record<string, unknown>
          break
        }
      } catch {
        failure = 'The issuer metadata document is not valid JSON.'
      }
    }
    if (!metadata) {
      return reply.code(422).send({ error: 'provider_discovery_failed', error_description: failure })
    }
    const trimSlash = (value: string) => value.replace(/\/+$/, '')
    // RFC 8414 section 3.3: the issuer inside the document must match the requested
    // issuer, otherwise a compromised host could splice another provider's endpoints.
    if (typeof metadata.issuer !== 'string' || trimSlash(metadata.issuer.trim()) !== trimSlash(issuer.toString())) {
      return reply
        .code(422)
        .send({ error: 'provider_discovery_failed', error_description: 'The metadata issuer does not match the requested issuer.' })
    }
    const httpsEndpoint = (value: unknown): string | undefined => {
      if (typeof value !== 'string') return undefined
      try {
        const url = new URL(value.trim())
        return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url.toString() : undefined
      } catch {
        return undefined
      }
    }
    const tokenEndpoint = httpsEndpoint(metadata.token_endpoint)
    if (!tokenEndpoint) {
      return reply
        .code(422)
        .send({ error: 'provider_discovery_failed', error_description: 'The issuer metadata has no HTTPS token endpoint.' })
    }
    const scopes = Array.isArray(metadata.scopes_supported)
      ? metadata.scopes_supported
          .filter((scope): scope is string => typeof scope === 'string' && scope.trim().length > 0 && scope.length <= 200)
          .slice(0, 64)
      : []
    const authMethods = Array.isArray(metadata.token_endpoint_auth_methods_supported)
      ? metadata.token_endpoint_auth_methods_supported.filter(
          (method): method is string => typeof method === 'string' && OAuthClientAuthMethod.safeParse(method).success,
        )
      : []
    return {
      issuer: trimSlash(issuer.toString()),
      token_endpoint: tokenEndpoint,
      ...(httpsEndpoint(metadata.authorization_endpoint) ? { authorization_endpoint: httpsEndpoint(metadata.authorization_endpoint) } : {}),
      ...(httpsEndpoint(metadata.revocation_endpoint) ? { revocation_endpoint: httpsEndpoint(metadata.revocation_endpoint) } : {}),
      ...(scopes.length > 0 ? { scopes_supported: scopes } : {}),
      ...(authMethods.length > 0 ? { token_endpoint_auth_methods_supported: authMethods } : {}),
    }
  })
}
