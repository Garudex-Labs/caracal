// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Delegated grant CRUD routes: creation and revocation with session invalidation.

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { createHash, randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { loadZoneKek, open, seal } from '@caracalai/core'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { scopesAllowed } from '@caracalai/core'
import { STREAM_SESSIONS_REVOKE, redisTimeMs } from '../redis.js'
import { enqueueOutbox } from '../outbox.js'
import { withTransaction, TxAbort } from '../db.js'
import { ZoneIdParams, ZoneParams, parseParams } from './params.js'
import { zoneExists } from '../zone-guard.js'
import { appendKeysetCondition, parseListPagination, setNextLink } from './list-pagination.js'

const SESSION_REVOKE_BATCH = 1000

// Scope strings cross trust boundaries (Rego policies, upstream IdPs). Restrict to a
// safe charset and bounded length so neither side has to sanitize control characters,
// whitespace, or absurdly long values.
const ScopePattern = /^[a-z0-9:_./-]+$/
const ScopeMaxLen = 200
const Scope = z.string().min(1).max(ScopeMaxLen).regex(ScopePattern)

const GrantBody = z.object({
  application_id: z.string().min(1),
  user_id: z.string().min(1),
  resource_id: z.string().min(1),
  scopes: z.array(Scope).min(1).max(64),
})

const GrantListQuery = z.object({
  application_id: z.string().min(1).optional(),
  user_id: z.string().min(1).optional(),
  subject_id: z.string().min(1).optional(),
  resource_id: z.string().min(1).optional(),
  provider_id: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  scopes: z.preprocess(
    (value) =>
      typeof value === 'string'
        ? value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
        : value,
    z.array(Scope).min(1).max(64).optional(),
  ),
})

const ProviderGrantBody = z.object({
  user_id: z.string().min(1),
  resource_id: z.string().min(1),
  provider_id: z.string().min(1),
  scopes: z.array(Scope).min(1).max(64),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_at: z.string().datetime().optional(),
})

const ProviderGrantOAuthAuthorizeBody = z.object({
  user_id: z.string().min(1),
  resource_id: z.string().min(1),
  provider_id: z.string().min(1),
  scopes: z.array(Scope).min(1).max(64),
})

const ProviderGrantRevokeBody = z.object({
  user_id: z.string().min(1),
  resource_id: z.string().min(1),
  provider_id: z.string().min(1),
})

const OAuthCallbackQuery = z.object({
  state: z.string().min(32).max(256),
  code: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  error_description: z.string().min(1).optional(),
})

const OAuthStateBody = z.object({
  zone_id: z.string().min(1),
  user_id: z.string().min(1),
  resource_id: z.string().min(1),
  provider_id: z.string().min(1),
  scopes: z.array(Scope).min(1).max(64),
  code_verifier: z.string().min(43).max(128),
})

const OAUTH_STATE_TTL_SECONDS = 10 * 60
const OAUTH_STATE_KEY_PREFIX = 'api:provider_oauth_state:'
const PROVIDER_TOKEN_EXCHANGE_TIMEOUT_MS = 15_000
const PROVIDER_TOKEN_EXCHANGE_MAX_BODY_BYTES = 64 * 1024

interface ProviderOAuthRow {
  id: string
  provider_kind: string
  config_json: Record<string, unknown>
  secret_config_ct: Buffer | null
  secret_config_nonce: Buffer | null
  resource_scopes: string[] | null
  resource_provider_id: string | null
}

interface ProviderSecretConfig {
  client_secret?: string
}

function sealText(value: string): Buffer {
  const sealed = seal(loadZoneKek(), Buffer.from(value, 'utf8'))
  return Buffer.concat([sealed.nonce, sealed.ciphertext])
}

function openProviderSecretConfig(row: ProviderOAuthRow): ProviderSecretConfig {
  if (!row.secret_config_ct || !row.secret_config_nonce) return {}
  const plaintext = open(loadZoneKek(), { nonce: row.secret_config_nonce, ciphertext: row.secret_config_ct })
  try {
    return JSON.parse(plaintext.toString('utf8')) as ProviderSecretConfig
  } finally {
    plaintext.fill(0)
  }
}

function randomUrlToken(): string {
  return randomBytes(32).toString('base64url')
}

function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

function stringConfig(config: Record<string, unknown>, key: string): string {
  const value = config[key]
  return typeof value === 'string' ? value.trim() : ''
}

function stringListConfig(config: Record<string, unknown>, key: string): string[] {
  const value = config[key]
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : []
}

function recordConfig(config: Record<string, unknown>, key: string): Record<string, string> {
  const value = config[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const params: Record<string, string> = {}
  for (const [name, item] of Object.entries(value)) {
    if (typeof item === 'string' && item.trim().length > 0) params[name] = item.trim()
  }
  return params
}

function ensureHttpsEndpoint(raw: string, label: string): URL {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
    throw new Error(`${label} must be https`)
  }
  return url
}

function ensureAllowedTokenEndpoint(raw: string, hosts: string[]): URL {
  const url = ensureHttpsEndpoint(raw, 'provider token endpoint')
  if (hosts.length === 0) {
    throw new Error('provider has no allowed_token_hosts configured')
  }
  if (!hosts.some((host) => host.trim().toLowerCase() === url.hostname.toLowerCase())) {
    throw new Error('provider token endpoint host is not allowlisted')
  }
  return url
}

// Extract the IPv4 address embedded in a NAT64 well-known-prefix address
// (64:ff9b::/96, RFC 6052), or null when value is not such an address.
function nat64EmbeddedIpv4(value: string): string | null {
  const lower = value.toLowerCase()
  if (!lower.startsWith('64:ff9b::')) return null
  const tail = lower.slice('64:ff9b::'.length)
  if (tail === '') return null
  if (tail.includes('.')) {
    return isIP(tail) === 4 ? tail : null
  }
  const groups = tail.split(':')
  if (groups.length < 2) return null
  const hi = Number.parseInt(groups[groups.length - 2]!, 16)
  const lo = Number.parseInt(groups[groups.length - 1]!, 16)
  if (!Number.isInteger(hi) || !Number.isInteger(lo) || hi > 0xffff || lo > 0xffff) return null
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
}

function isUnsafeIpAddress(value: string): boolean {
  const nat64 = nat64EmbeddedIpv4(value)
  if (nat64) return isUnsafeIpAddress(nat64)
  const ip = value.startsWith('::ffff:') ? value.slice(7) : value
  const family = isIP(ip)
  if (family === 4) {
    const parts = ip.split('.').map(Number)
    return (
      parts[0] === 0 ||
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      parts[0] >= 224
    )
  }
  const lower = ip.toLowerCase()
  return (
    family === 6 &&
    (lower === '::' ||
      lower === '::1' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe80:') ||
      lower.startsWith('ff'))
  )
}

async function resolveSafeHost(host: string): Promise<{ address: string; family: 4 | 6 }[]> {
  const addresses = await lookup(host, { all: true, verbatim: false })
  if (addresses.length === 0) throw new Error('provider token endpoint resolves to no addresses')
  for (const address of addresses) {
    if (isUnsafeIpAddress(address.address)) throw new Error('provider token endpoint resolves to a non-routable address')
  }
  return addresses.filter((address): address is { address: string; family: 4 | 6 } => address.family === 4 || address.family === 6)
}

interface TokenRequestParts {
  headers: Record<string, string>
  body: URLSearchParams
}

function buildTokenRequest(form: URLSearchParams, clientId: string, clientSecret: string, method: string): TokenRequestParts {
  const body = new URLSearchParams(form)
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (method === 'client_secret_post') {
    body.set('client_id', clientId)
    body.set('client_secret', clientSecret)
  } else if (method === 'none') {
    body.set('client_id', clientId)
  } else {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
  }
  return { headers, body }
}

async function exchangeProviderToken(endpoint: URL, parts: TokenRequestParts): Promise<{ statusCode: number; body: string }> {
  await resolveSafeHost(endpoint.hostname)
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (err: Error | undefined, value?: { statusCode: number; body: string }) => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve(value ?? { statusCode: 0, body: '' })
    }
    const body = parts.body.toString()
    const req = httpsRequest(
      endpoint,
      {
        method: 'POST',
        headers: { ...parts.headers, 'Content-Length': Buffer.byteLength(body).toString() },
        timeout: PROVIDER_TOKEN_EXCHANGE_TIMEOUT_MS,
        lookup: async (host, _options, callback) => {
          try {
            const addresses = await resolveSafeHost(host)
            callback(null, addresses[0].address, addresses[0].family)
          } catch (err) {
            callback(err instanceof Error ? err : new Error(String(err)), '', 4)
          }
        },
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          text += chunk
          if (Buffer.byteLength(text) > PROVIDER_TOKEN_EXCHANGE_MAX_BODY_BYTES) {
            res.destroy(new Error('provider token response too large'))
          }
        })
        res.on('end', () => finish(undefined, { statusCode: res.statusCode ?? 0, body: text }))
        res.on('error', finish)
      },
    )
    req.on('timeout', () => req.destroy(new Error('provider token exchange timed out')))
    req.on('error', finish)
    req.write(body)
    req.end()
  })
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)
}

function wantsHtml(req: FastifyRequest): boolean {
  const accept = String(req.headers.accept ?? '')
  return accept.includes('text/html') && !accept.includes('application/json')
}

function oauthCallbackPage(title: string, message: string, kind: 'success' | 'error'): string {
  const color = kind === 'success' ? '#0f766e' : '#b91c1c'
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;margin:3rem;line-height:1.5;color:#111827}.card{max-width:42rem;border:1px solid #e5e7eb;border-radius:12px;padding:2rem;box-shadow:0 1px 3px #0001}.status{color:${color};font-weight:700}</style></head><body><main class="card"><p class="status">${escapeHtml(title)}</p><h1>${escapeHtml(message)}</h1><p>You can close this browser tab and return to Caracal Console.</p></main></body></html>`
}

function sendOAuthCallback(
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  body: Record<string, unknown>,
  title: string,
  message: string,
  kind: 'success' | 'error',
) {
  if (wantsHtml(req)) {
    return reply
      .code(status)
      .type('text/html; charset=utf-8')
      .send(oauthCallbackPage(title, message, kind))
  }
  return reply.code(status).send(body)
}

export const grantsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/zones/:zoneId/grants', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const page = parseListPagination(req, reply)
    if (!page) return
    const parsed = GrantListQuery.safeParse(req.query ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' })
    const query = parsed.data
    const userId = query.user_id ?? query.subject_id
    const base = { conds: ['dg.zone_id = $1'], values: [params.zoneId] as unknown[] }
    if (query.application_id) {
      base.values.push(query.application_id)
      base.conds.push(`dg.application_id = $${base.values.length}`)
    }
    if (userId) {
      base.values.push(userId)
      base.conds.push(`dg.user_id = $${base.values.length}`)
    }
    if (query.resource_id) {
      base.values.push(query.resource_id)
      base.conds.push(`dg.resource_id = $${base.values.length}`)
    }
    if (query.provider_id) {
      base.values.push(query.provider_id)
      base.conds.push(`r.credential_provider_id = $${base.values.length}`)
    }
    if (query.status) {
      base.values.push(query.status)
      base.conds.push(`dg.status = $${base.values.length}`)
    }
    if (query.scopes) {
      base.values.push(query.scopes)
      base.conds.push(`dg.scopes @> $${base.values.length}::text[]`)
    }
    const keyset = appendKeysetCondition(base, page, 'dg.created_at', 'dg.id')
    const { rows } = await fastify.db.query(
      `SELECT dg.id, dg.zone_id, dg.application_id, dg.user_id, dg.resource_id,
              r.credential_provider_id AS provider_id,
              a.name AS application_name,
              r.name AS resource_name,
              p.name AS provider_name,
              p.provider_kind AS provider_kind,
              dg.scopes, dg.status, dg.created_at
       FROM delegated_grants dg
       LEFT JOIN applications a ON a.zone_id = dg.zone_id AND a.id = dg.application_id
       LEFT JOIN resources r ON r.zone_id = dg.zone_id AND r.id = dg.resource_id
       LEFT JOIN providers p ON p.zone_id = dg.zone_id AND p.id = r.credential_provider_id
       WHERE ${keyset.conds.join(' AND ')}
       ORDER BY dg.created_at DESC, dg.id DESC LIMIT ${keyset.limitPlaceholder}`,
      keyset.values,
    )
    setNextLink(req, reply, rows, page.limit)
    return rows
  })

  fastify.get('/zones/:zoneId/grants/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    const { rows } = await fastify.db.query(
      `SELECT id, zone_id, application_id, user_id, resource_id, scopes, status, created_at
       FROM delegated_grants WHERE id = $1 AND zone_id = $2`,
      [params.id, params.zoneId],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'grant_not_found' })
    return rows[0]
  })

  fastify.post('/zones/:zoneId/grants', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    if (!(await zoneExists(fastify.db, params.zoneId))) {
      return reply.code(404).send({ error: 'zone_not_found' })
    }
    const body = GrantBody.parse(req.body)
    const { rows: refs } = await fastify.db.query(
      `SELECT
         EXISTS (
           SELECT 1 FROM applications
           WHERE id = $2 AND zone_id = $1 AND archived_at IS NULL
             AND (expires_at IS NULL OR expires_at > now())
         ) AS application_exists,
         (SELECT scopes FROM resources WHERE id = $3 AND zone_id = $1 AND archived_at IS NULL) AS resource_scopes`,
      [params.zoneId, body.application_id, body.resource_id],
    )
    if (!refs[0]?.application_exists) {
      return reply.code(404).send({ error: 'application_not_found' })
    }
    if (!refs[0].resource_scopes) {
      return reply.code(404).send({ error: 'resource_not_found' })
    }
    if (!scopesAllowed(body.scopes, refs[0].resource_scopes)) {
      return reply.code(403).send({ error: 'grant_scopes_exceed_resource' })
    }
    const id = uuidv7()
    const { rows } = await fastify.db.query(
      `INSERT INTO delegated_grants (id, zone_id, application_id, user_id, resource_id, scopes, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'active')
       RETURNING id, zone_id, application_id, user_id, resource_id, scopes, status, created_at`,
      [id, params.zoneId, body.application_id, body.user_id, body.resource_id, body.scopes],
    )
    return reply.code(201).send(rows[0])
  })

  fastify.post('/zones/:zoneId/provider-grants', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    if (!(await zoneExists(fastify.db, params.zoneId))) {
      return reply.code(404).send({ error: 'zone_not_found' })
    }
    const parsed = ProviderGrantBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_provider_grant' })
    const body = parsed.data
    const { rows: refs } = await fastify.db.query<{
      provider_kind: string | null
      resource_scopes: string[] | null
      resource_provider_id: string | null
    }>(
      `SELECT
         (SELECT provider_kind FROM providers WHERE id = $2 AND zone_id = $1 AND archived_at IS NULL) AS provider_kind,
         (SELECT scopes FROM resources WHERE id = $3 AND zone_id = $1 AND archived_at IS NULL) AS resource_scopes,
         (SELECT credential_provider_id FROM resources WHERE id = $3 AND zone_id = $1 AND archived_at IS NULL) AS resource_provider_id`,
      [params.zoneId, body.provider_id, body.resource_id],
    )
    const refsRow = refs[0]
    if (!refsRow?.provider_kind) return reply.code(404).send({ error: 'provider_not_found' })
    if (refsRow.provider_kind !== 'oauth2_authorization_code') {
      return reply
        .code(400)
        .send({ error: 'provider_grant_unsupported', detail: 'only oauth2_authorization_code providers use delegated provider grants' })
    }
    if (!refsRow.resource_scopes) return reply.code(404).send({ error: 'resource_not_found' })
    if (refsRow.resource_provider_id !== body.provider_id) {
      return reply.code(400).send({ error: 'provider_resource_mismatch' })
    }
    if (!scopesAllowed(body.scopes, refsRow.resource_scopes)) {
      return reply.code(403).send({ error: 'grant_scopes_exceed_resource' })
    }
    const id = uuidv7()
    const accessTokenCt = sealText(body.access_token)
    const refreshTokenCt = body.refresh_token ? sealText(body.refresh_token) : null
    const { rows } = await fastify.db.query(
      `INSERT INTO provider_grants (id, zone_id, user_id, resource_id, provider_id, scopes,
                                   access_token_ct, refresh_token_ct, expires_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active')
       ON CONFLICT (zone_id, user_id, resource_id, provider_id) WHERE status = 'active'
       DO UPDATE SET scopes = EXCLUDED.scopes,
                     access_token_ct = EXCLUDED.access_token_ct,
                     refresh_token_ct = EXCLUDED.refresh_token_ct,
                     expires_at = EXCLUDED.expires_at,
                     refreshed_at = NULL,
                     refresh_token_version = provider_grants.refresh_token_version + 1,
                     updated_at = now()
       RETURNING id, zone_id, user_id, resource_id, provider_id, scopes, status, expires_at, created_at, updated_at`,
      [
        id,
        params.zoneId,
        body.user_id,
        body.resource_id,
        body.provider_id,
        body.scopes,
        accessTokenCt,
        refreshTokenCt,
        body.expires_at ?? null,
      ],
    )
    return reply.code(201).send(rows[0])
  })

  fastify.post('/zones/:zoneId/provider-grants/oauth/authorize', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    if (!(await zoneExists(fastify.db, params.zoneId))) {
      return reply.code(404).send({ error: 'zone_not_found' })
    }
    const parsed = ProviderGrantOAuthAuthorizeBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_provider_oauth_authorize' })
    const body = parsed.data
    const { rows } = await fastify.db.query<ProviderOAuthRow>(
      `SELECT
         p.id, p.provider_kind, p.config_json, p.secret_config_ct, p.secret_config_nonce,
         r.scopes AS resource_scopes, r.credential_provider_id AS resource_provider_id
       FROM providers p
       LEFT JOIN resources r ON r.zone_id = p.zone_id AND r.id = $3 AND r.archived_at IS NULL
       WHERE p.zone_id = $1 AND p.id = $2 AND p.archived_at IS NULL`,
      [params.zoneId, body.provider_id, body.resource_id],
    )
    const row = rows[0]
    if (!row) return reply.code(404).send({ error: 'provider_not_found' })
    if (row.provider_kind !== 'oauth2_authorization_code') {
      return reply
        .code(400)
        .send({ error: 'provider_grant_unsupported', detail: 'only oauth2_authorization_code providers use browser authorization' })
    }
    if (!row.resource_scopes) return reply.code(404).send({ error: 'resource_not_found' })
    if (row.resource_provider_id !== body.provider_id) {
      return reply.code(400).send({ error: 'provider_resource_mismatch' })
    }
    if (!scopesAllowed(body.scopes, row.resource_scopes)) {
      return reply.code(403).send({ error: 'grant_scopes_exceed_resource' })
    }

    const config = row.config_json
    const authorizationEndpoint = stringConfig(config, 'authorization_endpoint')
    const redirectUri = stringConfig(config, 'redirect_uri')
    const clientId = stringConfig(config, 'client_id')
    if (!authorizationEndpoint || !redirectUri || !clientId) {
      return reply.code(400).send({ error: 'invalid_provider_config' })
    }
    let authorizationUrl: URL
    try {
      authorizationUrl = ensureHttpsEndpoint(authorizationEndpoint, 'provider authorization endpoint')
    } catch (err) {
      return reply
        .code(400)
        .send({ error: 'provider_authorization_endpoint_invalid', detail: err instanceof Error ? err.message : String(err) })
    }
    const state = randomUrlToken()
    const codeVerifier = randomUrlToken()
    const stateBody = {
      zone_id: params.zoneId,
      user_id: body.user_id,
      resource_id: body.resource_id,
      provider_id: body.provider_id,
      scopes: body.scopes,
      code_verifier: codeVerifier,
    }
    await fastify.redis.set(`${OAUTH_STATE_KEY_PREFIX}${state}`, JSON.stringify(stateBody), 'EX', OAUTH_STATE_TTL_SECONDS)

    for (const [key, value] of Object.entries(recordConfig(config, 'authorization_params'))) {
      authorizationUrl.searchParams.set(key, value)
    }
    authorizationUrl.searchParams.set('response_type', 'code')
    authorizationUrl.searchParams.set('client_id', clientId)
    authorizationUrl.searchParams.set('redirect_uri', redirectUri)
    authorizationUrl.searchParams.set('state', state)
    const providerScopes = stringListConfig(config, 'scopes')
    if (providerScopes.length > 0) authorizationUrl.searchParams.set('scope', providerScopes.join(' '))
    authorizationUrl.searchParams.set('code_challenge', codeChallenge(codeVerifier))
    authorizationUrl.searchParams.set('code_challenge_method', 'S256')

    const expiresAt = new Date((await redisTimeMs(fastify.redis)) + OAUTH_STATE_TTL_SECONDS * 1000).toISOString()
    return {
      authorization_url: authorizationUrl.toString(),
      state,
      expires_at: expiresAt,
    }
  })

  fastify.post('/zones/:zoneId/provider-grants/revoke', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const parsed = ProviderGrantRevokeBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_provider_grant_revoke' })
    const body = parsed.data
    const { rows } = await fastify.db.query<Record<string, unknown>>(
      `UPDATE provider_grants
       SET status = 'revoked', updated_at = now()
       WHERE zone_id = $1
         AND user_id = $2
         AND resource_id = $3
         AND provider_id = $4
         AND status = 'active'
       RETURNING id, zone_id, user_id, resource_id, provider_id, scopes, status, expires_at, created_at, updated_at`,
      [params.zoneId, body.user_id, body.resource_id, body.provider_id],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'provider_grant_not_found' })
    return rows[0]
  })

  fastify.get('/zones/:zoneId/provider-grants/oauth/callback', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const parsed = OAuthCallbackQuery.safeParse(req.query)
    if (!parsed.success)
      return sendOAuthCallback(
        req,
        reply,
        400,
        { error: 'invalid_oauth_callback' },
        'OAuth callback failed',
        'The provider callback was missing required OAuth state.',
        'error',
      )
    const query = parsed.data
    const stateKey = `${OAUTH_STATE_KEY_PREFIX}${query.state}`
    const rawState = await fastify.redis.call('GETDEL', stateKey)
    if (typeof rawState !== 'string' || !rawState)
      return sendOAuthCallback(
        req,
        reply,
        400,
        { error: 'oauth_state_expired' },
        'OAuth callback expired',
        'The authorization request expired. Start the provider connection again from Caracal Console.',
        'error',
      )
    let state: z.infer<typeof OAuthStateBody>
    try {
      state = OAuthStateBody.parse(JSON.parse(rawState))
    } catch {
      return sendOAuthCallback(
        req,
        reply,
        400,
        { error: 'oauth_state_invalid' },
        'OAuth callback failed',
        'The authorization request state could not be verified.',
        'error',
      )
    }
    if (state.zone_id !== params.zoneId)
      return sendOAuthCallback(
        req,
        reply,
        400,
        { error: 'oauth_state_mismatch' },
        'OAuth callback failed',
        'The provider returned to a different Caracal zone than the original request.',
        'error',
      )
    if (query.error) {
      return sendOAuthCallback(
        req,
        reply,
        400,
        { error: 'provider_oauth_denied', detail: query.error_description ?? query.error },
        'OAuth authorization denied',
        query.error_description ?? query.error,
        'error',
      )
    }
    if (!query.code)
      return sendOAuthCallback(
        req,
        reply,
        400,
        { error: 'authorization_code_required' },
        'OAuth callback failed',
        'The provider did not return an authorization code.',
        'error',
      )

    const { rows } = await fastify.db.query<ProviderOAuthRow>(
      `SELECT
         p.id, p.provider_kind, p.config_json, p.secret_config_ct, p.secret_config_nonce,
         r.scopes AS resource_scopes, r.credential_provider_id AS resource_provider_id
       FROM providers p
       LEFT JOIN resources r ON r.zone_id = p.zone_id AND r.id = $3 AND r.archived_at IS NULL
       WHERE p.zone_id = $1 AND p.id = $2 AND p.archived_at IS NULL`,
      [state.zone_id, state.provider_id, state.resource_id],
    )
    const row = rows[0]
    if (!row)
      return sendOAuthCallback(
        req,
        reply,
        404,
        { error: 'provider_not_found' },
        'OAuth callback failed',
        'The OAuth provider no longer exists in Caracal.',
        'error',
      )
    if (row.provider_kind !== 'oauth2_authorization_code')
      return sendOAuthCallback(
        req,
        reply,
        400,
        { error: 'provider_grant_unsupported' },
        'OAuth callback failed',
        'The selected provider does not support browser authorization.',
        'error',
      )
    if (!row.resource_scopes)
      return sendOAuthCallback(
        req,
        reply,
        404,
        { error: 'resource_not_found' },
        'OAuth callback failed',
        'The resource no longer exists in Caracal.',
        'error',
      )
    if (row.resource_provider_id !== state.provider_id)
      return sendOAuthCallback(
        req,
        reply,
        400,
        { error: 'provider_resource_mismatch' },
        'OAuth callback failed',
        'The resource is no longer bound to this OAuth provider.',
        'error',
      )
    if (!scopesAllowed(state.scopes, row.resource_scopes))
      return sendOAuthCallback(
        req,
        reply,
        403,
        { error: 'grant_scopes_exceed_resource' },
        'OAuth callback failed',
        'The requested Caracal scopes are no longer valid for this resource.',
        'error',
      )

    const config = row.config_json
    const secretConfig = openProviderSecretConfig(row)
    const clientId = stringConfig(config, 'client_id')
    const clientAuthMethod = stringConfig(config, 'client_auth_method') || 'client_secret_basic'
    const clientSecret = secretConfig.client_secret ?? ''
    if (!clientId || (clientAuthMethod !== 'none' && !clientSecret)) {
      return sendOAuthCallback(
        req,
        reply,
        400,
        { error: 'invalid_provider_config' },
        'OAuth callback failed',
        'The OAuth provider client configuration is incomplete.',
        'error',
      )
    }
    let tokenEndpoint: URL
    try {
      tokenEndpoint = ensureAllowedTokenEndpoint(stringConfig(config, 'token_endpoint'), stringListConfig(config, 'allowed_token_hosts'))
    } catch (err) {
      return sendOAuthCallback(
        req,
        reply,
        400,
        { error: 'provider_token_endpoint_not_allowed', detail: err instanceof Error ? err.message : String(err) },
        'OAuth callback failed',
        'The provider token endpoint is not allowed by this provider configuration.',
        'error',
      )
    }

    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: query.code,
      redirect_uri: stringConfig(config, 'redirect_uri'),
      code_verifier: state.code_verifier,
    })
    for (const [key, value] of Object.entries(recordConfig(config, 'token_params'))) {
      form.set(key, value)
    }
    let tokenResponse: { statusCode: number; body: string }
    try {
      tokenResponse = await exchangeProviderToken(tokenEndpoint, buildTokenRequest(form, clientId, clientSecret, clientAuthMethod))
    } catch (err) {
      req.log.warn({ err, providerId: state.provider_id }, 'provider OAuth token exchange failed')
      return sendOAuthCallback(
        req,
        reply,
        502,
        { error: 'provider_token_exchange_failed' },
        'OAuth callback failed',
        'Caracal could not exchange the authorization code with the provider.',
        'error',
      )
    }
    if (tokenResponse.statusCode !== 200) {
      req.log.warn({ statusCode: tokenResponse.statusCode, providerId: state.provider_id }, 'provider OAuth token exchange failed')
      return sendOAuthCallback(
        req,
        reply,
        502,
        { error: 'provider_token_exchange_failed' },
        'OAuth callback failed',
        'The provider rejected the authorization-code exchange.',
        'error',
      )
    }
    let tokenJson: Record<string, unknown>
    try {
      tokenJson = JSON.parse(tokenResponse.body) as Record<string, unknown>
    } catch {
      return sendOAuthCallback(
        req,
        reply,
        502,
        { error: 'provider_token_response_invalid' },
        'OAuth callback failed',
        'The provider token response was not valid JSON.',
        'error',
      )
    }
    const accessToken = typeof tokenJson.access_token === 'string' ? tokenJson.access_token : ''
    const refreshToken = typeof tokenJson.refresh_token === 'string' ? tokenJson.refresh_token : ''
    const expiresIn = typeof tokenJson.expires_in === 'number' && Number.isFinite(tokenJson.expires_in) ? tokenJson.expires_in : 0
    if (!accessToken)
      return sendOAuthCallback(
        req,
        reply,
        502,
        { error: 'provider_token_response_invalid' },
        'OAuth callback failed',
        'The provider token response did not include an access token.',
        'error',
      )

    const grantId = uuidv7()
    const accessTokenCt = sealText(accessToken)
    const refreshTokenCt = refreshToken ? sealText(refreshToken) : null
    const { rows: grantRows } = await fastify.db.query<Record<string, unknown>>(
      `INSERT INTO provider_grants (id, zone_id, user_id, resource_id, provider_id, scopes,
                                    access_token_ct, refresh_token_ct, expires_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               CASE WHEN $9::int > 0 THEN now() + ($9::int * interval '1 second') ELSE NULL END,
               'active')
       ON CONFLICT (zone_id, user_id, resource_id, provider_id) WHERE status = 'active'
       DO UPDATE SET scopes = EXCLUDED.scopes,
                     access_token_ct = EXCLUDED.access_token_ct,
                     refresh_token_ct = EXCLUDED.refresh_token_ct,
                     expires_at = EXCLUDED.expires_at,
                     refreshed_at = NULL,
                     refresh_token_version = provider_grants.refresh_token_version + 1,
                     updated_at = now()
       RETURNING id, zone_id, user_id, resource_id, provider_id, scopes, status, expires_at, created_at, updated_at`,
      [grantId, state.zone_id, state.user_id, state.resource_id, state.provider_id, state.scopes, accessTokenCt, refreshTokenCt, expiresIn],
    )
    return sendOAuthCallback(
      req,
      reply,
      201,
      grantRows[0] ?? {},
      'OAuth provider connected',
      'Caracal stored the delegated provider grant for this user and resource.',
      'success',
    )
  })

  fastify.delete('/zones/:zoneId/grants/:id', async (req, reply) => {
    const params = parseParams(ZoneIdParams, req, reply)
    if (!params) return
    return withTransaction(fastify.db, async (client) => {
      const { rows } = await client.query<{ user_id: string }>(
        `UPDATE delegated_grants SET status = 'revoked'
         WHERE id = $1 AND zone_id = $2
         RETURNING user_id`,
        [params.id, params.zoneId],
      )
      if (!rows[0]) throw new TxAbort(reply.code(404).send({ error: 'grant_not_found' }))

      // Page session revocation so a grant covering many active sessions cannot
      // hold a long-running UPDATE lock or flood the outbox in a single batch.
      while (true) {
        const { rows: sessions } = await client.query<{ id: string }>(
          `UPDATE sessions SET status = 'revoked'
           WHERE id IN (
             SELECT id FROM sessions
             WHERE zone_id = $1 AND status = 'active' AND subject_id = $2
             ORDER BY created_at
             LIMIT $3
             FOR UPDATE SKIP LOCKED
           )
           RETURNING id`,
          [params.zoneId, rows[0].user_id, SESSION_REVOKE_BATCH],
        )
        for (const s of sessions) {
          await enqueueOutbox(client, {
            streamName: STREAM_SESSIONS_REVOKE,
            payload: { zone_id: params.zoneId, session_id: s.id, reason: 'grant_revoked', grant_id: params.id },
            requestId: req.id,
          })
        }
        if (sessions.length < SESSION_REVOKE_BATCH) break
      }

      return reply.code(204).send()
    })
  })
}
