// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the ephemeral Operator state researcher: governed-read derivation, concurrent gathering, name-only summaries, and failure isolation.

import { describe, it, expect, vi } from 'vitest'
import { createStateResearcher, governedReadCapabilities } from '../../../../apps/api/src/operator-research.js'
import { ControlClientError, type ControlClient } from '../../../../apps/api/src/control-client.js'

// A control client double whose invoke is scripted by the list subcommand, so the researcher's
// governed reads are exercised without a live control plane.
function clientFor(
  rowsByCommand: Record<string, unknown>,
  fail?: { command: string; error: ControlClientError },
): {
  client: ControlClient
  invoke: ReturnType<typeof vi.fn>
} {
  const invoke = vi.fn(async (command: string) => {
    if (fail && command === fail.command) throw fail.error
    return rowsByCommand[command] ?? []
  })
  return { client: { invoke } as unknown as ControlClient, invoke }
}

describe('governedReadCapabilities', () => {
  it('derives exactly the non-mutating, control-mapped capabilities', () => {
    const reads = governedReadCapabilities()
    expect(reads.sort()).toEqual(['listApplications', 'listPolicies', 'listProviders', 'listResources'])
  })

  it('never includes a mutating capability', () => {
    const reads = governedReadCapabilities()
    expect(reads).not.toContain('registerApplication')
    expect(reads).not.toContain('grantAccess')
    expect(reads).not.toContain('rotateApplicationSecret')
  })
})

describe('createStateResearcher', () => {
  it('gathers live counts and safe names for every governed read', async () => {
    const { client, invoke } = clientFor({
      app: [
        { id: 'a1', name: 'Billing' },
        { id: 'a2', name: 'Finance' },
      ],
      'identity-provider': [{ id: 'p1', name: 'GitHub' }],
      resource: [],
      policy: [{ id: 'pol1', name: 'default' }],
    })
    const { evidence } = await createStateResearcher(client).gather()
    const byDomain = Object.fromEntries(evidence.map((e) => [e.domain, e]))
    expect(byDomain.application).toMatchObject({ ok: true, count: 2, names: ['Billing', 'Finance'] })
    expect(byDomain.provider).toMatchObject({ ok: true, count: 1, names: ['GitHub'] })
    expect(byDomain.resource).toMatchObject({ ok: true, count: 0, names: [] })
    expect(byDomain.policy).toMatchObject({ ok: true, count: 1, names: ['default'] })
    // Every invoke is a list subcommand — a researcher can never reach a mutating command.
    for (const call of invoke.mock.calls) expect(call[1]).toBe('list')
  })

  it('caps the names it surfaces while keeping the full live count', async () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, name: `app-${i}` }))
    const { client } = clientFor({ app: rows, 'identity-provider': [], resource: [], policy: [] })
    const { evidence } = await createStateResearcher(client).gather()
    const apps = evidence.find((e) => e.domain === 'application')!
    expect(apps.count).toBe(9)
    expect(apps.names).toHaveLength(5)
  })

  it('falls back to the id when a row has no name, and ignores nameless rows', async () => {
    const { client } = clientFor({
      app: [{ id: 'a1' }, { other: true }],
      'identity-provider': [],
      resource: [],
      policy: [],
    })
    const { evidence } = await createStateResearcher(client).gather()
    const apps = evidence.find((e) => e.domain === 'application')!
    expect(apps.count).toBe(2)
    expect(apps.names).toEqual(['a1'])
  })

  it('isolates a single failed read into a typed evidence entry without losing the others', async () => {
    const { client } = clientFor(
      { app: [{ id: 'a1', name: 'Billing' }], 'identity-provider': [], resource: [], policy: [] },
      { command: 'policy', error: new ControlClientError('token', 403, 'missing scope control:policy:read') },
    )
    const { evidence } = await createStateResearcher(client).gather()
    const apps = evidence.find((e) => e.domain === 'application')!
    const policy = evidence.find((e) => e.domain === 'policy')!
    expect(apps).toMatchObject({ ok: true, count: 1 })
    expect(policy).toMatchObject({ ok: false, error: 'missing scope control:policy:read' })
  })
})
