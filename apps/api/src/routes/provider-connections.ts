// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Provider-connection routes: stored upstream accounts, the OAuth browser flow, and RFC 7009 revocation.

import type { FastifyBaseLogger, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { createHash, randomBytes } from 'node:crypto'
import {
  AAD_CONNECTION_ACCESS_TOKEN,
  AAD_CONNECTION_REFRESH_TOKEN,
  SecretBackendError,
  openSecretEnvelope,
  sealSecretEnvelope,
} from '@caracalai/server-core'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { redisTimeMs } from '../redis.js'
import { ZoneParams, parseParams } from './params.js'
import { zoneExists } from '../zone-guard.js'
import { appendKeysetCondition, listPage, parseListPagination } from './list-pagination.js'
import {
  buildTokenRequest,
  ensureAllowedTokenEndpoint,
  ensureHttpsEndpoint,
  exchangeProviderToken,
  readProviderSecrets,
  recordConfig,
  stringConfig,
  stringListConfig,
} from '../provider-token.js'

// Reserved subject id for a zone-shared provider connection. When an operator connects
// an upstream account without naming a subject, the connection is stored under this
// sentinel and the STS falls back to it for any authorized caller, so the common case
// needs no per-caller subject. Federated per-subject connections still match exactly
// and take precedence. Kept in sync with SharedConnectionSubject in the STS.
const SHARED_CONNECTION_SUBJECT = 'caracal:shared'

const ProviderConnectionBody = z.object({
  subject_id: z.string().min(1).default(SHARED_CONNECTION_SUBJECT),
  provider_id: z.string().min(1),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_at: z.string().datetime().optional(),
})

const ProviderConnectionListQuery = z.object({
  provider_id: z.string().min(1).optional(),
  subject_id: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
})

const ProviderConnectionAuthorizeBody = z.object({
  subject_id: z.string().min(1).default(SHARED_CONNECTION_SUBJECT),
  provider_id: z.string().min(1),
})

const ProviderConnectionRevokeBody = z.object({
  subject_id: z.string().min(1).default(SHARED_CONNECTION_SUBJECT),
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
  subject_id: z.string().min(1),
  provider_id: z.string().min(1),
  code_verifier: z.string().min(43).max(128),
})

const OAUTH_STATE_TTL_SECONDS = 10 * 60
const OAUTH_STATE_KEY_PREFIX = 'api:provider_oauth_state:'

interface ProviderOAuthRow {
  id: string
  provider_kind: string
  config_json: Record<string, unknown>
}

function sealToken(value: string, aad: string): Buffer {
  return sealSecretEnvelope(Buffer.from(value, 'utf8'), aad)
}

function openToken(envelope: Buffer, aad: string): string {
  const plaintext = openSecretEnvelope(envelope, aad)
  try {
    return plaintext.toString('utf8')
  } finally {
    plaintext.fill(0)
  }
}

type UpstreamRevocation = 'revoked' | 'unsupported' | 'failed'

// RFC 7009 upstream revocation, purely best-effort: local revocation has already
// succeeded when this runs. The refresh token is presented first because refresh-token
// revocation cascades to the derived access tokens at compliant providers; the access
// token is revoked separately when no refresh token exists. A provider without an
// advertised revocation endpoint reports 'unsupported' so the console can explain
// that the upstream token lives on until it naturally expires.
async function revokeUpstreamTokens(
  row: {
    access_token_ct: Buffer | null
    refresh_token_ct: Buffer | null
    config_json: Record<string, unknown>
  },
  secrets: Record<string, string>,
  log: FastifyBaseLogger,
): Promise<UpstreamRevocation> {
  const config = row.config_json
  const endpointRaw = stringConfig(config, 'revocation_endpoint')
  if (!endpointRaw) return 'unsupported'
  try {
    const endpoint = ensureHttpsEndpoint(endpointRaw, 'provider revocation endpoint')
    const clientId = stringConfig(config, 'client_id')
    const method = stringConfig(config, 'client_auth_method') || 'client_secret_basic'
    const tokens: { value: string; hint: string }[] = []
    if (row.refresh_token_ct) tokens.push({ value: openToken(row.refresh_token_ct, AAD_CONNECTION_REFRESH_TOKEN), hint: 'refresh_token' })
    else if (row.access_token_ct) tokens.push({ value: openToken(row.access_token_ct, AAD_CONNECTION_ACCESS_TOKEN), hint: 'access_token' })
    if (tokens.length === 0) return 'failed'
    for (const token of tokens) {
      const form = new URLSearchParams({ token: token.value, token_type_hint: token.hint })
      const response = await exchangeProviderToken(endpoint, buildTokenRequest(form, clientId, secrets.client_secret ?? '', method))
      // RFC 7009 section 2.2: 200 covers both revoked and already-invalid tokens;
      // anything else means the upstream kept the token alive.
      if (response.statusCode !== 200) {
        log.warn({ statusCode: response.statusCode }, 'upstream token revocation was not accepted')
        return 'failed'
      }
    }
    return 'revoked'
  } catch (err) {
    log.warn({ err }, 'upstream token revocation failed')
    return 'failed'
  }
}

function randomUrlToken(): string {
  return randomBytes(32).toString('base64url')
}

function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;margin:3rem;line-height:1.5;color:#111827}.card{max-width:42rem;border:1px solid #e5e7eb;border-radius:12px;padding:2rem;box-shadow:0 1px 3px #0001}.status{color:${color};font-weight:700}</style></head><body><main class="card"><p class="status">${escapeHtml(title)}</p><h1>${escapeHtml(message)}</h1><p>You can close this browser tab and return to the Caracal web console.</p></main></body></html>`
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

export const providerConnectionsRoutes: FastifyPluginAsync = async (fastify) => {
  // Lists stored provider connections (authenticated upstream accounts and their
  // brokered tokens). This is the read surface behind the provider Connections panel:
  // status and expiry reflect the upstream tokens, not Caracal authorization grants.
  fastify.get('/zones/:zoneId/provider-connections', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const page = parseListPagination(req, reply)
    if (!page) return
    const parsed = ProviderConnectionListQuery.safeParse(req.query ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' })
    const query = parsed.data
    const base = { conds: ['pc.zone_id = $1'], values: [params.zoneId] as unknown[] }
    if (query.provider_id) {
      base.values.push(query.provider_id)
      base.conds.push(`pc.provider_id = $${base.values.length}`)
    }
    if (query.subject_id) {
      base.values.push(query.subject_id)
      base.conds.push(`pc.subject_id = $${base.values.length}`)
    }
    if (query.status) {
      base.values.push(query.status)
      base.conds.push(`pc.status = $${base.values.length}`)
    }
    const keyset = appendKeysetCondition(base, page, 'pc.created_at', 'pc.id')
    const { rows } = await fastify.db.query(
      `SELECT pc.id, pc.zone_id, pc.subject_id, pc.provider_id,
              pc.status, pc.expires_at, pc.refreshed_at,
              (pc.refresh_token_ct IS NOT NULL) AS renewable,
              pc.created_at, pc.updated_at
       FROM provider_connections pc
       WHERE ${keyset.conds.join(' AND ')}
       ORDER BY pc.created_at DESC, pc.id DESC LIMIT ${keyset.limitPlaceholder}`,
      keyset.values,
    )
    return listPage(rows, page.limit)
  })

  fastify.post('/zones/:zoneId/provider-connections', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    if (!(await zoneExists(fastify.db, params.zoneId))) {
      return reply.code(404).send({ error: 'zone_not_found' })
    }
    const parsed = ProviderConnectionBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_provider_connection' })
    const body = parsed.data
    const { rows: refs } = await fastify.db.query<{ provider_kind: string | null }>(
      `SELECT provider_kind FROM providers WHERE id = $2 AND zone_id = $1 AND archived_at IS NULL`,
      [params.zoneId, body.provider_id],
    )
    if (!refs[0]?.provider_kind) return reply.code(404).send({ error: 'provider_not_found' })
    if (refs[0].provider_kind !== 'oauth2_authorization_code') {
      return reply.code(400).send({
        error: 'provider_connection_unsupported',
        error_description: 'only oauth2_authorization_code providers use delegated provider connections',
      })
    }
    const id = uuidv7()
    const accessTokenCt = sealToken(body.access_token, AAD_CONNECTION_ACCESS_TOKEN)
    const refreshTokenCt = body.refresh_token ? sealToken(body.refresh_token, AAD_CONNECTION_REFRESH_TOKEN) : null
    const { rows } = await fastify.db.query(
      `INSERT INTO provider_connections (id, zone_id, subject_id, provider_id,
                                         access_token_ct, refresh_token_ct, expires_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
       ON CONFLICT (zone_id, subject_id, provider_id) WHERE status = 'active'
       DO UPDATE SET access_token_ct = EXCLUDED.access_token_ct,
                     refresh_token_ct = EXCLUDED.refresh_token_ct,
                     expires_at = EXCLUDED.expires_at,
                     refreshed_at = NULL,
                     refresh_token_version = provider_connections.refresh_token_version + 1,
                     updated_at = now()
       RETURNING id, zone_id, subject_id, provider_id, status, expires_at, created_at, updated_at`,
      [id, params.zoneId, body.subject_id, body.provider_id, accessTokenCt, refreshTokenCt, body.expires_at ?? null],
    )
    return reply.code(201).send(rows[0])
  })

  fastify.post('/zones/:zoneId/provider-connections/oauth/authorize', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    if (!(await zoneExists(fastify.db, params.zoneId))) {
      return reply.code(404).send({ error: 'zone_not_found' })
    }
    const parsed = ProviderConnectionAuthorizeBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_provider_oauth_authorize' })
    const body = parsed.data
    const { rows } = await fastify.db.query<ProviderOAuthRow>(
      `SELECT id, provider_kind, config_json
       FROM providers
       WHERE zone_id = $1 AND id = $2 AND archived_at IS NULL`,
      [params.zoneId, body.provider_id],
    )
    const row = rows[0]
    if (!row) return reply.code(404).send({ error: 'provider_not_found' })
    if (row.provider_kind !== 'oauth2_authorization_code') {
      return reply.code(400).send({
        error: 'provider_connection_unsupported',
        error_description: 'only oauth2_authorization_code providers use browser authorization',
      })
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
        .send({ error: 'provider_authorization_endpoint_invalid', error_description: err instanceof Error ? err.message : String(err) })
    }
    const state = randomUrlToken()
    const codeVerifier = randomUrlToken()
    const stateBody = {
      zone_id: params.zoneId,
      subject_id: body.subject_id,
      provider_id: body.provider_id,
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

  // Revokes a connection locally and then attempts RFC 7009 revocation upstream when
  // the provider advertises a revocation endpoint. Local revocation always wins: the
  // upstream call is best-effort and its outcome is reported, never a failure of the
  // revoke itself.
  fastify.post('/zones/:zoneId/provider-connections/revoke', async (req, reply) => {
    const params = parseParams(ZoneParams, req, reply)
    if (!params) return
    const parsed = ProviderConnectionRevokeBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_provider_connection_revoke' })
    const body = parsed.data
    const { rows: tokenRows } = await fastify.db.query<{
      access_token_ct: Buffer | null
      refresh_token_ct: Buffer | null
      config_json: Record<string, unknown>
    }>(
      `SELECT pc.access_token_ct, pc.refresh_token_ct, p.config_json
       FROM provider_connections pc
       JOIN providers p ON p.zone_id = pc.zone_id AND p.id = pc.provider_id
       WHERE pc.zone_id = $1 AND pc.subject_id = $2 AND pc.provider_id = $3 AND pc.status = 'active'`,
      [params.zoneId, body.subject_id, body.provider_id],
    )
    const { rows } = await fastify.db.query<Record<string, unknown>>(
      `UPDATE provider_connections
       SET status = 'revoked', updated_at = now()
       WHERE zone_id = $1
         AND subject_id = $2
         AND provider_id = $3
         AND status = 'active'
       RETURNING id, zone_id, subject_id, provider_id, status, expires_at, created_at, updated_at`,
      [params.zoneId, body.subject_id, body.provider_id],
    )
    if (!rows[0]) return reply.code(404).send({ error: 'provider_connection_not_found' })
    let upstream: UpstreamRevocation = 'failed'
    if (tokenRows[0]) {
      try {
        const secrets = await readProviderSecrets(fastify.secrets, params.zoneId, body.provider_id)
        upstream = await revokeUpstreamTokens(tokenRows[0], secrets, req.log)
      } catch (err) {
        req.log.warn({ err }, 'provider secrets unavailable for upstream revocation')
      }
    }
    return { ...rows[0], upstream_revocation: upstream }
  })

  fastify.get('/zones/:zoneId/provider-connections/oauth/callback', async (req, reply) => {
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
        'The authorization request expired. Start the provider connection again from the Caracal web console.',
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
        { error: 'provider_oauth_denied', error_description: query.error_description ?? query.error },
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
      `SELECT id, provider_kind, config_json
       FROM providers
       WHERE zone_id = $1 AND id = $2 AND archived_at IS NULL`,
      [state.zone_id, state.provider_id],
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
        { error: 'provider_connection_unsupported' },
        'OAuth callback failed',
        'The selected provider does not support browser authorization.',
        'error',
      )

    const config = row.config_json
    let secretConfig: Record<string, string>
    try {
      secretConfig = await readProviderSecrets(fastify.secrets, state.zone_id, state.provider_id)
    } catch (err) {
      if (!(err instanceof SecretBackendError)) throw err
      req.log.error({ err }, 'secret backend unavailable during OAuth callback')
      return sendOAuthCallback(
        req,
        reply,
        502,
        { error: 'secret_backend_unavailable' },
        'OAuth callback failed',
        'Caracal could not reach its secret backend to load the provider client credentials.',
        'error',
      )
    }
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
        { error: 'provider_token_endpoint_not_allowed', error_description: err instanceof Error ? err.message : String(err) },
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
    const tokenType = typeof tokenJson.token_type === 'string' ? tokenJson.token_type.trim() : ''
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
    // RFC 6749 section 7.1: a token of an unrecognized type must not be forwarded
    // under the Bearer scheme. An explicit upstream auth scheme on the provider is
    // the operator's assertion that the type is intentional.
    if (tokenType && tokenType.toLowerCase() !== 'bearer' && !stringConfig(config, 'auth_scheme')) {
      req.log.warn({ tokenType, providerId: state.provider_id }, 'provider returned unsupported token_type')
      return sendOAuthCallback(
        req,
        reply,
        502,
        { error: 'provider_token_type_unsupported', error_description: `token_type ${tokenType} is not bearer` },
        'OAuth callback failed',
        `The provider issued a "${tokenType}" token, which Caracal cannot forward as a bearer credential.`,
        'error',
      )
    }

    const connectionId = uuidv7()
    const accessTokenCt = sealToken(accessToken, AAD_CONNECTION_ACCESS_TOKEN)
    const refreshTokenCt = refreshToken ? sealToken(refreshToken, AAD_CONNECTION_REFRESH_TOKEN) : null
    const { rows: connectionRows } = await fastify.db.query<Record<string, unknown>>(
      `INSERT INTO provider_connections (id, zone_id, subject_id, provider_id,
                                         access_token_ct, refresh_token_ct, expires_at, status)
       VALUES ($1, $2, $3, $4, $5, $6,
               CASE WHEN $7::int > 0 THEN now() + ($7::int * interval '1 second') ELSE NULL END,
               'active')
       ON CONFLICT (zone_id, subject_id, provider_id) WHERE status = 'active'
       DO UPDATE SET access_token_ct = EXCLUDED.access_token_ct,
                     refresh_token_ct = EXCLUDED.refresh_token_ct,
                     expires_at = EXCLUDED.expires_at,
                     refreshed_at = NULL,
                     refresh_token_version = provider_connections.refresh_token_version + 1,
                     updated_at = now()
       RETURNING id, zone_id, subject_id, provider_id, status, expires_at, created_at, updated_at`,
      [connectionId, state.zone_id, state.subject_id, state.provider_id, accessTokenCt, refreshTokenCt, expiresIn],
    )
    return sendOAuthCallback(
      req,
      reply,
      201,
      connectionRows[0] ?? {},
      'OAuth provider connected',
      'Caracal stored the provider connection for this subject. Every resource routed through this provider can now use it.',
      'success',
    )
  })
}
