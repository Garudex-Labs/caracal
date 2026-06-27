// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the governed Operator executor: scoped control invocation per step, outcome shaping, and stop-on-first-failure atomicity.

import { describe, it, expect, vi } from 'vitest'
import { executeViaControlPlane } from '../../../../apps/api/src/operator-governed-execute.js'
import { ControlClientError, type ControlClient } from '../../../../apps/api/src/control-client.js'

// A control client whose invoke results are scripted in order, recording each call so the
// command, scopes, and flags it was driven with can be asserted.
function fakeClient(results: (unknown | Error)[]): {
  client: ControlClient
  calls: { command: string; subcommand: string; flags: Record<string, unknown>; scopes: readonly string[] }[]
} {
  const calls: { command: string; subcommand: string; flags: Record<string, unknown>; scopes: readonly string[] }[] = []
  let i = 0
  const client: ControlClient = {
    invoke: vi.fn(async (command, subcommand, flags, scopes) => {
      calls.push({ command, subcommand, flags, scopes })
      const next = results[i++]
      if (next instanceof Error) throw next
      return next
    }),
  }
  return { client, calls }
}

const secret = () => 'cs_fixed_secret'

describe('executeViaControlPlane', () => {
  it('applies a grantAccess step through the grant create command with its least-privilege scope', async () => {
    const { client, calls } = fakeClient([{ id: 'grant-1' }])
    const result = await executeViaControlPlane(
      client,
      [
        {
          id: 's1',
          capability: 'grantAccess',
          args: { application_id: 'app-1', user_id: 'user-1', resource_id: 'res-1', scopes: ['invoices:read'] },
        },
      ],
      secret,
    )

    expect(result.failure).toBeNull()
    expect(result.applied).toHaveLength(1)
    expect(result.applied[0]).toMatchObject({ id: 's1', capability: 'grantAccess' })
    expect(result.applied[0].detail).toContain('invoices:read')
    expect(result.applied[0].output).toEqual({ grant_id: 'grant-1' })
    expect(calls[0]).toMatchObject({
      command: 'grant',
      subcommand: 'create',
      scopes: ['control:grant:write'],
      flags: { 'application-id': 'app-1', 'user-id': 'user-1', 'resource-id': 'res-1', scopes: ['invoices:read'] },
    })
  })

  it('rotates an application secret by generating one and setting it, returning it as a one-time output', async () => {
    const { client, calls } = fakeClient([{ id: 'app-1' }])
    const result = await executeViaControlPlane(
      client,
      [{ id: 's1', capability: 'rotateApplicationSecret', args: { application_id: 'app-1' } }],
      secret,
    )

    expect(result.failure).toBeNull()
    expect(calls[0]).toMatchObject({ command: 'app', subcommand: 'patch', flags: { id: 'app-1', 'client-secret': 'cs_fixed_secret' } })
    expect(result.applied[0].output).toEqual({ application_id: 'app-1', client_secret: 'cs_fixed_secret' })
    // The generated secret must never appear in the ledger-safe detail.
    expect(result.applied[0].detail).not.toContain('cs_fixed_secret')
  })

  it('surfaces live read output for a list capability', async () => {
    const { client } = fakeClient([[{ id: 'a' }, { id: 'b' }]])
    const result = await executeViaControlPlane(client, [{ id: 's1', capability: 'listApplications', args: {} }], secret)
    expect(result.applied[0].output).toEqual({ applications: [{ id: 'a' }, { id: 'b' }] })
    expect(result.applied[0].detail).toBe('Found 2 applications in this zone.')
  })

  it('applies multiple steps in order and reports them all when every step succeeds', async () => {
    const { client, calls } = fakeClient([{ id: 'app-1', client_secret: 'cs_issued' }, { id: 'grant-1' }])
    const result = await executeViaControlPlane(
      client,
      [
        { id: 's1', capability: 'registerApplication', args: { name: 'worker' } },
        { id: 's2', capability: 'grantAccess', args: { application_id: 'app-1', user_id: 'u', resource_id: 'r', scopes: ['read'] } },
      ],
      secret,
    )
    expect(result.failure).toBeNull()
    expect(result.applied.map((s) => s.id)).toEqual(['s1', 's2'])
    expect(calls.map((c) => `${c.command}:${c.subcommand}`)).toEqual(['app:create', 'grant:create'])
  })

  it('stops at the first failing step and reports the applied steps and the failure', async () => {
    const { client, calls } = fakeClient([
      { id: 'app-1' },
      new ControlClientError('invoke', 403, 'missing scope control:grant:write', 'denied'),
    ])
    const result = await executeViaControlPlane(
      client,
      [
        { id: 's1', capability: 'registerApplication', args: { name: 'worker' } },
        { id: 's2', capability: 'grantAccess', args: { application_id: 'app-1', user_id: 'u', resource_id: 'r', scopes: ['read'] } },
        { id: 's3', capability: 'listProviders', args: {} },
      ],
      secret,
    )

    expect(result.applied.map((s) => s.id)).toEqual(['s1'])
    expect(result.failure).toEqual({ stepId: 's2', capability: 'grantAccess', reason: 'missing scope control:grant:write', code: 'denied' })
    // The plan stopped: the third step was never invoked.
    expect(calls).toHaveLength(2)
  })

  it('fails closed when a step is not governed-executable, before any invoke', async () => {
    const { client, calls } = fakeClient([])
    const result = await executeViaControlPlane(client, [{ id: 's1', capability: 'createZone', args: { name: 'Prod' } }], secret)
    expect(result.applied).toHaveLength(0)
    expect(result.failure).toMatchObject({ stepId: 's1', capability: 'createZone' })
    expect(calls).toHaveLength(0)
  })
})
