// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// RFC 8693 token exchange client with pluggable token cache and 401-retry.

import { InMemoryTokenCache, type TokenCache } from './cache.js'
import { InteractionRequiredError } from './types.js'
import type { ExchangeOptions, TokenExchangeResponse } from './types.js'

interface STSErrorResponse {
  error?: string
  error_description?: string
  challenge_id?: string
  acr_values?: string
}

function parseSTSErrorResponse(body: string): STSErrorResponse {
  if (body === '') return {}
  return JSON.parse(body) as STSErrorResponse
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
    resource: string,
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
      subjectToken,
      opts.actorToken ?? '',
      opts.sessionId ?? '',
      opts.agentSessionId ?? '',
      opts.delegationEdgeId ?? '',
      opts.clientAssertion ?? '',
    ].join('::')
  }

  private cacheResource(resource: string, opts: ExchangeOptions): string {
    return [resource, this.normalizedScopes(opts.scopes), opts.ttlSeconds?.toString() ?? ''].join('::')
  }

  private normalizedScopes(scopes?: string[]): string {
    return [...new Set(scopes ?? [])].sort().join(' ')
  }

  private async doExchange(
    subjectToken: string,
    resource: string,
    opts: ExchangeOptions,
    isRetry: boolean,
  ): Promise<TokenExchangeResponse> {
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: subjectToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      resource,
      zone_id: this.zoneId,
      application_id: this.applicationId,
    })
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

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000)
    const maxRetries = opts.retries ?? 3
    let res: Awaited<ReturnType<typeof fetch>> | undefined
    try {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        res = await fetch(`${this.stsUrl}/oauth/2/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
          signal: controller.signal,
        })
        const status = res.status
        const transient = status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600)
        if (!transient || attempt === maxRetries) break
        const retryAfter = res.headers?.get('retry-after')
        let waitMs: number
        if (retryAfter) {
          const secs = Number(retryAfter)
          if (Number.isFinite(secs)) waitMs = Math.max(0, secs * 1000)
          else {
            const date = Date.parse(retryAfter)
            waitMs = Number.isNaN(date) ? 250 * 2 ** attempt : Math.max(0, date - Date.now())
          }
        } else {
          const base = Math.min(2 ** attempt * 250, 5_000)
          waitMs = base / 2 + Math.random() * (base / 2)
        }
        await new Promise(r => setTimeout(r, waitMs))
      }
    } finally {
      clearTimeout(timeout)
    }
    if (!res) throw new Error('STS request failed: no response')

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
          resource,
          err['acr_values'],
        )
      }
      if (res.status === 401 && !isRetry) {
        return this.doExchange(subjectToken, resource, opts, true)
      }
      throw new Error(err['error_description'] ?? `STS error ${res.status}`)
    }

    if (!isJsonResponse(res)) {
      throw new Error('STS response invalid: expected application/json')
    }
    const data = (await res.json()) as {
      access_token: string
      expires_in: number
    }
    return {
      accessToken: data['access_token'],
      tokenType: 'Bearer',
      expiresIn: data['expires_in'],
      issuedAt: Math.floor(Date.now() / 1000),
    }
  }
}

function isJsonResponse(res: Response): boolean {
  const contentType = res.headers?.get('content-type')
  if (contentType === null || contentType === undefined) return true
  const mediaType = contentType.toLowerCase().split(';', 1)[0]
  return mediaType === 'application/json' || mediaType.endsWith('+json')
}
