// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the ephemeral Operator state researcher: governed-read derivation, concurrent gathering, name-only summaries, and failure isolation.

import { describe, it, expect, vi } from 'vitest'
import { createStateResearcher, governedReadCapabilities } from '../../../../apps/api/src/operator-research.js'
import { ControlClientError, type ControlClient } from '../../../../packages/admin/ts/src/control.js'

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
    expect(reads.sort()).toEqual([
      'explainRequest',
      'listAdminActivity',
      'listApplications',
      'listApprovals',
      'listAuditEvents',
      'listAuthorityRecords',
      'listDelegations',
      'listGrants',
      'listPolicies',
      'listPolicySets',
      'listProviders',
      'listResources',
      'listSessions',
      'listWorkloads',
      'simulatePolicySet',
      'validatePolicy',
    ])
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
    // Policies and policy sets share the policy domain, each grounded by its own read.
    expect(evidence.find((e) => e.capability === 'listPolicies')).toMatchObject({ ok: true, count: 1, names: ['default'] })
    expect(evidence.find((e) => e.capability === 'listPolicySets')).toMatchObject({ ok: true, count: 0, names: [] })
    // The live id is carried alongside the name so a change can target an object by its real id.
    expect(byDomain.application.items).toEqual([
      { id: 'a1', name: 'Billing' },
      { id: 'a2', name: 'Finance' },
    ])
    expect(byDomain.resource.items).toEqual([])
    // Every invoke is a read verb - a researcher can never reach a mutating command.
    for (const call of invoke.mock.calls) expect(['list', 'active', 'tail', 'admin']).toContain(call[1])
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

  it('surfaces the decision-relevant attributes a domain exposes: provider auth modes and resource scopes', async () => {
    const { client } = clientFor({
      app: [{ id: 'a1', name: 'Billing' }],
      'identity-provider': [
        { id: 'p1', name: 'GitHub', kind: 'api_key' },
        { id: 'p2', name: 'Okta', kind: 'oauth2_authorization_code' },
        { id: 'p3', name: 'Mirror', kind: 'api_key' },
      ],
      resource: [
        { id: 'r1', name: 'Stripe', scopes: ['read', 'write'] },
        { id: 'r2', name: 'Calendar', scopes: ['read'] },
      ],
      policy: [{ id: 'pol1', name: 'default' }],
    })
    const { evidence } = await createStateResearcher(client).gather()
    const byDomain = Object.fromEntries(evidence.map((e) => [e.domain, e]))
    // Provider auth modes are surfaced distinctly so the planner reasons against what exists.
    expect(byDomain.provider.attributes).toEqual({ auth: ['api_key', 'oauth2_authorization_code'] })
    // Resource scopes are surfaced distinctly so the guardian can judge least-privilege grants.
    expect(byDomain.resource.attributes).toEqual({ scopes: ['read', 'write'] })
    // A domain with no allowlisted descriptor field carries no attributes.
    expect(byDomain.application.attributes).toBeUndefined()
    expect(byDomain.policy.attributes).toBeUndefined()
  })

  it('reads only the allowlisted descriptor fields, never an arbitrary row field', async () => {
    // A provider row carrying a secret must surface its auth mode but never the secret: only the
    // allowlisted field is ever read off a row.
    const { client } = clientFor({
      app: [],
      'identity-provider': [{ id: 'p1', name: 'GitHub', kind: 'api_key', client_secret: 'sk_live_should_never_leak' }],
      resource: [],
      policy: [],
    })
    const { evidence } = await createStateResearcher(client).gather()
    const provider = evidence.find((e) => e.domain === 'provider')!
    expect(provider.attributes).toEqual({ auth: ['api_key'] })
    expect(JSON.stringify(provider)).not.toContain('sk_live_should_never_leak')
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

  it('degrades a non-array control result to a zero count without leaking', async () => {
    // A malformed control response (not a list) must not crash the gather or surface anything; it
    // degrades to an empty, name-free evidence entry.
    const invoke = vi.fn(async () => ({ unexpected: 'object' }))
    const { evidence } = await createStateResearcher({ invoke } as unknown as ControlClient).gather()
    for (const item of evidence) {
      expect(item).toMatchObject({ ok: true, count: 0 })
      expect(item.names).toEqual([])
    }
  })

  it('skips rows that are not objects without surfacing them', async () => {
    // A list with non-object entries (null, a string, a number) must contribute to the count but
    // never to the surfaced names, so a malformed row can never leak an arbitrary value.
    const invoke = vi.fn(async (command: string) => (command === 'app' ? [null, 'a-bare-string', 42, { id: 'a1', name: 'Billing' }] : []))
    const { evidence } = await createStateResearcher({ invoke } as unknown as ControlClient).gather()
    const apps = evidence.find((e) => e.domain === 'application')!
    expect(apps.count).toBe(4)
    expect(apps.names).toEqual(['Billing'])
  })

  it('catches a non-control throw with a safe generic reason', async () => {
    // An unexpected throw that is not a ControlClientError must not surface its message (which
    // could carry internal detail); it degrades to a fixed "read failed" reason.
    const invoke = vi.fn(async () => {
      throw new Error('postgres connection string postgres://user:secret@host failed')
    })
    const { evidence } = await createStateResearcher({ invoke } as unknown as ControlClient).gather()
    for (const item of evidence) {
      expect(item).toMatchObject({ ok: false, error: 'read failed' })
    }
    // The raw error text - which could carry a secret - never reaches the evidence.
    expect(JSON.stringify(evidence)).not.toContain('secret')
  })

  it('scopes the reads to the named domains and gathers nothing else', async () => {
    const { client, invoke } = clientFor({ app: [{ id: 'a1', name: 'Billing' }], 'identity-provider': [{ id: 'p1', name: 'GitHub' }] })
    const { evidence } = await createStateResearcher(client).gather(['provider'])
    // Only the provider read runs; the application, resource, and policy reads are never invoked.
    expect(evidence.map((e) => e.domain)).toEqual(['provider'])
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('reads everything when no domains are named', async () => {
    const { client, invoke } = clientFor({ app: [], 'identity-provider': [], resource: [], policy: [] })
    await createStateResearcher(client).gather([])
    // The fan-out is every governed read that needs no arguments: explainRequest,
    // validatePolicy, and simulatePolicySet answer specific questions, not state sweeps.
    expect(invoke).toHaveBeenCalledTimes(governedReadCapabilities().length - 3)
  })

  it('falls back to the full read set when the named domains map to no governed read', async () => {
    const { client, invoke } = clientFor({ app: [], 'identity-provider': [], resource: [], policy: [] })
    // 'zone' has no governed read behind it, so the gather must not end up empty.
    await createStateResearcher(client).gather(['zone'])
    expect(invoke).toHaveBeenCalledTimes(governedReadCapabilities().length - 3)
  })

  it('builds display rows from the allowlisted descriptor fields only', async () => {
    const { client } = clientFor({
      app: [{ id: 'a1', name: 'Billing', registration_method: 'managed', created_at: '2026-01-01T00:00:00Z', client_secret: 'sk_leak' }],
    })
    const { evidence } = await createStateResearcher(client).gather(['application'])
    const apps = evidence.find((e) => e.domain === 'application')!
    expect(apps.rows).toEqual([{ id: 'a1', name: 'Billing', registration_method: 'managed', created_at: '2026-01-01T00:00:00Z' }])
    expect(JSON.stringify(apps)).not.toContain('sk_leak')
  })

  it('unwraps an items envelope and keys Session rows by their Session ID', async () => {
    const { client } = clientFor({
      delegation: {
        items: [{ id: 'd1', issuer_application_id: 'a1', receiver_application_id: 'a2', scopes: ['read'], status: 'active' }],
        next_cursor: null,
      },
      session: [{ session_id: 'session-1', application_id: 'a1', lifecycle: 'ephemeral', status: 'active', depth: 1 }],
    })
    const { evidence } = await createStateResearcher(client).gather(['delegation', 'session'])
    const byDomain = Object.fromEntries(evidence.map((e) => [e.domain, e]))
    expect(byDomain.delegation).toMatchObject({ ok: true, count: 1 })
    expect(byDomain.delegation.rows).toEqual([
      { id: 'd1', issuer_application_id: 'a1', receiver_application_id: 'a2', scopes: ['read'], status: 'active' },
    ])
    expect(byDomain.session.rows).toEqual([{ id: 'session-1', application_id: 'a1', lifecycle: 'ephemeral', status: 'active', depth: '1' }])
  })

  it('excludes structured payload fields from audit display rows', async () => {
    const { client } = clientFor({
      audit: [
        {
          id: 'e1',
          event_type: 'authorization_decision',
          decision: 'deny',
          request_id: 'req1',
          occurred_at: '2026-01-01T00:00:00Z',
          metadata_json: { internal: 'never_shown' },
        },
      ],
    })
    const { evidence } = await createStateResearcher(client).gather(['audit'])
    const audit = evidence.find((e) => e.domain === 'audit')!
    expect(audit.rows).toEqual([
      { id: 'e1', event_type: 'authorization_decision', decision: 'deny', request_id: 'req1', occurred_at: '2026-01-01T00:00:00Z' },
    ])
    expect(JSON.stringify(audit)).not.toContain('never_shown')
  })

  it('bounds display rows while keeping the full live count', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ id: `a${i}`, name: `app-${i}` }))
    const { client } = clientFor({ app: rows })
    const { evidence } = await createStateResearcher(client).gather(['application'])
    const apps = evidence.find((e) => e.domain === 'application')!
    expect(apps.count).toBe(25)
    expect(apps.rows).toHaveLength(20)
  })
})
