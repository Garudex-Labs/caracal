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
    expect(CAPABILITIES.listZones.mutating).toBe(false)
    expect(CAPABILITIES.explainAccess.mutating).toBe(false)
    expect(CAPABILITIES.grantAccess.mutating).toBe(true)
    expect(CAPABILITIES.rotateApplicationSecret.mutating).toBe(true)
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
      steps: [{ id: 's1', capability: 'explainAccess', args: { application_id: 'app-1' } }],
    })
    expect(result.ok).toBe(true)
    expect(result.mutating).toBe(false)
    expect(result.mutating_step_count).toBe(0)
    expect(result.steps[0]).toMatchObject({ id: 's1', capability: 'explainAccess', mutating: false })
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

  it('flags duplicate step ids', () => {
    const result = parse({
      summary: 'Two zones',
      steps: [
        { id: 's1', capability: 'createZone', args: { name: 'Prod' } },
        { id: 's1', capability: 'createZone', args: { name: 'Staging' } },
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
        { id: 's1', capability: 'createZone', args: { name: 'Production' } },
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
      summary: 'Create zone with junk',
      steps: [{ id: 's1', capability: 'createZone', args: { name: 'Prod', junk: true } }],
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
      summary: 'Two zones that wait on each other',
      steps: [
        { id: 's1', capability: 'createZone', args: { name: 'Pied Piper Production' }, depends_on: ['s2'] },
        { id: 's2', capability: 'createZone', args: { name: 'Hooli Staging' }, depends_on: ['s1'] },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.diagnostics.some((d) => d.code === 'dependency_cycle')).toBe(true)
  })

  it('flags a step that depends on itself as a cycle', () => {
    const result = parse({
      summary: 'A self-referential zone',
      steps: [{ id: 's1', capability: 'createZone', args: { name: 'Raviga Capital Sandbox' }, depends_on: ['s1'] }],
    })
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toEqual([{ step_id: 's1', code: 'dependency_cycle', message: expect.stringContaining('s1') }])
  })
})
