// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Run client unit tests: manifest retrieval, credential minting, validation, and STS error surfacing.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchRunCredential, fetchRunManifest } from '../../../../../packages/oauth/ts/src/manifest.js'
import { ApprovalRequiredError } from '../../../../../packages/oauth/ts/src/types.js'

function manifestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    zone_id: 'z1',
    workload_id: 'wl1',
    bindings: [
      { env: 'CARACAL_RESOURCE_PIPERNET_TOKEN', resource: 'resource://pipernet', scopes: ['pipernet:read'] },
      { env: 'OPT', resource: 'resource://hoolibox', optional: true, on_failure: 'warn' },
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
    const manifest = await fetchRunManifest('http://sts:8080', 'wl1', 'ws_secret', { fetchImpl: fetchMock })
    expect(fetchMock).toHaveBeenCalledWith('http://sts:8080/v1/run/manifest', expect.objectContaining({ method: 'POST' }))
    const body = fetchMock.mock.calls[0][1].body as URLSearchParams
    expect(body.get('workload_id')).toBe('wl1')
    expect(body.get('secret')).toBe('ws_secret')
    expect(manifest).toEqual({
      zoneId: 'z1',
      workloadId: 'wl1',
      bindings: [
        {
          env: 'CARACAL_RESOURCE_PIPERNET_TOKEN',
          resource: 'resource://pipernet',
          scopes: ['pipernet:read'],
          optional: false,
          onFailure: 'error',
        },
        { env: 'OPT', resource: 'resource://hoolibox', scopes: [], optional: true, onFailure: 'warn' },
      ],
    })
  })

  it('sends the launch correlation header when a launch id is provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => manifestBody() })
    await fetchRunManifest('http://sts:8080', 'wl1', 'ws_secret', { fetchImpl: fetchMock, launchId: 'launch-uuid' })
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>
    expect(headers['X-Caracal-Launch-Id']).toBe('launch-uuid')
    const bare = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => manifestBody() })
    await fetchRunManifest('http://sts:8080', 'wl1', 'ws_secret', { fetchImpl: bare })
    expect((bare.mock.calls[0][1].headers as Record<string, string>)['X-Caracal-Launch-Id']).toBeUndefined()
  })

  it('surfaces the STS error description on failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'resource_not_found', error_description: 'no credential bindings configured' }),
    })
    await expect(fetchRunManifest('http://sts:8080', 'wl1', 'ws_secret', { fetchImpl: fetchMock })).rejects.toThrow(
      'no credential bindings configured',
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
    await expect(fetchRunManifest('http://sts:8080', 'wl1', 'ws_secret', { fetchImpl: fetchMock })).rejects.toThrow('STS error 500')
  })

  it('rejects malformed manifest shapes', async () => {
    const cases = [
      manifestBody({ zone_id: '' }),
      manifestBody({ bindings: [] }),
      manifestBody({ bindings: [{ env: '', resource: 'r' }] }),
      manifestBody({ bindings: [{ env: 'A', resource: '' }] }),
      manifestBody({ bindings: [{ env: 'A', resource: 'r', scopes: [''] }] }),
      manifestBody({ bindings: [{ env: 'A', resource: 'r', on_failure: 'explode' }] }),
    ]
    for (const body of cases) {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body })
      await expect(fetchRunManifest('http://sts:8080', 'wl1', 'ws_secret', { fetchImpl: fetchMock })).rejects.toThrow(
        /run manifest invalid/,
      )
    }
  })
})

describe('fetchRunCredential', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('posts the binding env and maps the minted credential', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ env: 'CARACAL_RESOURCE_PIPERNET_TOKEN', credential: 'pipernet-api-key', expires_at: 1234 }),
    })
    const minted = await fetchRunCredential('http://sts:8080', 'wl1', 'ws_secret', 'CARACAL_RESOURCE_PIPERNET_TOKEN', {
      fetchImpl: fetchMock,
    })
    expect(fetchMock).toHaveBeenCalledWith('http://sts:8080/v1/run/credential', expect.objectContaining({ method: 'POST' }))
    const body = fetchMock.mock.calls[0][1].body as URLSearchParams
    expect(body.get('workload_id')).toBe('wl1')
    expect(body.get('secret')).toBe('ws_secret')
    expect(body.get('env')).toBe('CARACAL_RESOURCE_PIPERNET_TOKEN')
    expect(body.get('challenge_id')).toBeNull()
    expect(minted).toEqual({ env: 'CARACAL_RESOURCE_PIPERNET_TOKEN', credential: 'pipernet-api-key', expiresAt: 1234 })
  })

  it('forwards an approved challenge id on retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ env: 'OPT', credential: 'tok' }),
    })
    await fetchRunCredential('http://sts:8080', 'wl1', 'ws_secret', 'OPT', { fetchImpl: fetchMock, challengeId: 'ch-1' })
    const body = fetchMock.mock.calls[0][1].body as URLSearchParams
    expect(body.get('challenge_id')).toBe('ch-1')
  })

  it('raises ApprovalRequiredError when the mint is held for approval', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({
        error: 'interaction_required',
        error_description: 'Approval required',
        challenge_id: 'ch-9',
        state: 'pending',
        tier: 'sensitive',
      }),
    })
    const err = await fetchRunCredential('http://sts:8080', 'wl1', 'ws_secret', 'OPT', { fetchImpl: fetchMock }).catch((e) => e)
    expect(err).toBeInstanceOf(ApprovalRequiredError)
    expect(err.challengeId).toBe('ch-9')
    expect(err.tier).toBe('sensitive')
  })

  it('surfaces the STS error description on denial', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'access_denied', error_description: 'policy denied' }),
    })
    await expect(fetchRunCredential('http://sts:8080', 'wl1', 'ws_secret', 'OPT', { fetchImpl: fetchMock })).rejects.toThrow(
      'policy denied',
    )
  })

  it('rejects malformed credential responses', async () => {
    const cases = [{ env: '', credential: 'tok' }, { env: 'A', credential: '' }, { env: 'A', credential: 'tok', expires_at: 1.5 }, []]
    for (const body of cases) {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body })
      await expect(fetchRunCredential('http://sts:8080', 'wl1', 'ws_secret', 'A', { fetchImpl: fetchMock })).rejects.toThrow(
        /run credential invalid/,
      )
    }
  })
})
