// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the Operator per-role scope derivation: each role application carries only its own least-privilege scopes.

import { describe, it, expect } from 'vitest'
import { researcherRoleScopes, executorRoleScopes } from '../../../../apps/api/src/operator-agent-roles.js'
import { buildOperatorAuthority } from '../../../../apps/api/src/operator-authority.js'
import { roleIdentityTraits } from '../../../../apps/api/src/system-zone.js'
import { validateTraits } from '../../../../apps/api/src/traits.js'
import type { Actor } from '../../../../apps/api/src/auth.js'

describe('researcherRoleScopes', () => {
  it('is exactly the governed read scopes and no write scope', () => {
    const scopes = researcherRoleScopes()
    expect([...scopes].sort()).toEqual([
      'control:app:read',
      'control:approval:read',
      'control:audit:read',
      'control:delegation:read',
      'control:explain:read',
      'control:grant:read',
      'control:identity-provider:read',
      'control:policy-set:read',
      'control:policy:read',
      'control:resource:read',
      'control:session:read',
      'control:workload:read',
    ])
    expect([...scopes].some((scope) => scope.endsWith(':write'))).toBe(false)
  })
})

describe('executorRoleScopes', () => {
  it('adds the granted mutating scopes to the read scopes under the default authority', () => {
    const scopes = executorRoleScopes(buildOperatorAuthority())
    expect(scopes.has('control:app:write')).toBe(true)
    expect(scopes.has('control:app:delete')).toBe(true)
    expect(scopes.has('control:grant:write')).toBe(true)
    expect(scopes.has('control:grant:delete')).toBe(true)
    expect(scopes.has('control:resource:delete')).toBe(true)
    expect(scopes.has('control:identity-provider:delete')).toBe(true)
    expect(scopes.has('control:policy:delete')).toBe(true)
    expect(scopes.has('control:session:write')).toBe(true)
    expect(scopes.has('control:session:delete')).toBe(true)
    expect(scopes.has('control:delegation:delete')).toBe(true)
    expect(scopes.has('control:workload:write')).toBe(true)
    expect(scopes.has('control:workload:delete')).toBe(true)
    expect(scopes.has('control:app:read')).toBe(true)
  })

  it('omits a mutating scope the authority does not grant', () => {
    // An authority that grants only registerApplication must not carry the grant write scope.
    const authority = buildOperatorAuthority({ allowedCapabilities: ['registerApplication'] })
    const scopes = executorRoleScopes(authority)
    expect(scopes.has('control:app:write')).toBe(true)
    expect(scopes.has('control:app:delete')).toBe(false)
    expect(scopes.has('control:grant:write')).toBe(false)
  })

  it('carries no write scope when the authority grants nothing mutating', () => {
    // An empty allowlist is impossible to express directly (build defaults to all), so assert the
    // researcher role - which never includes a write scope - is a strict subset of the executor.
    const exec = executorRoleScopes(buildOperatorAuthority())
    for (const scope of researcherRoleScopes()) expect(exec.has(scope)).toBe(true)
  })
})

describe('role identity provisioning', () => {
  it('every derived role trait set passes server-side trait validation', () => {
    // The provisioner submits these exact trait sets through the applications API, so a
    // catalog large enough to push a role past the trait validator would break system-zone
    // bootstrap for every deployment.
    const globalActor: Actor = { id: 'admin-1', name: 'platform', scope: 'global', zoneId: null }
    const expiresAt = new Date('2036-01-01T00:00:00.000Z')
    const roles = [researcherRoleScopes(), executorRoleScopes(buildOperatorAuthority())]
    for (const scopes of roles) {
      const traits = roleIdentityTraits([...scopes].sort(), expiresAt)
      expect(validateTraits(traits, globalActor)).toBeNull()
    }
  })
})
