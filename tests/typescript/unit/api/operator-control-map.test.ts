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
    expect(isControlExecutable('deleteResource')).toBe(true)
    expect(isControlExecutable('deleteProvider')).toBe(true)
    expect(isControlExecutable('deletePolicy')).toBe(true)
    expect(isControlExecutable('revokeGrant')).toBe(true)
    expect(isControlExecutable('listGrants')).toBe(true)
    expect(isControlExecutable('defineResource')).toBe(true)
    expect(isControlExecutable('createPolicy')).toBe(true)
    expect(isControlExecutable('versionPolicy')).toBe(true)
    expect(isControlExecutable('createPolicySet')).toBe(true)
    expect(isControlExecutable('versionPolicySet')).toBe(true)
    expect(isControlExecutable('activatePolicySet')).toBe(true)
    // Zone lifecycle is a platform operation, not governed-executable by the Operator.
    expect(isControlExecutable('createZone')).toBe(false)
    expect(isControlExecutable('listZones')).toBe(false)
    // Read-only explanation is not a control command.
    expect(isControlExecutable('explainAccess')).toBe(false)
    // Connecting a credential-free provider is a thin create the Operator applies directly.
    expect(isControlExecutable('connectProvider')).toBe(true)
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

  it('builds in-zone removes from the object id', () => {
    expect(CONTROL_CAPABILITIES.deleteResource.buildInvocation({ resource_id: 'res-1' }, gen)).toEqual({
      command: 'resource',
      subcommand: 'delete',
      flags: { id: 'res-1' },
    })
    expect(CONTROL_CAPABILITIES.deleteProvider.buildInvocation({ provider_id: 'prov-1' }, gen)).toEqual({
      command: 'identity-provider',
      subcommand: 'delete',
      flags: { id: 'prov-1' },
    })
    expect(CONTROL_CAPABILITIES.deletePolicy.buildInvocation({ policy_id: 'pol-1' }, gen)).toEqual({
      command: 'policy',
      subcommand: 'delete',
      flags: { id: 'pol-1' },
    })
    expect(CONTROL_CAPABILITIES.revokeGrant.buildInvocation({ grant_id: 'grant-1' }, gen)).toEqual({
      command: 'grant',
      subcommand: 'revoke',
      flags: { id: 'grant-1' },
    })
  })

  it('builds defineResource from the name and scopes', () => {
    expect(
      CONTROL_CAPABILITIES.defineResource.buildInvocation({ name: 'FinXpert', scopes: ['finxpert.read', 'finxpert.write'] }, gen),
    ).toEqual({
      command: 'resource',
      subcommand: 'create',
      flags: { name: 'FinXpert', scopes: ['finxpert.read', 'finxpert.write'] },
    })
  })

  it('builds connectProvider from the name and kind, letting the control plane derive the identifier', () => {
    expect(CONTROL_CAPABILITIES.connectProvider.buildInvocation({ name: 'FinXpert Mandate', kind: 'caracal_mandate' }, gen)).toEqual({
      command: 'identity-provider',
      subcommand: 'create',
      flags: { name: 'FinXpert Mandate', kind: 'caracal_mandate' },
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

  it('builds createPolicy with the authored document and hyphenated schema flag', () => {
    expect(
      CONTROL_CAPABILITIES.createPolicy.buildInvocation(
        { name: 'PiperNet baseline', description: 'read for operators', content: 'package caracal.authz', schema_version: '2026-05-01' },
        gen,
      ),
    ).toEqual({
      command: 'policy',
      subcommand: 'create',
      flags: { name: 'PiperNet baseline', description: 'read for operators', content: 'package caracal.authz', 'schema-version': '2026-05-01' },
    })
  })

  it('omits optional createPolicy flags when absent', () => {
    expect(CONTROL_CAPABILITIES.createPolicy.buildInvocation({ name: 'PiperNet baseline', content: 'package caracal.authz' }, gen)).toEqual({
      command: 'policy',
      subcommand: 'create',
      flags: { name: 'PiperNet baseline', content: 'package caracal.authz' },
    })
  })

  it('builds versionPolicy against the existing policy id', () => {
    expect(
      CONTROL_CAPABILITIES.versionPolicy.buildInvocation({ policy_id: 'pol-1', content: 'package caracal.authz', schema_version: '2026-05-01' }, gen),
    ).toEqual({
      command: 'policy',
      subcommand: 'version',
      flags: { id: 'pol-1', content: 'package caracal.authz', 'schema-version': '2026-05-01' },
    })
  })

  it('builds createPolicySet from the name', () => {
    expect(CONTROL_CAPABILITIES.createPolicySet.buildInvocation({ name: 'PiperNet baseline v3' }, gen)).toEqual({
      command: 'policy-set',
      subcommand: 'create',
      flags: { name: 'PiperNet baseline v3' },
    })
  })

  it('builds versionPolicySet with the composed policy versions', () => {
    expect(
      CONTROL_CAPABILITIES.versionPolicySet.buildInvocation({ policy_set_id: 'set-1', policy_version_ids: ['pv-1', 'pv-2'] }, gen),
    ).toEqual({
      command: 'policy-set',
      subcommand: 'version',
      flags: { id: 'set-1', 'policy-versions': ['pv-1', 'pv-2'] },
    })
  })

  it('builds activatePolicySet from the set and version ids', () => {
    expect(
      CONTROL_CAPABILITIES.activatePolicySet.buildInvocation({ policy_set_id: 'set-1', policy_set_version_id: 'sv-1' }, gen),
    ).toEqual({
      command: 'policy-set',
      subcommand: 'activate',
      flags: { id: 'set-1', version: 'sv-1' },
    })
  })

  it('builds reads with no flags', () => {
    expect(CONTROL_CAPABILITIES.listApplications.buildInvocation({}, gen).flags).toEqual({})
    expect(CONTROL_CAPABILITIES.listProviders.buildInvocation({}, gen).flags).toEqual({})
    expect(CONTROL_CAPABILITIES.listResources.buildInvocation({}, gen).flags).toEqual({})
    expect(CONTROL_CAPABILITIES.listPolicies.buildInvocation({}, gen).flags).toEqual({})
    expect(CONTROL_CAPABILITIES.listGrants.buildInvocation({}, gen).flags).toEqual({})
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

  it('surfaces the resource id and names its scopes', () => {
    const outcome = CONTROL_CAPABILITIES.defineResource.describeOutcome(
      { id: 'res-1', identifier: 'resource://finxpert' },
      { name: 'FinXpert', scopes: ['finxpert.read', 'finxpert.write'] },
      gen,
    )
    expect(outcome.detail).toContain('finxpert.read')
    expect(outcome.detail).toContain('finxpert.write')
    expect(outcome.output).toEqual({ resource_id: 'res-1' })
  })

  it('surfaces the provider id and names its kind', () => {
    const outcome = CONTROL_CAPABILITIES.connectProvider.describeOutcome(
      { id: 'prov-1', identifier: 'provider://finxpert-mandate' },
      { name: 'FinXpert Mandate', kind: 'caracal_mandate' },
      gen,
    )
    expect(outcome.detail).toContain('caracal_mandate')
    expect(outcome.output).toEqual({ provider_id: 'prov-1' })
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

  it('reports the removed object id under its argument key', () => {
    expect(CONTROL_CAPABILITIES.deleteResource.describeOutcome(undefined, { resource_id: 'res-1' }, gen).output).toEqual({
      resource_id: 'res-1',
    })
    expect(CONTROL_CAPABILITIES.deleteProvider.describeOutcome(undefined, { provider_id: 'prov-1' }, gen).output).toEqual({
      provider_id: 'prov-1',
    })
    expect(CONTROL_CAPABILITIES.deletePolicy.describeOutcome(undefined, { policy_id: 'pol-1' }, gen).output).toEqual({
      policy_id: 'pol-1',
    })
    const revoked = CONTROL_CAPABILITIES.revokeGrant.describeOutcome(undefined, { grant_id: 'grant-1' }, gen)
    expect(revoked.detail).toContain('grant-1')
    expect(revoked.output).toEqual({ grant_id: 'grant-1' })
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
    expect(CONTROL_CAPABILITIES.listGrants.describeOutcome([{ id: 'g' }], {}, gen).detail).toBe('Found 1 grant in this zone.')
  })

  it('surfaces read rows under their named output key', () => {
    const resources = [{ id: 'r1', identifier: 'res://a' }]
    expect(CONTROL_CAPABILITIES.listResources.describeOutcome(resources, {}, gen).output).toEqual({ resources })
    const policies = [{ id: 'p1', name: 'binding', description: null }]
    expect(CONTROL_CAPABILITIES.listPolicies.describeOutcome(policies, {}, gen).output).toEqual({ policies })
  })

  it('surfaces the created policy id and its sealed first version id', () => {
    const outcome = CONTROL_CAPABILITIES.createPolicy.describeOutcome(
      { id: 'pol-1', name: 'PiperNet baseline', version_id: 'pv-1', version: 1 },
      { name: 'PiperNet baseline', content: 'package caracal.authz' },
      gen,
    )
    expect(outcome.detail).toContain('PiperNet baseline')
    expect(outcome.detail).not.toContain('package caracal.authz')
    expect(outcome.output).toEqual({ policy_id: 'pol-1', policy_version_id: 'pv-1' })
  })

  it('surfaces the newly sealed policy version id under the existing policy id', () => {
    const outcome = CONTROL_CAPABILITIES.versionPolicy.describeOutcome(
      { version_id: 'pv-2', version: 2 },
      { policy_id: 'pol-1', content: 'package caracal.authz' },
      gen,
    )
    expect(outcome.detail).toContain('pol-1')
    expect(outcome.output).toEqual({ policy_id: 'pol-1', policy_version_id: 'pv-2' })
  })

  it('surfaces the created policy set id', () => {
    const outcome = CONTROL_CAPABILITIES.createPolicySet.describeOutcome(
      { id: 'set-1', name: 'PiperNet baseline v3' },
      { name: 'PiperNet baseline v3' },
      gen,
    )
    expect(outcome.detail).toContain('PiperNet baseline v3')
    expect(outcome.output).toEqual({ policy_set_id: 'set-1' })
  })

  it('surfaces the sealed policy set version id under the set id', () => {
    const outcome = CONTROL_CAPABILITIES.versionPolicySet.describeOutcome(
      { version_id: 'sv-1', version: 1 },
      { policy_set_id: 'set-1', policy_version_ids: ['pv-1'] },
      gen,
    )
    expect(outcome.detail).toContain('set-1')
    expect(outcome.output).toEqual({ policy_set_id: 'set-1', policy_set_version_id: 'sv-1' })
  })

  it('reports the activated policy set and version from the arguments', () => {
    const outcome = CONTROL_CAPABILITIES.activatePolicySet.describeOutcome(
      { activated: true, version_id: 'sv-1', shadow_version_id: null },
      { policy_set_id: 'set-1', policy_set_version_id: 'sv-1' },
      gen,
    )
    expect(outcome.detail).toContain('set-1')
    expect(outcome.detail).toContain('sv-1')
    expect(outcome.output).toEqual({ policy_set_id: 'set-1', policy_set_version_id: 'sv-1' })
  })
})
