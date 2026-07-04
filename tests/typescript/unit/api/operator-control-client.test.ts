// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the Operator control-client assembly: governed execution is configured only when both the identity and an enabled control plane are present.

import { describe, it, expect, vi } from 'vitest'
import { buildOperatorControlClient, type OperatorControlEndpoints } from '../../../../apps/api/src/operator-control-client.js'
import type { OperatorControlIdentity } from '../../../../apps/api/src/config.js'

const identity: OperatorControlIdentity = {
  zoneId: 'zone-sys',
  llm: { applicationId: 'caracal-sys-operator', clientSecret: 'cs_llm' },
  researcher: { applicationId: 'caracal-sys-operator-researcher', clientSecret: 'cs_researcher' },
  executor: { applicationId: 'caracal-sys-operator-executor', clientSecret: 'cs_executor' },
  expiresAt: new Date(Date.now() + 3600_000),
}

function endpoints(overrides: Partial<OperatorControlEndpoints> = {}): OperatorControlEndpoints {
  return {
    stsUrl: 'https://sts.example.com',
    audience: 'caracal-control',
    controlUrl: 'http://127.0.0.1:3000',
    controlEnabled: true,
    ...overrides,
  }
}

describe('buildOperatorControlClient', () => {
  it('returns null when the identity is not configured', () => {
    expect(buildOperatorControlClient({ identity: null, role: 'executor', endpoints: endpoints() })).toBeNull()
  })

  it('returns null when the control plane is disabled', () => {
    expect(buildOperatorControlClient({ identity, role: 'executor', endpoints: endpoints({ controlEnabled: false }) })).toBeNull()
  })

  it('builds a client that mints with the named role credential and invokes the configured control plane', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'tok' }), { status: 200, headers: { 'content-type': 'application/json' } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
      )
    const client = buildOperatorControlClient({
      identity,
      role: 'researcher',
      endpoints: endpoints(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(client).not.toBeNull()

    await client!.invoke('app', 'list', {}, ['control:app:read'])

    const tokenForm = new URLSearchParams((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    // The researcher role mints as its own application, never the base or executor identity.
    expect(tokenForm.get('application_id')).toBe('caracal-sys-operator-researcher')
    expect(tokenForm.get('client_secret')).toBe('cs_researcher')
    expect(tokenForm.get('resource')).toBe('caracal-control')
    expect(fetchMock.mock.calls[0]![0]).toBe('https://sts.example.com/oauth/2/token')
    expect(fetchMock.mock.calls[1]![0]).toBe('http://127.0.0.1:3000/v1/control/invoke')
  })
})
