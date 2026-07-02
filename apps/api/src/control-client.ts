// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Internal control-plane client that mints a scoped, single-use Caracal token and invokes a control command through the governed /v1/control/invoke path.

const STS_TOKEN_PATH = '/oauth/2/token'
const CONTROL_INVOKE_PATH = '/v1/control/invoke'

type FetchImpl = typeof fetch

// The reserved control identity the caller acts as. The client secret is a sealed
// credential held only for the lifetime of a request and never logged; it leaves this
// module only in the token-exchange request body to the STS.
export interface ControlClientConfig {
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
  // minted in the identity's home zone; this rides as a header the in-process control handler
  // honors only for the reserved Operator reader and only for non-mutating commands, so the
  // Operator can read a tenant zone's live state without provisioning any identity in that zone.
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

// A control-plane client bound to one reserved identity. Each invoke mints a fresh token
// scoped to exactly the scopes that call requires, so an action carries the least
// authority that satisfies it and a leaked token grants nothing beyond that one
// operation. The deterministic engine decides what to invoke and with which scopes; this
// client only carries it to the governed control surface.
export interface ControlClient {
  invoke(command: string, subcommand: string, flags: Record<string, unknown>, scopes: readonly string[]): Promise<unknown>
}

export function createControlClient(config: ControlClientConfig, fetchImpl: FetchImpl = fetch): ControlClient {
  const stsUrl = config.stsUrl.replace(/\/+$/, '')
  const controlUrl = config.controlUrl.replace(/\/+$/, '')

  // Exchanges the reserved identity's client credentials for a Caracal control token
  // scoped to exactly the requested scopes. The STS narrows the token to the intersection
  // of the identity's allowed scopes and those requested, so an over-broad request can
  // never widen authority beyond what the identity was granted.
  async function mintToken(scopes: readonly string[]): Promise<string> {
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      application_id: config.applicationId,
      client_secret: config.clientSecret,
      resource: config.audience,
      scope: scopes.join(' '),
    })
    if (config.ttlSeconds !== undefined) form.set('ttl_seconds', String(config.ttlSeconds))
    const res = await fetchImpl(`${stsUrl}${STS_TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
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

  return {
    async invoke(command, subcommand, flags, scopes) {
      const token = await mintToken(scopes)
      const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${token}` }
      if (config.zoneScope) headers['x-caracal-zone-scope'] = config.zoneScope
      const invokeBody: Record<string, unknown> = { command, subcommand, flags }
      if (config.authorizedBy) invokeBody.authorized_by = config.authorizedBy
      if (config.coAuthorOperator) invokeBody.co_author_operator = true
      const res = await fetchImpl(`${controlUrl}${CONTROL_INVOKE_PATH}`, {
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
    },
  }
}
