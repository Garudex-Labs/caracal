// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the read-only Operator execution preview.

import { describe, it, expect, vi } from 'vitest'
import { PREVIEW_TARGETS, previewPlan, type PreviewQueryable } from '../../../../apps/api/src/operator-preview.js'

// A queryable whose existence checks are scripted per call. Each entry is the rows
// array returned for the next db.query invocation, in order.
function scriptedDb(results: { rows: unknown[] }[]): PreviewQueryable {
  const query = vi.fn()
  for (const result of results) query.mockResolvedValueOnce(result)
  query.mockResolvedValue({ rows: [] })
  return { query } as unknown as PreviewQueryable
}

describe('previewPlan', () => {
  it('returns catalog diagnostics without reading state when validation fails', async () => {
    const db = scriptedDb([])
    const result = await previewPlan(db, 'z1', {
      summary: 'bad',
      steps: [{ id: 's1', capability: 'nope', args: {} }],
    })
    expect(result.ok).toBe(false)
    expect(result.steps).toHaveLength(0)
    expect(result.diagnostics[0]).toMatchObject({ code: 'unknown_capability' })
    expect(db.query as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('classifies a create when the name is free', async () => {
    const db = scriptedDb([{ rows: [] }]) // providers name lookup → not taken
    const result = await previewPlan(db, 'z1', {
      summary: 'Connect GitHub',
      steps: [{ id: 's1', capability: 'connectProvider', args: { name: 'GitHub', kind: 'oauth2_authorization_code' } }],
    })
    expect(result.ok).toBe(true)
    expect(result.mutating).toBe(true)
    expect(result.steps[0]).toMatchObject({ id: 's1', effect: 'create' })
    expect(result.steps[0].detail).toContain('GitHub')
  })

  it('classifies an exists when the name is taken', async () => {
    const db = scriptedDb([{ rows: [{ one: 1 }] }]) // providers name lookup → taken
    const result = await previewPlan(db, 'z1', {
      summary: 'Connect GitHub',
      steps: [{ id: 's1', capability: 'connectProvider', args: { name: 'GitHub', kind: 'oauth2_authorization_code' } }],
    })
    expect(result.steps[0]).toMatchObject({ effect: 'exists' })
  })

  it('treats read capabilities as read_only without querying state', async () => {
    const db = scriptedDb([])
    const result = await previewPlan(db, 'z1', {
      summary: 'Audit',
      steps: [{ id: 's1', capability: 'explainRequest', args: { request_id: 'req-1' } }],
    })
    expect(result.steps[0]).toMatchObject({ effect: 'read_only' })
    expect(db.query as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('blocks a grant whose application is missing and marks the plan not ok', async () => {
    const db = scriptedDb([{ rows: [] }]) // application id lookup → missing
    const result = await previewPlan(db, 'z1', {
      summary: 'Grant read',
      steps: [
        {
          id: 's1',
          capability: 'grantAccess',
          args: { application_id: 'app-x', user_id: 'user-1', resource_id: 'res-1', scopes: ['invoices:read'] },
        },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.steps[0]).toMatchObject({ effect: 'blocked' })
    expect(result.steps[0].detail).toContain('app-x')
  })

  it('resolves a grant when application and resource are both live', async () => {
    const db = scriptedDb([
      { rows: [{ one: 1 }] }, // application live
      { rows: [{ one: 1 }] }, // resource live
    ])
    const result = await previewPlan(db, 'z1', {
      summary: 'Grant read',
      steps: [
        {
          id: 's1',
          capability: 'grantAccess',
          args: { application_id: 'app-1', user_id: 'user-1', resource_id: 'res-1', scopes: ['invoices:read'] },
        },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.steps[0]).toMatchObject({ effect: 'create' })
    expect(result.steps[0].detail).toContain('invoices:read')
  })

  it('classifies a delete when the application is live, and blocks it when missing', async () => {
    const live = scriptedDb([{ rows: [{ one: 1 }] }]) // application id lookup → live
    const liveResult = await previewPlan(live, 'z1', {
      summary: 'Delete app',
      steps: [{ id: 's1', capability: 'deleteApplication', args: { application_id: 'app-1' } }],
    })
    expect(liveResult.ok).toBe(true)
    expect(liveResult.steps[0]).toMatchObject({ effect: 'delete' })
    expect(liveResult.steps[0].detail).toContain('app-1')

    const missing = scriptedDb([{ rows: [] }]) // application id lookup → missing
    const missingResult = await previewPlan(missing, 'z1', {
      summary: 'Delete app',
      steps: [{ id: 's1', capability: 'deleteApplication', args: { application_id: 'app-x' } }],
    })
    expect(missingResult.ok).toBe(false)
    expect(missingResult.steps[0]).toMatchObject({ effect: 'blocked' })
  })

  it('previews in-zone removes through the declared mutate-by-id spec', async () => {
    const resource = await previewPlan(scriptedDb([{ rows: [{ one: 1 }] }]), 'z1', {
      summary: 'Delete resource',
      steps: [{ id: 's1', capability: 'deleteResource', args: { resource_id: 'res-1' } }],
    })
    expect(resource.steps[0]).toMatchObject({ effect: 'delete' })
    expect(resource.steps[0].detail).toContain('res-1')

    const grantLive = await previewPlan(scriptedDb([{ rows: [{ one: 1 }] }]), 'z1', {
      summary: 'Revoke grant',
      steps: [{ id: 's1', capability: 'revokeGrant', args: { grant_id: 'grant-1' } }],
    })
    expect(grantLive.steps[0]).toMatchObject({ effect: 'delete' })
    expect(grantLive.steps[0].detail).toContain('grant-1')

    const grantMissing = await previewPlan(scriptedDb([{ rows: [] }]), 'z1', {
      summary: 'Revoke grant',
      steps: [{ id: 's1', capability: 'revokeGrant', args: { grant_id: 'grant-x' } }],
    })
    expect(grantMissing.ok).toBe(false)
    expect(grantMissing.steps[0]).toMatchObject({ effect: 'blocked' })
  })

  it('classifies a policy create against the policies table when the name is free', async () => {
    const db = scriptedDb([{ rows: [] }]) // policies name lookup → free
    const result = await previewPlan(db, 'z1', {
      summary: 'Author PiperNet baseline',
      steps: [{ id: 's1', capability: 'createPolicy', args: { name: 'PiperNet baseline', content: 'package caracal.authz' } }],
    })
    expect(result.ok).toBe(true)
    expect(result.mutating).toBe(true)
    expect(result.steps[0]).toMatchObject({ effect: 'create' })
    expect(result.steps[0].detail).toContain('PiperNet baseline')
  })

  it('previews a policy version against the live policy, blocking it when missing', async () => {
    const live = await previewPlan(scriptedDb([{ rows: [{ one: 1 }] }]), 'z1', {
      summary: 'Version policy',
      steps: [{ id: 's1', capability: 'versionPolicy', args: { policy_id: 'pol-1', content: 'package caracal.authz' } }],
    })
    expect(live.steps[0]).toMatchObject({ effect: 'update' })
    expect(live.steps[0].detail).toContain('pol-1')

    const missing = await previewPlan(scriptedDb([{ rows: [] }]), 'z1', {
      summary: 'Version policy',
      steps: [{ id: 's1', capability: 'versionPolicy', args: { policy_id: 'pol-x', content: 'package caracal.authz' } }],
    })
    expect(missing.ok).toBe(false)
    expect(missing.steps[0]).toMatchObject({ effect: 'blocked' })
  })

  it('previews the policy-set lifecycle against the policy_sets table', async () => {
    const created = await previewPlan(scriptedDb([{ rows: [] }]), 'z1', {
      summary: 'Create set',
      steps: [{ id: 's1', capability: 'createPolicySet', args: { name: 'PiperNet baseline v3' } }],
    })
    expect(created.steps[0]).toMatchObject({ effect: 'create' })
    expect(created.steps[0].detail).toContain('PiperNet baseline v3')

    const versioned = await previewPlan(scriptedDb([{ rows: [{ one: 1 }] }]), 'z1', {
      summary: 'Version set',
      steps: [{ id: 's1', capability: 'versionPolicySet', args: { policy_set_id: 'set-1', policy_version_ids: ['pv-1'] } }],
    })
    expect(versioned.steps[0]).toMatchObject({ effect: 'update' })

    const activated = await previewPlan(scriptedDb([{ rows: [{ one: 1 }] }]), 'z1', {
      summary: 'Activate set',
      steps: [{ id: 's1', capability: 'activatePolicySet', args: { policy_set_id: 'set-1', policy_set_version_id: 'sv-1' } }],
    })
    expect(activated.steps[0]).toMatchObject({ effect: 'update' })
    expect(activated.steps[0].detail).toContain('set-1')

    const missing = await previewPlan(scriptedDb([{ rows: [] }]), 'z1', {
      summary: 'Activate set',
      steps: [{ id: 's1', capability: 'activatePolicySet', args: { policy_set_id: 'set-x', policy_set_version_id: 'sv-1' } }],
    })
    expect(missing.ok).toBe(false)
    expect(missing.steps[0]).toMatchObject({ effect: 'blocked' })
  })

  it('treats listGrants as read_only without querying state', async () => {
    const db = scriptedDb([])
    const result = await previewPlan(db, 'z1', {
      summary: 'List grants',
      steps: [{ id: 's1', capability: 'listGrants', args: {} }],
    })
    expect(result.steps[0]).toMatchObject({ effect: 'read_only' })
    expect(db.query as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('previews a multi-step plan against live state in order', async () => {
    const db = scriptedDb([
      { rows: [] }, // connectProvider name free
      { rows: [{ one: 1 }] }, // registerApplication name taken
    ])
    const result = await previewPlan(db, 'z1', {
      summary: 'Stand up',
      steps: [
        { id: 's1', capability: 'connectProvider', args: { name: 'Hooli OIDC', kind: 'oauth2_client_credentials' } },
        { id: 's2', capability: 'registerApplication', args: { name: 'billing-worker' } },
      ],
    })
    expect(result.steps.map((s) => s.effect)).toEqual(['create', 'exists'])
  })

  it('treats an id bound by a step-output reference as satisfied by the plan itself', async () => {
    const db = scriptedDb([
      { rows: [] }, // connectProvider name free; the referenced provider is never queried
    ])
    const result = await previewPlan(db, 'z1', {
      summary: 'Connect and bind',
      steps: [
        { id: 's1', capability: 'connectProvider', args: { name: 'Hooli OIDC', kind: 'oauth2_client_credentials' } },
        {
          id: 's2',
          capability: 'defineResource',
          args: {
            name: 'PiperNet',
            scopes: ['pipernet:read'],
            upstream_url: 'https://api.pipernet.example',
            credential_provider_id: '{{steps.s1.outputs.provider_id}}',
          },
        },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.steps.map((s) => s.effect)).toEqual(['create', 'create'])
    expect(db.query as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1)
  })
})

// The preview is the one sanctioned direct-database read path beside the governed control
// reads: it needs exact existence and liveness predicates the paged governed lists cannot
// answer. These conformance tests hold it to the same security semantics - every target maps
// to a fixed table carrying the control plane's own liveness predicate, and every query it
// issues is a parameterized, zone-bound, read-only SELECT.
describe('direct-read conformance', () => {
  it('binds every preview target to a fixed table and the control-plane liveness predicate', () => {
    const liveness: Record<string, string> = {
      applications: 'archived_at IS NULL',
      providers: 'archived_at IS NULL',
      resources: 'archived_at IS NULL',
      policies: 'archived_at IS NULL',
      policySets: 'archived_at IS NULL',
      grants: "status <> 'revoked'",
    }
    expect(Object.keys(PREVIEW_TARGETS).sort()).toEqual(Object.keys(liveness).sort())
    for (const [target, spec] of Object.entries(PREVIEW_TARGETS)) {
      expect(spec.table).toMatch(/^[a-z_]+$/)
      expect(spec.live).toBe(liveness[target])
    }
  })

  it('issues only parameterized, zone-scoped, read-only SELECT queries for every preview shape', async () => {
    const recorded: { text: string; params: unknown[] }[] = []
    const db = {
      query: vi.fn(async (text: string, params?: unknown[]) => {
        recorded.push({ text, params: params ?? [] })
        return { rows: [{ one: 1 }] }
      }),
    } as unknown as PreviewQueryable
    await previewPlan(db, 'z1', {
      summary: 'One step of every live-read preview shape',
      steps: [
        { id: 's1', capability: 'connectProvider', args: { name: 'Hooli OIDC', kind: 'oauth2_client_credentials' } },
        { id: 's2', capability: 'deleteApplication', args: { application_id: 'app-1' } },
        {
          id: 's3',
          capability: 'defineResource',
          args: {
            name: 'PiperNet',
            scopes: ['pipernet:read'],
            upstream_url: 'https://api.pipernet.example',
            credential_provider_id: 'prov-1',
          },
        },
      ],
    })
    expect(recorded.length).toBeGreaterThan(0)
    for (const { text, params } of recorded) {
      expect(text.trim()).toMatch(/^SELECT 1 AS one FROM [a-z_]+ WHERE /)
      expect(text).toContain('zone_id = $2')
      expect(text).toContain('LIMIT 1')
      expect(params[1]).toBe('z1')
    }
  })
})
