// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Private STS client for workload launch bindings and runtime credentials.

import { ApprovalRequiredError } from '@caracalai/oauth'

export interface RunBinding {
  env: string
  resource: string
  scopes: string[]
  optional: boolean
  onFailure: 'warn' | 'error'
}

interface RunManifestResponse {
  zoneId: string
  workloadId: string
  bindings: RunBinding[]
}

export interface RunCredentialResponse {
  env: string
  credential: string
  expiresAt?: number
}

interface RunRequestOptions {
  timeoutMs?: number
  fetchImpl?: typeof fetch
  launchId?: string
}

interface RunErrorResponse {
  error?: string
  error_description?: string
  challenge_id?: string
  state?: string
  tier?: string
  binding?: string
  challenge_expires_at?: string
  requestId?: string
}

async function postRunForm(stsUrl: string, path: string, body: URLSearchParams, opts: RunRequestOptions): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000)
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (opts.launchId) headers['X-Caracal-Launch-Id'] = opts.launchId
  try {
    return await (opts.fetchImpl ?? fetch)(`${stsUrl}${path}`, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
}

async function readRunError(res: Response): Promise<RunErrorResponse> {
  try {
    return (await res.json()) as RunErrorResponse
  } catch {
    return {}
  }
}

export async function fetchRunManifest(
  stsUrl: string,
  workloadId: string,
  secret: string,
  opts: RunRequestOptions = {},
): Promise<RunManifestResponse> {
  const res = await postRunForm(stsUrl, '/v1/run/manifest', new URLSearchParams({ workload_id: workloadId, secret }), opts)
  if (!res.ok) {
    const err = await readRunError(res)
    throw new Error(err.error_description ?? `STS error ${res.status}`)
  }
  return validateManifest(await res.json())
}

export async function fetchRunCredential(
  stsUrl: string,
  workloadId: string,
  secret: string,
  env: string,
  opts: RunRequestOptions & { approvalId?: string } = {},
): Promise<RunCredentialResponse> {
  const body = new URLSearchParams({ workload_id: workloadId, secret, env })
  if (opts.approvalId) body.set('challenge_id', opts.approvalId)
  const res = await postRunForm(stsUrl, '/v1/run/credential', body, opts)
  if (!res.ok) {
    const err = await readRunError(res)
    if (err.error === 'interaction_required') {
      throw new ApprovalRequiredError(err.error_description ?? 'Approval required', err.challenge_id ?? '', {
        state: err.state,
        tier: err.tier,
        binding: err.binding,
        expiresAt: err.challenge_expires_at,
        requestId: err.requestId,
        httpStatus: res.status,
      })
    }
    throw new Error(err.error_description ?? `STS error ${res.status}`)
  }
  return validateCredentialResponse(await res.json())
}

function validateManifest(data: unknown): RunManifestResponse {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('run manifest invalid: expected an object')
  }
  const body = data as Record<string, unknown>
  if (typeof body.zone_id !== 'string' || body.zone_id === '') {
    throw new Error('run manifest invalid: zone_id is required')
  }
  if (typeof body.workload_id !== 'string' || body.workload_id === '') {
    throw new Error('run manifest invalid: workload_id is required')
  }
  if (!Array.isArray(body.bindings) || body.bindings.length === 0) {
    throw new Error('run manifest invalid: bindings are required')
  }
  return {
    zoneId: body.zone_id,
    workloadId: body.workload_id,
    bindings: body.bindings.map(validateBinding),
  }
}

function validateBinding(value: unknown): RunBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('run manifest invalid: binding must be an object')
  }
  const item = value as Record<string, unknown>
  if (typeof item.env !== 'string' || item.env === '') {
    throw new Error('run manifest invalid: binding env is required')
  }
  if (typeof item.resource !== 'string' || item.resource === '') {
    throw new Error('run manifest invalid: binding resource is required')
  }
  const scopes = item.scopes ?? []
  if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== 'string' || scope === '')) {
    throw new Error(`run manifest invalid: scopes for ${item.env} must be non-empty strings`)
  }
  const onFailure = item.on_failure ?? 'error'
  if (onFailure !== 'warn' && onFailure !== 'error') {
    throw new Error(`run manifest invalid: unknown on_failure for ${item.env}`)
  }
  return {
    env: item.env,
    resource: item.resource,
    scopes: scopes as string[],
    optional: item.optional === true,
    onFailure,
  }
}

function validateCredentialResponse(data: unknown): RunCredentialResponse {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('run credential invalid: expected an object')
  }
  const body = data as Record<string, unknown>
  if (typeof body.env !== 'string' || body.env === '') {
    throw new Error('run credential invalid: env is required')
  }
  if (typeof body.credential !== 'string' || body.credential === '') {
    throw new Error('run credential invalid: credential is required')
  }
  const response: RunCredentialResponse = { env: body.env, credential: body.credential }
  if (body.expires_at !== undefined) {
    if (typeof body.expires_at !== 'number' || !Number.isInteger(body.expires_at)) {
      throw new Error('run credential invalid: expires_at must be an integer')
    }
    response.expiresAt = body.expires_at
  }
  return response
}
