// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Control API client that mints a scoped, single-use Caracal token per call and invokes a control command through the governed /v1/control/invoke path.

const STS_TOKEN_PATH = '/oauth/2/token'
const CONTROL_INVOKE_PATH = '/v1/control/invoke'

// The control identity the caller acts as. The client secret is a sealed credential held
// only for the lifetime of a request and never logged; it leaves this module only in the
// token-exchange request body to the STS.
export interface ControlClientOptions {
  stsUrl: string
  controlUrl: string
  audience: string
  applicationId: string
  clientSecret: string
  // The lifetime to request for each minted token. Tokens are single-use (replay
  // protected) so this only bounds the window between mint and invoke; a short value
  // keeps the blast radius of a leaked token minimal.
  ttlSeconds?: number
  // The zone a read invoke targets when it is not the identity's own zone. The token is still
  // minted in the identity's home zone; this rides as a header the control handler honors
  // only for a reserved reader identity and only for non-mutating commands, so such a reader
  // can inspect a tenant zone's live state without provisioning any identity in that zone.
  // Absent for an identity acting in its own zone, which is the common path.
  zoneScope?: string
  // An optional attribution string the acting identity asserts for the human or upstream
  // authority on whose behalf it invokes. It rides in the invoke body and is recorded verbatim
  // in the control.invoke audit metadata as a subject-asserted annotation; it is never an
  // authorization input, so the action stays bounded entirely by the token's own scopes and zone.
  authorizedBy?: string
  // Marks the invoke as originating from the Caracal Operator, so an object it creates is stamped
  // with operator co-authorship. Set only by the Operator's own governed execution path, never by
  // direct control-plane automation.
  coAuthorOperator?: boolean
  // The originating request id, forwarded as x-request-id on both the token exchange and the
  // control invoke so the STS log, the control dispatch, and its audit record all correlate
  // back to the request that triggered them.
  requestId?: string
  fetchImpl?: typeof fetch
}

// A control invoke failed. stage distinguishes a token-exchange failure from a control
// dispatch failure; reason is already free of the client secret, so it is safe to
// surface or log. code and remediation are the structured control-plane fields when the
// failure came from dispatch.
export class ControlClientError extends Error {
  constructor(
    public readonly stage: 'token' | 'invoke',
    public readonly status: number,
    public readonly reason: string,
    public readonly code?: string,
    public readonly remediation?: string,
  ) {
    super(`control ${stage} failed (${status}): ${reason}`)
    this.name = 'ControlClientError'
  }
}

interface ControlErrorBody {
  error?: { code?: string; reason?: string; remediation?: string } | string
}

function describeError(body: unknown, fallback: string): { reason: string; code?: string; remediation?: string } {
  const envelope = (body as ControlErrorBody | null)?.error
  if (envelope && typeof envelope === 'object') {
    return { reason: envelope.reason ?? fallback, code: envelope.code, remediation: envelope.remediation }
  }
  return { reason: typeof envelope === 'string' ? envelope : fallback }
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text()
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

// A control-plane client bound to one identity. Each invoke mints a fresh token scoped to
// exactly the scopes that call requires, so an action carries the least authority that
// satisfies it and a leaked token grants nothing beyond that one operation. The caller
// decides what to invoke and with which scopes; this client only carries it to the
// governed control surface.
export class ControlClient {
  private readonly stsUrl: string
  private readonly controlUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: ControlClientOptions) {
    this.stsUrl = options.stsUrl.replace(/\/+$/, '')
    this.controlUrl = options.controlUrl.replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  // Exchanges the identity's client credentials for a Caracal control token scoped to
  // exactly the requested scopes. The STS narrows the token to the intersection of the
  // identity's allowed scopes and those requested, so an over-broad request can never
  // widen authority beyond what the identity was granted.
  private async mintToken(scopes: readonly string[]): Promise<string> {
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      application_id: this.options.applicationId,
      client_secret: this.options.clientSecret,
      resource: this.options.audience,
      scope: scopes.join(' '),
    })
    if (this.options.ttlSeconds !== undefined) form.set('ttl_seconds', String(this.options.ttlSeconds))
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
    if (this.options.requestId) headers['x-request-id'] = this.options.requestId
    const res = await this.fetchImpl(`${this.stsUrl}${STS_TOKEN_PATH}`, {
      method: 'POST',
      headers,
      body: form.toString(),
    })
    const body = await readJson(res)
    if (!res.ok) {
      const { reason, code, remediation } = describeError(body, 'token exchange rejected')
      throw new ControlClientError('token', res.status, reason, code, remediation)
    }
    const token = (body as { access_token?: unknown } | undefined)?.access_token
    if (typeof token !== 'string' || token.length === 0) {
      throw new ControlClientError('token', res.status, 'token exchange returned no access_token')
    }
    return token
  }

  async invoke(command: string, subcommand: string, flags: Record<string, unknown>, scopes: readonly string[]): Promise<unknown> {
    const token = await this.mintToken(scopes)
    const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${token}` }
    if (this.options.zoneScope) headers['x-caracal-zone-scope'] = this.options.zoneScope
    if (this.options.requestId) headers['x-request-id'] = this.options.requestId
    const invokeBody: Record<string, unknown> = { command, subcommand, flags }
    if (this.options.authorizedBy) invokeBody.authorized_by = this.options.authorizedBy
    if (this.options.coAuthorOperator) invokeBody.co_author_operator = true
    const res = await this.fetchImpl(`${this.controlUrl}${CONTROL_INVOKE_PATH}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(invokeBody),
    })
    const body = await readJson(res)
    if (!res.ok) {
      const { reason, code, remediation } = describeError(body, 'control invoke rejected')
      throw new ControlClientError('invoke', res.status, reason, code, remediation)
    }
    return (body as { result?: unknown } | undefined)?.result
  }
}
