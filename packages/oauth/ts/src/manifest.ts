// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Run manifest client: fetches a workload's console-authored launch bindings from STS.

export interface RunManifestCredential {
  env: string
  resource: string
  credentialType: 'provider_token' | 'caracal_mandate'
  optional: boolean
  onFailure: 'warn' | 'error'
}

export interface RunManifestResponse {
  zoneId: string
  applicationId: string
  ttlSeconds?: number
  continueOnFailure?: boolean
  credentials: RunManifestCredential[]
}

export interface RunManifestOptions {
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

// Authenticates the application against STS and returns its run manifest. STS reports
// every credential failure identically, so callers only see whether the pair is valid
// and whether a manifest is configured.
export async function fetchRunManifest(
  stsUrl: string,
  applicationId: string,
  clientSecret: string,
  opts: RunManifestOptions = {},
): Promise<RunManifestResponse> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000)
  let res: Response
  try {
    res = await (opts.fetchImpl ?? fetch)(`${stsUrl}/v1/run/manifest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ application_id: applicationId, client_secret: clientSecret }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
  if (!res.ok) {
    let description = `STS error ${res.status}`
    try {
      const err = (await res.json()) as { error_description?: string }
      if (typeof err.error_description === 'string' && err.error_description !== '') description = err.error_description
    } catch {
      // Non-JSON error bodies fall back to the status message.
    }
    throw new Error(description)
  }
  return validateManifest(await res.json())
}

function validateManifest(data: unknown): RunManifestResponse {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('run manifest invalid: expected an object')
  }
  const body = data as Record<string, unknown>
  if (typeof body.zone_id !== 'string' || body.zone_id === '') {
    throw new Error('run manifest invalid: zone_id is required')
  }
  if (typeof body.application_id !== 'string' || body.application_id === '') {
    throw new Error('run manifest invalid: application_id is required')
  }
  if (!Array.isArray(body.credentials) || body.credentials.length === 0) {
    throw new Error('run manifest invalid: credentials are required')
  }
  const response: RunManifestResponse = {
    zoneId: body.zone_id,
    applicationId: body.application_id,
    credentials: body.credentials.map(validateCredential),
  }
  if (body.ttl_seconds !== undefined) {
    if (typeof body.ttl_seconds !== 'number' || !Number.isInteger(body.ttl_seconds) || body.ttl_seconds <= 0) {
      throw new Error('run manifest invalid: ttl_seconds must be a positive integer')
    }
    response.ttlSeconds = body.ttl_seconds
  }
  if (body.continue_on_failure !== undefined) {
    if (typeof body.continue_on_failure !== 'boolean') {
      throw new Error('run manifest invalid: continue_on_failure must be a boolean')
    }
    response.continueOnFailure = body.continue_on_failure
  }
  return response
}

function validateCredential(value: unknown): RunManifestCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('run manifest invalid: credential must be an object')
  }
  const item = value as Record<string, unknown>
  if (typeof item.env !== 'string' || item.env === '') {
    throw new Error('run manifest invalid: credential env is required')
  }
  if (typeof item.resource !== 'string' || item.resource === '') {
    throw new Error('run manifest invalid: credential resource is required')
  }
  const credentialType = item.credential_type ?? 'provider_token'
  if (credentialType !== 'provider_token' && credentialType !== 'caracal_mandate') {
    throw new Error(`run manifest invalid: unknown credential_type for ${item.env}`)
  }
  const onFailure = item.on_failure ?? 'error'
  if (onFailure !== 'warn' && onFailure !== 'error') {
    throw new Error(`run manifest invalid: unknown on_failure for ${item.env}`)
  }
  return {
    env: item.env,
    resource: item.resource,
    credentialType,
    optional: item.optional === true,
    onFailure,
  }
}
