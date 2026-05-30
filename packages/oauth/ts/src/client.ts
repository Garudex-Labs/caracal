// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// RFC 8693 token exchange client with pluggable token cache and 401-retry.

import { createHmac, randomBytes } from 'node:crypto'
import { InMemoryTokenCache, type TokenCache } from './cache.js'
import { InteractionRequiredError } from './types.js'
import type { ExchangeOptions, TokenExchangeResponse } from './types.js'

interface STSErrorResponse {
  error?: string
  error_description?: string
  challenge_id?: string
  acr_values?: string
  requestId?: string
}

interface STSSuccessResponse {
  access_token?: unknown
  token_type?: unknown
  expires_in?: unknown
  target_resources?: unknown
  upstreams?: unknown
}

const SECRET_CACHE_KEY = randomBytes(32)

function parseSTSErrorResponse(body: string): STSErrorResponse {
  if (body === '') return {}
  return JSON.parse(body) as STSErrorResponse
}

function formatSTSError(status: number, err: STSErrorResponse): string {
  const base = err.error_description ?? `STS error ${status}`
  return err.requestId ? `${base} (request_id=${err.requestId})` : base
}

async function readSTSErrorResponse(res: Response): Promise<STSErrorResponse> {
  if (typeof res.text === 'function') {
    return parseSTSErrorResponse(await res.text())
  }
  if (typeof res.json === 'function') {
    return await res.json() as STSErrorResponse
  }
  return {}
}

export class OAuthClient {
  private readonly cache: TokenCache
  private readonly inflight = new Map<string, Promise<TokenExchangeResponse>>()
  private readonly identityKey: string

  constructor(
    private readonly stsUrl: string,
    private readonly zoneId: string,
    private readonly applicationId: string,
    cache?: TokenCache,
  ) {
    this.cache = cache ?? new InMemoryTokenCache()
    this.identityKey = `${zoneId}::${applicationId}`
  }

  async exchange(
    subjectToken: string,
    resource: string | string[],
    opts: ExchangeOptions = {},
  ): Promise<TokenExchangeResponse> {
    const timeoutMs = opts.timeoutMs ?? 30_000
    const preflightWindow = timeoutMs / 1000 + 30

    const cacheSubject = this.cacheSubject(subjectToken, opts)
    const cacheResource = this.cacheResource(resource, opts)
    const cached = this.cache.get(cacheSubject, cacheResource)
    if (cached) {
      const remaining = cached.issuedAt + cached.expiresIn - Date.now() / 1000
      if (remaining > preflightWindow) return cached
    }

    const inflightKey = `${cacheSubject}::${cacheResource}`
    const existing = this.inflight.get(inflightKey)
    if (existing) return existing

    const pending = (async () => {
      try {
        const token = await this.doExchange(subjectToken, resource, opts, false)
        this.cache.set(cacheSubject, cacheResource, token)
        return token
      } finally {
        this.inflight.delete(inflightKey)
      }
    })()
    this.inflight.set(inflightKey, pending)
    return pending
  }

  private cacheSubject(subjectToken: string, opts: ExchangeOptions): string {
    return [
      this.identityKey,
      secretCacheId(subjectToken),
      secretCacheId(opts.actorToken),
      opts.sessionId ?? '',
      opts.agentSessionId ?? '',
      opts.delegationEdgeId ?? '',
      this.authContext(opts),
      secretCacheId(opts.clientAssertion),
    ].join('::')
  }

  private cacheResource(resource: string | string[], opts: ExchangeOptions): string {
    return [
      resourceList(resource).join(' '),
      this.normalizedScopes(opts.scopes),
      opts.ttlSeconds?.toString() ?? '',
      opts.runtimeCredentialInjection === true ? 'runtime-credential-injection' : '',
    ].join('::')
  }

  private normalizedScopes(scopes?: string[]): string {
    return [...new Set(scopes ?? [])].sort().join(' ')
  }

  private authContext(opts: ExchangeOptions): string {
    return [
      opts.clientSecret ? `secret:${secretCacheId(opts.clientSecret)}` : '',
      opts.clientAssertion ? 'assertion' : '',
      opts.clientAssertionType ?? '',
    ].join(':')
  }

  private async doExchange(
    subjectToken: string,
    resource: string | string[],
    opts: ExchangeOptions,
    isRetry: boolean,
    deadlineMs = Date.now() + (opts.timeoutMs ?? 30_000),
  ): Promise<TokenExchangeResponse> {
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      zone_id: this.zoneId,
      application_id: this.applicationId,
    })
    if (subjectToken) {
      body.set('subject_token', subjectToken)
      body.set('subject_token_type', 'urn:ietf:params:oauth:token-type:access_token')
    }
    for (const value of resourceList(resource)) body.append('resource', value)
    if (opts.clientSecret) body.set('client_secret', opts.clientSecret)
    if (opts.clientAssertion) body.set('client_assertion', opts.clientAssertion)
    if (opts.clientAssertionType) body.set('client_assertion_type', opts.clientAssertionType)
    if (opts.actorToken) body.set('actor_token', opts.actorToken)
    if (opts.sessionId) body.set('session_id', opts.sessionId)
    if (opts.agentSessionId) body.set('agent_session_id', opts.agentSessionId)
    if (opts.delegationEdgeId) body.set('delegation_edge_id', opts.delegationEdgeId)
    const scope = this.normalizedScopes(opts.scopes)
    if (scope) body.set('scope', scope)
    if (opts.ttlSeconds) body.set('ttl_seconds', String(opts.ttlSeconds))
    if (opts.runtimeCredentialInjection === true) body.set('runtime_credential_injection', 'true')

    const maxRetries = opts.retries ?? 3
    let res: Awaited<ReturnType<typeof fetch>> | undefined
    let lastErr: unknown
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const remainingMs = deadlineMs - Date.now()
      if (remainingMs <= 0) throw new Error('STS request timed out')
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), remainingMs)
      try {
        res = await fetch(`${this.stsUrl}/oauth/2/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
          signal: controller.signal,
        })
      } catch (err) {
        lastErr = err
        if (attempt === maxRetries) throw err
      } finally {
        clearTimeout(timeout)
      }
      if (!res) {
        await delayWithinDeadline(jitteredBackoff(attempt), deadlineMs)
        continue
      }
      const status = res.status
      const transient = status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600)
      if (!transient || attempt === maxRetries) break
      await delayWithinDeadline(retryDelayMs(res, attempt), deadlineMs)
    }
    if (!res) {
      if (lastErr instanceof Error) throw lastErr
      throw new Error('STS request failed: no response')
    }

    if (!res.ok) {
      let err: STSErrorResponse
      try {
        err = await readSTSErrorResponse(res)
      } catch {
        throw new Error(`STS error ${res.status}: invalid error response`)
      }
      if (err['error'] === 'interaction_required') {
        throw new InteractionRequiredError(
          err['error_description'] ?? 'Step-up required',
          err['challenge_id'] ?? '',
          resourceList(resource)[0],
          err['acr_values'],
        )
      }
      if (res.status === 401 && !isRetry) {
        return this.doExchange(subjectToken, resource, { ...opts, retries: 0 }, true, deadlineMs)
      }
      throw new Error(formatSTSError(res.status, err))
    }

    if (!isJsonResponse(res)) {
      throw new Error('STS response invalid: expected application/json')
    }
    const data = (await res.json()) as STSSuccessResponse
    return validateSuccessResponse(data)
  }
}

function validateSuccessResponse(data: STSSuccessResponse): TokenExchangeResponse {
  if (typeof data.access_token !== 'string' || data.access_token === '') {
    throw new Error('STS response invalid: access_token is required')
  }
  if (data.token_type !== undefined && data.token_type !== 'Bearer') {
    throw new Error('STS response invalid: token_type must be Bearer')
  }
  const expiresIn = data.expires_in
  if (typeof expiresIn !== 'number' || !Number.isInteger(expiresIn) || expiresIn <= 0) {
    throw new Error('STS response invalid: expires_in must be a positive integer')
  }
  const response: TokenExchangeResponse = {
    accessToken: data.access_token,
    tokenType: 'Bearer',
    expiresIn,
    issuedAt: Math.floor(Date.now() / 1000),
  }
  if (data.target_resources !== undefined) {
    if (!Array.isArray(data.target_resources) || data.target_resources.some((item) => typeof item !== 'string')) {
      throw new Error('STS response invalid: target_resources must be a string array')
    }
    response.targetResources = data.target_resources
  }
  if (data.upstreams !== undefined) response.upstreams = validateUpstreams(data.upstreams)
  return response
}

function validateUpstreams(value: unknown): NonNullable<TokenExchangeResponse['upstreams']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('STS response invalid: upstreams must be an object')
  }
  const upstreams: NonNullable<TokenExchangeResponse['upstreams']> = {}
  for (const [resource, directive] of Object.entries(value)) {
    if (!directive || typeof directive !== 'object' || Array.isArray(directive)) {
      throw new Error('STS response invalid: upstream directive must be an object')
    }
    const item = directive as Record<string, unknown>
    upstreams[resource] = {
      url: optionalString(item.url, 'upstreams.url'),
      authMode: optionalString(item.auth_mode, 'upstreams.auth_mode'),
      authLocation: optionalString(item.auth_location, 'upstreams.auth_location'),
      authHeader: optionalString(item.auth_header, 'upstreams.auth_header'),
      queryParamName: optionalString(item.query_param_name, 'upstreams.query_param_name'),
      authScheme: optionalString(item.auth_scheme, 'upstreams.auth_scheme'),
      allowedTokenHosts: optionalStringArray(item.allowed_token_hosts, 'upstreams.allowed_token_hosts'),
      providerToken: optionalString(item.provider_token, 'upstreams.provider_token'),
      providerId: optionalString(item.provider_id, 'upstreams.provider_id'),
      grantId: optionalString(item.grant_id, 'upstreams.grant_id'),
      forwardCaracalIdentity: optionalBoolean(item.forward_caracal_identity, 'upstreams.forward_caracal_identity'),
      expiresAt: optionalInteger(item.expires_at, 'upstreams.expires_at'),
    }
  }
  return upstreams
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`STS response invalid: ${name} must be a string`)
  return value
}

function optionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`STS response invalid: ${name} must be a string array`)
  }
  return value
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`STS response invalid: ${name} must be a boolean`)
  return value
}

function optionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`STS response invalid: ${name} must be an integer`)
  return value
}

function retryDelayMs(res: Response, attempt: number): number {
  const retryAfter = res.headers?.get('retry-after')
  if (retryAfter) {
    const secs = Number(retryAfter)
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
    const date = Date.parse(retryAfter)
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  }
  return jitteredBackoff(attempt)
}

function jitteredBackoff(attempt: number): number {
  const base = Math.min(2 ** attempt * 250, 5_000)
  return base / 2 + Math.random() * (base / 2)
}

async function delayWithinDeadline(waitMs: number, deadlineMs: number): Promise<void> {
  const remainingMs = deadlineMs - Date.now()
  if (remainingMs <= 0) throw new Error('STS request timed out')
  await new Promise(resolve => setTimeout(resolve, Math.min(waitMs, remainingMs)))
}

function isJsonResponse(res: Response): boolean {
  const contentType = res.headers?.get('content-type')
  if (contentType === null || contentType === undefined) return true
  const mediaType = contentType.toLowerCase().split(';', 1)[0]
  return mediaType === 'application/json' || mediaType.endsWith('+json')
}

function secretCacheId(value: string | undefined): string {
  if (!value) return ''
  return createHmac('sha256', SECRET_CACHE_KEY).update(value).digest('hex')
}

function resourceList(resource: string | string[]): string[] {
  return (Array.isArray(resource) ? resource : [resource]).map(value => value.trim()).filter(Boolean)
}
