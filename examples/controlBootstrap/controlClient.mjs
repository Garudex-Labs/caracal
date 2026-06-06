// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Reusable Control API client: exchanges a scoped control key for a short-lived STS token and invokes management commands.

const CONTROL_INVOKE_PATH = '/v1/control/invoke'
const STS_TOKEN_PATH = '/oauth/2/token'

const STATUS_REASON = {
  400: 'invalid request',
  401: 'authentication or token replay rejected',
  403: 'denied by scope or policy',
  429: 'rate limited',
  501: 'unsupported command',
  502: 'upstream error',
  503: 'control gate disabled',
}

export class ControlError extends Error {
  constructor(status, body, context) {
    super(`${context}: ${status} ${STATUS_REASON[status] ?? 'request failed'}`)
    this.name = 'ControlError'
    this.status = status
    this.body = body
  }
}

function requireField(config, key) {
  const value = config[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`control client config field "${key}" is required`)
  }
  return value.trim()
}

function trimTrailingSlash(url) {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

export function createControlClient(config, deps = {}) {
  const stsUrl = trimTrailingSlash(requireField(config, 'stsUrl'))
  const controlUrl = trimTrailingSlash(requireField(config, 'controlUrl'))
  const audience = requireField(config, 'audience')
  const clientId = requireField(config, 'clientId')
  const clientSecret = requireField(config, 'clientSecret')
  const scopes = normalizeScopes(config.scopes)
  if (scopes.length === 0) throw new Error('control client config field "scopes" must list at least one control scope')
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const ttlSeconds = Number.isInteger(config.ttlSeconds) ? config.ttlSeconds : undefined

  let cached
  const skewMs = 5_000

  async function token() {
    const now = Date.now()
    if (cached && cached.expiresAt - skewMs > now) return cached.accessToken
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      application_id: clientId,
      client_secret: clientSecret,
      resource: audience,
      scope: scopes.join(' '),
    })
    if (ttlSeconds !== undefined) form.set('ttl_seconds', String(ttlSeconds))
    const res = await fetchImpl(`${stsUrl}${STS_TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })
    const body = await readBody(res)
    if (!res.ok) throw new ControlError(res.status, body, 'token exchange')
    const accessToken = body?.access_token
    if (typeof accessToken !== 'string' || accessToken === '') {
      throw new ControlError(res.status, body, 'token exchange returned no access_token')
    }
    const lifetime = Number.isFinite(body?.expires_in) ? Number(body.expires_in) : 60
    cached = { accessToken, expiresAt: now + lifetime * 1000 }
    return accessToken
  }

  async function invoke(command, subcommand, flags = {}) {
    const accessToken = await token()
    const res = await fetchImpl(`${controlUrl}${CONTROL_INVOKE_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ command, subcommand, flags }),
    })
    const body = await readBody(res)
    if (!res.ok) throw new ControlError(res.status, body, `invoke ${command} ${subcommand}`)
    return body?.result
  }

  return { invoke, token, scopes }
}

function normalizeScopes(value) {
  if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
  return []
}

async function readBody(res) {
  const text = await res.text()
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}
