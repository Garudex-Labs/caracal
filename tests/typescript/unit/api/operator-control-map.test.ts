// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the Operator control mapping: governed command, least-privilege scopes, flags, and outcome shaping, cross-checked against the real engine surface.

import { describe, it, expect } from 'vitest'
import { CONTROL_CAPABILITIES, isControlExecutable, type ControlGen } from '../../../../apps/api/src/operator-control-map.js'
import { describeRemoteSurface } from '../../../../packages/engine/src/dispatch.js'

const gen: ControlGen = { secret: 'cs_generated_secret' }

describe('CONTROL_CAPABILITIES surface conformance', () => {
  // Every mapping must name a real (command, subcommand) the control plane exposes and
  // request exactly the scope that surface requires, so the Operator can never drift from
  // the engine's governed surface or under/over-request authority.
  it('maps every capability to a real engine command, subcommand, and scope', () => {
    const surface = describeRemoteSurface()
    const byPair = new Map(surface.map((entry) => [`${entry.command}:${entry.subcommand}`, entry.scope]))
    for (const [capability, mapping] of Object.entries(CONTROL_CAPABILITIES)) {
      const invocation = mapping.buildInvocation({}, gen)
      const pair = `${invocation.command}:${invocation.subcommand}`
      const engineScope = byPair.get(pair)
      expect(engineScope, `${capability} -> ${pair} must exist in the engine surface`).toBeDefined()
      expect(mapping.scopes, `${capability} scope must match the engine surface`).toEqual([engineScope])
    }
  })

  // Zone management is deliberately excluded from the control surface (a zone-bound key
  // must never create or list other zones), so the Operator must not map any capability to
  // a zone command.
  it('never maps a capability to the cross-zone zone command', () => {
    for (const mapping of Object.values(CONTROL_CAPABILITIES)) {
      expect(mapping.buildInvocation({}, gen).command).not.toBe('zone')
    }
  })
})

describe('isControlExecutable', () => {
  it('recognizes governed-executable capabilities and rejects others', () => {
    expect(isControlExecutable('registerApplication')).toBe(true)
    expect(isControlExecutable('grantAccess')).toBe(true)
    expect(isControlExecutable('listApplications')).toBe(true)
    expect(isControlExecutable('listProviders')).toBe(true)
    expect(isControlExecutable('listResources')).toBe(true)
    expect(isControlExecutable('listPolicies')).toBe(true)
    expect(isControlExecutable('rotateApplicationSecret')).toBe(true)
    expect(isControlExecutable('deleteApplication')).toBe(true)
    // Zone lifecycle is a platform operation, not governed-executable by the Operator.
    expect(isControlExecutable('createZone')).toBe(false)
    expect(isControlExecutable('listZones')).toBe(false)
    // Read-only explanation and configuration-heavy capabilities are not control commands.
    expect(isControlExecutable('explainAccess')).toBe(false)
    expect(isControlExecutable('connectProvider')).toBe(false)
    expect(isControlExecutable('defineResource')).toBe(false)
  })
})

describe('buildInvocation', () => {
  it('builds registerApplication from the name', () => {
    expect(CONTROL_CAPABILITIES.registerApplication.buildInvocation({ name: 'worker' }, gen)).toEqual({
      command: 'app',
      subcommand: 'create',
      flags: { name: 'worker' },
    })
  })

  it('builds rotateApplicationSecret with the generated secret, never minting in the control plane', () => {
    expect(CONTROL_CAPABILITIES.rotateApplicationSecret.buildInvocation({ application_id: 'app-1' }, gen)).toEqual({
      command: 'app',
      subcommand: 'patch',
      flags: { id: 'app-1', 'client-secret': 'cs_generated_secret' },
    })
  })

  it('builds deleteApplication from the application id', () => {
    expect(CONTROL_CAPABILITIES.deleteApplication.buildInvocation({ application_id: 'app-1' }, gen)).toEqual({
      command: 'app',
      subcommand: 'delete',
      flags: { id: 'app-1' },
    })
  })

  it('builds grantAccess with the hyphenated control flag names', () => {
    expect(
      CONTROL_CAPABILITIES.grantAccess.buildInvocation(
        { application_id: 'app-1', user_id: 'user-1', resource_id: 'res-1', scopes: ['invoices:read'] },
        gen,
      ),
    ).toEqual({
      command: 'grant',
      subcommand: 'create',
      flags: { 'application-id': 'app-1', 'user-id': 'user-1', 'resource-id': 'res-1', scopes: ['invoices:read'] },
    })
  })

  it('builds reads with no flags', () => {
    expect(CONTROL_CAPABILITIES.listApplications.buildInvocation({}, gen).flags).toEqual({})
    expect(CONTROL_CAPABILITIES.listProviders.buildInvocation({}, gen).flags).toEqual({})
    expect(CONTROL_CAPABILITIES.listResources.buildInvocation({}, gen).flags).toEqual({})
    expect(CONTROL_CAPABILITIES.listPolicies.buildInvocation({}, gen).flags).toEqual({})
  })
})

describe('describeOutcome', () => {
  it('surfaces the issued application secret as a one-time output only', () => {
    const outcome = CONTROL_CAPABILITIES.registerApplication.describeOutcome(
      { id: 'app-1', name: 'worker', client_secret: 'cs_issued' },
      { name: 'worker' },
      gen,
    )
    expect(outcome.detail).not.toContain('cs_issued')
    expect(outcome.output).toEqual({ application_id: 'app-1', client_secret: 'cs_issued' })
  })

  it('returns the generated secret as the rotation output and keeps it out of the detail', () => {
    const outcome = CONTROL_CAPABILITIES.rotateApplicationSecret.describeOutcome(
      { id: 'app-1', name: 'worker' },
      { application_id: 'app-1' },
      gen,
    )
    expect(outcome.detail).not.toContain('cs_generated_secret')
    expect(outcome.output).toEqual({ application_id: 'app-1', client_secret: 'cs_generated_secret' })
  })

  it('surfaces the grant id', () => {
    const outcome = CONTROL_CAPABILITIES.grantAccess.describeOutcome(
      { id: 'grant-1' },
      { application_id: 'app-1', user_id: 'user-1', resource_id: 'res-1', scopes: ['invoices:read'] },
      gen,
    )
    expect(outcome.detail).toContain('invoices:read')
    expect(outcome.output).toEqual({ grant_id: 'grant-1' })
  })

  it('reports the deleted application id', () => {
    const outcome = CONTROL_CAPABILITIES.deleteApplication.describeOutcome(undefined, { application_id: 'app-1' }, gen)
    expect(outcome.detail).toContain('app-1')
    expect(outcome.output).toEqual({ application_id: 'app-1' })
  })

  it('counts read results with correct pluralization', () => {
    expect(CONTROL_CAPABILITIES.listApplications.describeOutcome([{ id: 'a' }, { id: 'b' }], {}, gen).detail).toBe(
      'Found 2 applications in this zone.',
    )
    expect(CONTROL_CAPABILITIES.listProviders.describeOutcome([], {}, gen).detail).toBe('Found 0 providers in this zone.')
    expect(CONTROL_CAPABILITIES.listResources.describeOutcome([{ id: 'r' }], {}, gen).detail).toBe('Found 1 resource in this zone.')
    expect(CONTROL_CAPABILITIES.listPolicies.describeOutcome([{ id: 'p' }, { id: 'q' }], {}, gen).detail).toBe(
      'Found 2 policies in this zone.',
    )
  })

  it('surfaces read rows under their named output key', () => {
    const resources = [{ id: 'r1', identifier: 'res://a' }]
    expect(CONTROL_CAPABILITIES.listResources.describeOutcome(resources, {}, gen).output).toEqual({ resources })
    const policies = [{ id: 'p1', name: 'binding', description: null }]
    expect(CONTROL_CAPABILITIES.listPolicies.describeOutcome(policies, {}, gen).output).toEqual({ policies })
  })
})
