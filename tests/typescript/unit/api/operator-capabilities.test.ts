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
})
