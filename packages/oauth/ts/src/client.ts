// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// RFC 8693 token exchange client with pluggable token caching.

import { createHmac, randomBytes } from 'node:crypto'
import { InMemoryTokenCache, type TokenCache } from './cache.js'
import { CaracalError, ApprovalRequiredError, APPROVAL_STATES } from './types.js'
import type { ApprovalState, ExchangeOptions, OAuthEvent, TokenExchangeResponse } from './types.js'

interface STSErrorResponse {
  error?: string
  error_description?: string
  challenge_id?: string
  state?: string
  tier?: string
  binding?: string
  challenge_expires_at?: string
  requestId?: string
}

interface STSSuccessResponse {
  access_token?: unknown
  token_type?: unknown
  expires_in?: unknown
  target_resources?: unknown
}

const SECRET_CACHE_KEY = randomBytes(32)

function parseSTSErrorResponse(body: string): STSErrorResponse {
  if (body === '') return {}
  const parsed: unknown = JSON.parse(body)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid error response')
  return parsed as STSErrorResponse
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
    return (await res.json()) as STSErrorResponse
  }
  return {}
}

export class OAuthClient {
  private readonly cache: TokenCache
  private readonly inflight = new Map<string, Promise<TokenExchangeResponse>>()
  private readonly identityKey: string
  /** Observability sink; each completed exchange and approval wait reports here. Failures inside the sink never reach the caller. */
  onEvent?: (event: OAuthEvent) => void

  constructor(
    private readonly stsUrl: string,
    private readonly zoneId: string,
    private readonly applicationId: string,
    cache?: TokenCache,
    private readonly fetchImpl?: typeof fetch,
  ) {
    this.cache = cache ?? new InMemoryTokenCache()
    this.identityKey = `${zoneId}::${applicationId}`
  }

  private emit(event: OAuthEvent): void {
    if (!this.onEvent) return
    try {
      this.onEvent(event)
    } catch {
      // The observability sink must never break the token path.
    }
  }

  /** Drops every cached token derived by this client. In-flight exchanges are not canceled. */
  invalidate(): void {
    this.cache.clear()
  }

  async exchange(subjectToken: string, resource: string | string[], opts: ExchangeOptions = {}): Promise<TokenExchangeResponse> {
    const timeoutMs = opts.timeoutMs ?? 30_000
    const preflightWindow = timeoutMs / 1000 + 30
    const oneShot = opts.cache === false || Boolean(opts.challengeId)

    const resources = resourceList(resource)
    const scopes = [...new Set(opts.scopes ?? [])].sort()
    const cacheSubject = this.cacheSubject(subjectToken, opts)
    const cacheResource = this.cacheResource(resource, opts)
    if (!oneShot && !opts.forceRefresh) {
      const cached = this.cache.get(cacheSubject, cacheResource)
      if (cached) {
        // Cap the preflight window at half the token lifetime so short-lived
        // tokens are still served from cache instead of re-minted every call.
        const window = Math.min(preflightWindow, cached.expiresIn / 2)
        const remaining = cached.issuedAt + cached.expiresIn - Date.now() / 1000
        if (remaining > window) {
          this.emit({ type: 'token.exchange', resources, scopes, cached: true, ok: true, durationMs: 0 })
          return cached
        }
      }
    }

    const inflightKey = `${cacheSubject}::${cacheResource}`
    if (oneShot) {
      const start = performance.now()
      try {
        const token = await this.doExchange(subjectToken, resource, opts)
        this.emit({ type: 'token.exchange', resources, scopes, cached: false, ok: true, durationMs: performance.now() - start })
        return token
      } catch (err) {
        this.emit({
          type: 'token.exchange',
          resources,
          scopes,
          cached: false,
          ok: false,
          durationMs: performance.now() - start,
          ...(err instanceof CaracalError ? { code: err.code, status: err.httpStatus } : {}),
        })
        throw err
      }
    }
    const existing = this.inflight.get(inflightKey)
    if (existing) return waitForShared(existing, opts.signal)

    const start = performance.now()
    const pending = (async () => {
      try {
        const token = await this.doExchange(subjectToken, resource, opts)
        this.cache.set(cacheSubject, cacheResource, token)
        this.emit({ type: 'token.exchange', resources, scopes, cached: false, ok: true, durationMs: performance.now() - start })
        return token
      } catch (err) {
        this.emit({
          type: 'token.exchange',
          resources,
          scopes,
          cached: false,
          ok: false,
          durationMs: performance.now() - start,
          ...(err instanceof CaracalError ? { code: err.code, status: err.httpStatus } : {}),
        })
        throw err
      } finally {
        this.inflight.delete(inflightKey)
      }
    })()
    this.inflight.set(inflightKey, pending)
    return waitForShared(pending, opts.signal)
  }

  private cacheSubject(subjectToken: string, opts: ExchangeOptions): string {
    return [
      this.identityKey,
      secretCacheId(subjectToken),
      opts.authorityRecordId ?? '',
      opts.sessionId ?? '',
      opts.delegationId ?? '',
      this.authContext(opts),
    ].join('::')
  }

  private cacheResource(resource: string | string[], opts: ExchangeOptions): string {
    return [resourceList(resource).join(' '), this.normalizedScopes(opts.scopes), opts.ttlSeconds?.toString() ?? ''].join('::')
  }

  private normalizedScopes(scopes?: string[]): string {
    return [...new Set(scopes ?? [])].sort().join(' ')
  }

  private authContext(opts: ExchangeOptions): string {
    return opts.clientSecret ? `secret:${secretCacheId(opts.clientSecret)}` : ''
  }

  private async doExchange(
    subjectToken: string,
    resource: string | string[],
    opts: ExchangeOptions,
    deadlineMs = performance.now() + (opts.timeoutMs ?? 30_000),
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
    if (opts.authorityRecordId) body.set('session_id', opts.authorityRecordId)
    if (opts.sessionId) body.set('agent_session_id', opts.sessionId)
    if (opts.delegationId) body.set('delegation_edge_id', opts.delegationId)
    const scope = this.normalizedScopes(opts.scopes)
    if (scope) body.set('scope', scope)
    if (opts.ttlSeconds) body.set('ttl_seconds', String(opts.ttlSeconds))
    if (opts.challengeId) body.set('challenge_id', opts.challengeId)

    if (opts.signal?.aborted) throw abortReason(opts.signal)
    const remainingMs = deadlineMs - performance.now()
    if (remainingMs <= 0) throw new Error('STS request timed out')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), remainingMs)
    let res: Awaited<ReturnType<typeof fetch>>
    try {
      res = await (this.fetchImpl ?? fetch)(`${this.stsUrl}/oauth/2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }

    if (!res.ok) {
      let err: STSErrorResponse
      try {
        err = await readSTSErrorResponse(res)
      } catch {
        throw new Error(`STS error ${res.status}: invalid error response`)
      }
      if (err['error'] === 'interaction_required') {
        throw new ApprovalRequiredError(err['error_description'] ?? 'Approval required', err['challenge_id'] ?? '', {
          resource: resourceList(resource)[0],
          state: err['state'],
          tier: err['tier'],
          binding: err['binding'],
          expiresAt: err['challenge_expires_at'],
          requestId: err['requestId'],
          httpStatus: res.status,
        })
      }
      throw new CaracalError(err.error || 'error', formatSTSError(res.status, err), {
        requestId: err.requestId,
        httpStatus: res.status,
      })
    }

    if (!isJsonResponse(res)) {
      throw new Error('STS response invalid: expected application/json')
    }
    const data = (await res.json()) as STSSuccessResponse
    return validateSuccessResponse(data)
  }

  /**
   * Long-polls an approval until an approver decides it, it expires, or
   * the timeout elapses. Returns the final lifecycle state: 'approved' means a
   * retry of exchange() with challengeId will mint; 'rejected' and 'expired' are
   * terminal; 'pending' means the timeout elapsed and waiting again is safe.
   * Pass `signal` to abort the wait early.
   */
  async waitForApproval(approvalId: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ApprovalState> {
    if (!approvalId) throw new Error('waitForApproval requires an approvalId')
    const start = performance.now()
    try {
      const state = await pollStepUpState(this.stsUrl, approvalId, { ...opts, fetchImpl: this.fetchImpl })
      this.emit({ type: 'approval.wait', approvalId, state, ok: true, durationMs: performance.now() - start })
      return state
    } catch (err) {
      this.emit({ type: 'approval.wait', approvalId, state: '', ok: false, durationMs: performance.now() - start })
      throw err
    }
  }

  /**
   * Exchanges an end user's identity token from a zone-trusted external issuer
   * for a Caracal Subject authority record. The application authenticates itself
   * with its client secret and relays the token verbatim; the minted record is
   * the subject's identity anchor and carries no resource authority. Never
   * cached: each federation is an explicit identity event.
   */
  async federateSubject(
    idToken: string,
    opts: { clientSecret?: string; ttlSeconds?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<TokenExchangeResponse> {
    if (!idToken) throw new Error('federateSubject requires the end user identity token')
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      zone_id: this.zoneId,
      application_id: this.applicationId,
      subject_token: idToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
    })
    if (opts.clientSecret) body.set('client_secret', opts.clientSecret)
    if (opts.ttlSeconds) body.set('ttl_seconds', String(opts.ttlSeconds))
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000)
    try {
      const res = await (this.fetchImpl ?? fetch)(`${this.stsUrl}/oauth/2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal,
      })
      if (!res.ok) {
        let err: STSErrorResponse
        try {
          err = await readSTSErrorResponse(res)
        } catch {
          throw new Error(`STS error ${res.status}: invalid error response`)
        }
        throw new CaracalError(err.error ?? 'federation_failed', formatSTSError(res.status, err), { httpStatus: res.status })
      }
      return validateSuccessResponse((await res.json()) as STSSuccessResponse)
    } finally {
      clearTimeout(timeout)
    }
  }

  /**
   * Posts an end user's decision on a subject-reserved approval hold. The
   * subject token is the user's federated session mandate, and the binding must
   * echo the hold exactly - a prompt that does not know the held resource and
   * scope set cannot decide it.
   */
  async decideApproval(input: {
    subjectToken: string
    approvalId: string
    binding: string
    decision: 'approved' | 'rejected'
    reason?: string
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<void> {
    if (!input.subjectToken || !input.approvalId || !input.binding) {
      throw new Error('decideApproval requires subjectToken, approvalId, and binding')
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 30_000)
    try {
      const res = await (this.fetchImpl ?? fetch)(`${this.stsUrl}/step-up/${encodeURIComponent(input.approvalId)}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.subjectToken}` },
        body: JSON.stringify({ decision: input.decision, binding: input.binding, ...(input.reason ? { reason: input.reason } : {}) }),
        signal: input.signal ? AbortSignal.any([controller.signal, input.signal]) : controller.signal,
      })
      if (!res.ok) {
        let err: STSErrorResponse
        try {
          err = await readSTSErrorResponse(res)
        } catch {
          throw new Error(`approval decision failed: ${res.status}`)
        }
        throw new CaracalError(err.error ?? 'decision_failed', formatSTSError(res.status, err), { httpStatus: res.status })
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}

async function waitForShared<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending
  if (signal.aborted) throw signal.reason
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/**
 * Long-polls an approval's lifecycle state against STS without any client
 * context: only the approval id and the STS URL are required, so run launches and
 * exchange clients share one polling path.
 */
export async function pollStepUpState(
  stsUrl: string,
  approvalId: string,
  opts: { timeoutMs?: number; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<ApprovalState> {
  const deadline = performance.now() + (opts.timeoutMs ?? 300_000)
  for (;;) {
    if (opts.signal?.aborted) throw abortReason(opts.signal)
    const remainingMs = deadline - performance.now()
    if (remainingMs <= 0) return 'pending'
    const wait = Math.max(1, Math.min(25, Math.floor(remainingMs / 1000)))
    const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(remainingMs, (wait + 10) * 1000))))
    const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout
    const res = await (opts.fetchImpl ?? fetch)(`${stsUrl}/step-up/${encodeURIComponent(approvalId)}?wait=${wait}`, { signal })
    if (!res.ok) throw new Error(`step-up status failed: ${res.status}`)
    const data = (await res.json()) as { state?: unknown }
    if (typeof data.state === 'string' && data.state !== 'pending') return approvalState(data.state)
  }
}

function approvalState(value: string): ApprovalState {
  if (!APPROVAL_STATES.includes(value as ApprovalState)) {
    throw new Error(`step-up status returned an unknown challenge state: ${value}`)
  }
  return value as ApprovalState
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('aborted')
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
  return response
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
  return [...new Set((Array.isArray(resource) ? resource : [resource]).map((value) => value.trim()).filter(Boolean))].sort()
}
