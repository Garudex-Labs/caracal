// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// fetchRunManifest unit tests: manifest retrieval, validation, and STS error surfacing.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchRunManifest } from '../../../../../packages/oauth/ts/src/manifest.js'

function manifestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    zone_id: 'z1',
    application_id: 'app1',
    ttl_seconds: 300,
    continue_on_failure: false,
    credentials: [
      { env: 'CARACAL_RESOURCE_PIPERNET_TOKEN', resource: 'resource://pipernet', credential_type: 'provider_token' },
      { env: 'OPT', resource: 'resource://hoolibox', credential_type: 'caracal_mandate', optional: true, on_failure: 'warn' },
    ],
    ...overrides,
  }
}

describe('fetchRunManifest', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('posts the workload identity and maps the manifest', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => manifestBody() })
    const manifest = await fetchRunManifest('http://sts:8080', 'app1', 'cs_secret', { fetchImpl: fetchMock })
    expect(fetchMock).toHaveBeenCalledWith('http://sts:8080/v1/run/manifest', expect.objectContaining({ method: 'POST' }))
    const body = fetchMock.mock.calls[0][1].body as URLSearchParams
    expect(body.get('application_id')).toBe('app1')
    expect(body.get('client_secret')).toBe('cs_secret')
    expect(manifest).toEqual({
      zoneId: 'z1',
      applicationId: 'app1',
      ttlSeconds: 300,
      continueOnFailure: false,
      credentials: [
        {
          env: 'CARACAL_RESOURCE_PIPERNET_TOKEN',
          resource: 'resource://pipernet',
          credentialType: 'provider_token',
          optional: false,
          onFailure: 'error',
        },
        { env: 'OPT', resource: 'resource://hoolibox', credentialType: 'caracal_mandate', optional: true, onFailure: 'warn' },
      ],
    })
  })

  it('surfaces the STS error description on failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'resource_not_found', error_description: 'run manifest not configured' }),
    })
    await expect(fetchRunManifest('http://sts:8080', 'app1', 'cs_secret', { fetchImpl: fetchMock })).rejects.toThrow(
      'run manifest not configured',
    )
  })

  it('falls back to the status code when the error body is opaque', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json')
      },
    })
    await expect(fetchRunManifest('http://sts:8080', 'app1', 'cs_secret', { fetchImpl: fetchMock })).rejects.toThrow('STS error 500')
  })

  it('rejects malformed manifest shapes', async () => {
    const cases = [
      manifestBody({ zone_id: '' }),
      manifestBody({ credentials: [] }),
      manifestBody({ ttl_seconds: -1 }),
      manifestBody({ credentials: [{ env: '', resource: 'r' }] }),
      manifestBody({ credentials: [{ env: 'A', resource: 'r', credential_type: 'bogus' }] }),
      manifestBody({ credentials: [{ env: 'A', resource: 'r', on_failure: 'explode' }] }),
    ]
    for (const body of cases) {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body })
      await expect(fetchRunManifest('http://sts:8080', 'app1', 'cs_secret', { fetchImpl: fetchMock })).rejects.toThrow(
        /run manifest invalid/,
      )
    }
  })
})
