// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the Operator capability catalog and the deterministic plan validator.

import { describe, it, expect } from 'vitest'
import { CAPABILITIES, listCapabilities, validateProposedPlan, ProposedPlan } from '../../../../apps/api/src/operator-capabilities.js'

describe('capability catalog', () => {
  it('exposes a stable, sorted descriptor list without argument schemas', () => {
    const list = listCapabilities()
    expect(list.length).toBe(Object.keys(CAPABILITIES).length)
    expect(list.map((c) => c.id)).toEqual([...list.map((c) => c.id)].sort())
    for (const descriptor of list) {
      expect(descriptor).not.toHaveProperty('args')
      expect(typeof descriptor.mutating).toBe('boolean')
    }
  })

  it('classifies read capabilities as non-mutating', () => {
    expect(CAPABILITIES.listApplications.mutating).toBe(false)
    expect(CAPABILITIES.listPolicySets.mutating).toBe(false)
    expect(CAPABILITIES.explainRequest.mutating).toBe(false)
    expect(CAPABILITIES.validatePolicy.mutating).toBe(false)
    expect(CAPABILITIES.simulatePolicySet.mutating).toBe(false)
    expect(CAPABILITIES.listWorkloads.mutating).toBe(false)
    expect(CAPABILITIES.listApprovals.mutating).toBe(false)
    expect(CAPABILITIES.listAdminActivity.mutating).toBe(false)
    expect(CAPABILITIES.grantAccess.mutating).toBe(true)
    expect(CAPABILITIES.rotateApplicationSecret.mutating).toBe(true)
    expect(CAPABILITIES.deleteApplication.mutating).toBe(true)
    expect(CAPABILITIES.deleteResource.mutating).toBe(true)
    expect(CAPABILITIES.deleteProvider.mutating).toBe(true)
    expect(CAPABILITIES.deletePolicy.mutating).toBe(true)
    expect(CAPABILITIES.revokeGrant.mutating).toBe(true)
    expect(CAPABILITIES.listGrants.mutating).toBe(false)
    expect(CAPABILITIES.createPolicy.mutating).toBe(true)
    expect(CAPABILITIES.versionPolicy.mutating).toBe(true)
    expect(CAPABILITIES.createPolicySet.mutating).toBe(true)
    expect(CAPABILITIES.versionPolicySet.mutating).toBe(true)
    expect(CAPABILITIES.activatePolicySet.mutating).toBe(true)
    expect(CAPABILITIES.updateApplication.mutating).toBe(true)
    expect(CAPABILITIES.updateProvider.mutating).toBe(true)
    expect(CAPABILITIES.updateResource.mutating).toBe(true)
    expect(CAPABILITIES.deletePolicySet.mutating).toBe(true)
    expect(CAPABILITIES.suspendAgent.mutating).toBe(true)
    expect(CAPABILITIES.resumeAgent.mutating).toBe(true)
    expect(CAPABILITIES.terminateAgent.mutating).toBe(true)
    expect(CAPABILITIES.revokeDelegation.mutating).toBe(true)
    expect(CAPABILITIES.createWorkload.mutating).toBe(true)
    expect(CAPABILITIES.updateWorkload.mutating).toBe(true)
    expect(CAPABILITIES.rotateWorkloadSecret.mutating).toBe(true)
    expect(CAPABILITIES.deleteWorkload.mutating).toBe(true)
  })
})

describe('validateProposedPlan', () => {
  function parse(input: unknown) {
    const parsed = ProposedPlan.safeParse(input)
    if (!parsed.success) throw new Error('plan failed structural parse')
    return validateProposedPlan(parsed.data)
  }

  it('validates a correct read-only plan', () => {
    const result = parse({
      summary: 'Audit access',
      steps: [{ id: 's1', capability: 'explainRequest', args: { request_id: 'req-1' } }],
    })
    expect(result.ok).toBe(true)
    expect(result.mutating).toBe(false)
    expect(result.mutating_step_count).toBe(0)
    expect(result.steps[0]).toMatchObject({ id: 's1', capability: 'explainRequest', mutating: false })
  })

  it('derives the authoritative mutating flag from the catalog', () => {
    const result = parse({
      summary: 'Grant invoices read',
      steps: [
        {
          id: 's1',
          capability: 'grantAccess',
          args: { application_id: 'app-1', user_id: 'user-1', resource_id: 'res-1', scopes: ['invoices:read'] },
        },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.mutating).toBe(true)
    expect(result.mutating_step_count).toBe(1)
    expect(result.steps[0].mutating).toBe(true)
  })

  it('flags an unknown capability', () => {
    const result = parse({
      summary: 'Do magic',
      steps: [{ id: 's1', capability: 'teleport', args: {} }],
    })
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toEqual([{ step_id: 's1', code: 'unknown_capability', message: expect.stringContaining('teleport') }])
    expect(result.steps).toHaveLength(0)
  })

  it('flags arguments that fail the capability schema', () => {
    const result = parse({
      summary: 'Grant with no scopes',
      steps: [
        { id: 's1', capability: 'grantAccess', args: { application_id: 'app-1', user_id: 'user-1', resource_id: 'res-1', scopes: [] } },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.diagnostics[0]).toMatchObject({ step_id: 's1', code: 'invalid_args' })
  })

  it('validates a policy authoring plan carrying an inline data document', () => {
    const result = parse({
      summary: 'Create PiperNet baseline',
      steps: [
        {
          id: 's1',
          capability: 'createPolicy',
          args: { name: 'PiperNet baseline', content: 'package caracal.authz\n\ndefault allow := false' },
        },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.mutating).toBe(true)
    expect(result.steps[0]).toMatchObject({ id: 's1', capability: 'createPolicy', mutating: true })
  })

  it('rejects a policy create without a data document', () => {
    const result = parse({
      summary: 'Create empty policy',
      steps: [{ id: 's1', capability: 'createPolicy', args: { name: 'PiperNet baseline' } }],
    })
    expect(result.ok).toBe(false)
    expect(result.diagnostics[0]).toMatchObject({ step_id: 's1', code: 'invalid_args' })
  })

  it('validates the policy-set composition and activation arguments', () => {
    const version = parse({
      summary: 'Compose set',
      steps: [{ id: 's1', capability: 'versionPolicySet', args: { policy_set_id: 'set-1', policy_version_ids: ['pv-1', 'pv-2'] } }],
    })
    expect(version.ok).toBe(true)

    const activate = parse({
      summary: 'Activate set',
      steps: [{ id: 's1', capability: 'activatePolicySet', args: { policy_set_id: 'set-1', policy_set_version_id: 'sv-1' } }],
    })
    expect(activate.ok).toBe(true)

    const empty = parse({
      summary: 'Compose empty set',
      steps: [{ id: 's1', capability: 'versionPolicySet', args: { policy_set_id: 'set-1', policy_version_ids: [] } }],
    })
    expect(empty.ok).toBe(false)
    expect(empty.diagnostics[0]).toMatchObject({ step_id: 's1', code: 'invalid_args' })
  })

  it('flags duplicate step ids', () => {
    const result = parse({
      summary: 'Two applications',
      steps: [
        { id: 's1', capability: 'registerApplication', args: { name: 'Son of Anton' } },
        { id: 's1', capability: 'registerApplication', args: { name: 'Fiona' } },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toEqual([{ step_id: 's1', code: 'duplicate_step_id', message: expect.stringContaining('s1') }])
    expect(result.steps).toHaveLength(1)
  })

  it('reports a mixed plan with multiple diagnostics and partial success', () => {
    const result = parse({
      summary: 'Stand up production',
      steps: [
        { id: 's1', capability: 'registerApplication', args: { name: 'Son of Anton' } },
        { id: 's2', capability: 'registerApplication', args: {} },
        { id: 's3', capability: 'connectProvider', args: { name: 'GitHub', kind: 'oauth2_authorization_code' } },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.steps.map((s) => s.id)).toEqual(['s1', 's3'])
    expect(result.mutating_step_count).toBe(2)
    expect(result.diagnostics).toEqual([{ step_id: 's2', code: 'invalid_args', message: expect.any(String) }])
  })

  it('rejects unknown argument fields via strict schemas', () => {
    const result = parse({
      summary: 'Register application with junk',
      steps: [{ id: 's1', capability: 'registerApplication', args: { name: 'Son of Anton', junk: true } }],
    })
    expect(result.ok).toBe(false)
    expect(result.diagnostics[0]).toMatchObject({ code: 'invalid_args' })
  })

  it('accepts a sequenced plan, carrying each step its declared dependencies and risk', () => {
    const result = parse({
      summary: 'Register an application and grant it invoices read',
      steps: [
        { id: 's1', capability: 'registerApplication', args: { name: 'Son of Anton' }, risk: 'low' },
        {
          id: 's2',
          capability: 'grantAccess',
          args: { application_id: 'app-1', user_id: 'user-1', resource_id: 'res-1', scopes: ['invoices:read'] },
          depends_on: ['s1'],
          risk: 'high',
        },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.steps[0]).toMatchObject({ id: 's1', depends_on: [], risk: 'low' })
    expect(result.steps[1]).toMatchObject({ id: 's2', depends_on: ['s1'], risk: 'high' })
  })

  it('flags a dependency on a step the plan never declares', () => {
    const result = parse({
      summary: 'Grant before its prerequisite exists',
      steps: [
        {
          id: 's1',
          capability: 'grantAccess',
          args: { application_id: 'app-1', user_id: 'user-1', resource_id: 'res-1', scopes: ['invoices:read'] },
          depends_on: ['s0'],
        },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toEqual([{ step_id: 's1', code: 'unknown_dependency', message: expect.stringContaining('s0') }])
  })

  it('flags a dependency cycle so a sequenced apply can never deadlock', () => {
    const result = parse({
      summary: 'Two applications that wait on each other',
      steps: [
        { id: 's1', capability: 'registerApplication', args: { name: 'Son of Anton' }, depends_on: ['s2'] },
        { id: 's2', capability: 'registerApplication', args: { name: 'Fiona' }, depends_on: ['s1'] },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.diagnostics.some((d) => d.code === 'dependency_cycle')).toBe(true)
  })

  it('flags a step that depends on itself as a cycle', () => {
    const result = parse({
      summary: 'A self-referential application',
      steps: [{ id: 's1', capability: 'registerApplication', args: { name: 'PiperNet AI' }, depends_on: ['s1'] }],
    })
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toEqual([{ step_id: 's1', code: 'dependency_cycle', message: expect.stringContaining('s1') }])
  })

  it('folds a step-output reference into the referencing step\u2019s dependencies', () => {
    const result = parse({
      summary: 'Connect a provider and bind a resource to it',
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
    expect(result.steps[1].depends_on).toEqual(['s1'])
  })

  it('flags a reference to a step the plan never declares', () => {
    const result = parse({
      summary: 'Bind a resource to a phantom provider',
      steps: [
        {
          id: 's1',
          capability: 'defineResource',
          args: {
            name: 'PiperNet',
            scopes: ['pipernet:read'],
            upstream_url: 'https://api.pipernet.example',
            credential_provider_id: '{{steps.s0.outputs.provider_id}}',
          },
        },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toEqual([{ step_id: 's1', code: 'unknown_reference', message: expect.stringContaining('s0') }])
  })

  it('flags a reference to an output the producing step does not declare', () => {
    const result = parse({
      summary: 'Bind a resource to a secret',
      steps: [
        { id: 's1', capability: 'registerApplication', args: { name: 'Son of Anton' } },
        {
          id: 's2',
          capability: 'defineResource',
          args: {
            name: 'PiperNet',
            scopes: ['pipernet:read'],
            upstream_url: 'https://api.pipernet.example',
            credential_provider_id: '{{steps.s1.outputs.client_secret}}',
          },
        },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toEqual([{ step_id: 's2', code: 'unknown_reference', message: expect.stringContaining('client_secret') }])
  })

  it('flags a step that references its own output as a cycle', () => {
    const result = parse({
      summary: 'An application that rotates itself into existence',
      steps: [{ id: 's1', capability: 'rotateApplicationSecret', args: { application_id: '{{steps.s1.outputs.application_id}}' } }],
    })
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toEqual([{ step_id: 's1', code: 'dependency_cycle', message: expect.stringContaining('s1') }])
  })
})
