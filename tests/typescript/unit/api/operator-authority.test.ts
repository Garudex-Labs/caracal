// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the reserved Operator identity and its least-privilege authority checks.

import { describe, it, expect } from 'vitest'
import {
  OPERATOR_PRINCIPAL,
  buildOperatorAuthority,
  isZoneIsolated,
  authorizeCapability,
  authorizePlanSteps,
} from '../../../../apps/api/src/operator-authority.js'

describe('buildOperatorAuthority', () => {
  it('defaults to the governed-executable mutating capabilities only', () => {
    const authority = buildOperatorAuthority()
    expect(authority.principal).toBe(OPERATOR_PRINCIPAL)
    expect([...authority.allowedCapabilities].sort()).toEqual([
      'activatePolicySet',
      'connectProvider',
      'createPolicy',
      'createPolicySet',
      'createWorkload',
      'defineResource',
      'deleteApplication',
      'deletePolicy',
      'deletePolicySet',
      'deleteProvider',
      'deleteResource',
      'deleteWorkload',
      'grantAccess',
      'registerApplication',
      'resumeAgent',
      'revokeDelegation',
      'revokeGrant',
      'rotateApplicationSecret',
      'rotateWorkloadSecret',
      'suspendAgent',
      'terminateAgent',
      'updateApplication',
      'updateProvider',
      'updateResource',
      'updateWorkload',
      'versionPolicy',
      'versionPolicySet',
    ])
    expect(authority.systemZones.size).toBe(0)
  })

  it('accepts an explicit subset grant', () => {
    const authority = buildOperatorAuthority({ allowedCapabilities: ['registerApplication'] })
    expect([...authority.allowedCapabilities]).toEqual(['registerApplication'])
  })

  it('records system zones for isolation', () => {
    const authority = buildOperatorAuthority({ systemZones: ['sys-1', 'sys-2'] })
    expect(isZoneIsolated(authority, 'sys-1')).toBe(true)
    expect(isZoneIsolated(authority, 'other')).toBe(false)
  })

  it('fails closed on an unknown granted capability', () => {
    expect(() => buildOperatorAuthority({ allowedCapabilities: ['teleport'] })).toThrow(/unknown capability/)
  })

  it('fails closed when a read-only capability is granted', () => {
    expect(() => buildOperatorAuthority({ allowedCapabilities: ['listApplications'] })).toThrow(/read-only/)
  })
})

describe('authorizeCapability', () => {
  const authority = buildOperatorAuthority()

  it('always permits read-only capabilities', () => {
    expect(authorizeCapability(authority, 'explainRequest')).toEqual({ ok: true })
    expect(authorizeCapability(authority, 'listApplications')).toEqual({ ok: true })
  })

  it('permits a granted mutating capability', () => {
    expect(authorizeCapability(authority, 'grantAccess')).toEqual({ ok: true })
  })

  it('forbids a mutating capability outside the grant', () => {
    const narrowed = buildOperatorAuthority({ allowedCapabilities: ['registerApplication'] })
    const decision = authorizeCapability(narrowed, 'grantAccess')
    expect(decision.ok).toBe(false)
    expect(decision.code).toBe('capability_forbidden')
  })

  it('denies an unknown capability', () => {
    const decision = authorizeCapability(authority, 'teleport')
    expect(decision).toMatchObject({ ok: false, code: 'capability_unknown' })
  })
})

describe('authorizePlanSteps', () => {
  it('returns one denial per forbidden step and nothing when all are permitted', () => {
    const authority = buildOperatorAuthority({ allowedCapabilities: ['grantAccess'] })
    expect(
      authorizePlanSteps(authority, [
        { id: 's1', capability: 'grantAccess' },
        { id: 's2', capability: 'explainRequest' },
      ]),
    ).toEqual([])

    const denials = authorizePlanSteps(authority, [
      { id: 's1', capability: 'grantAccess' },
      { id: 's2', capability: 'registerApplication' },
    ])
    expect(denials.map((d) => d.step_id)).toEqual(['s2'])
    expect(denials[0]).toMatchObject({ capability: 'registerApplication', code: 'capability_forbidden' })
  })
})
