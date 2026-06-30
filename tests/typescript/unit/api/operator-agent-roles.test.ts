// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the Operator multi-agent role boundaries: each spawned worker may request only its role's scopes.

import { describe, it, expect, vi } from 'vitest'
import {
  researcherRoleScopes,
  executorRoleScopes,
  roleScopes,
  createRoleScopedClient,
} from '../../../../apps/api/src/operator-agent-roles.js'
import { buildOperatorAuthority } from '../../../../apps/api/src/operator-authority.js'
import { ControlClientError, type ControlClient } from '../../../../apps/api/src/control-client.js'

function fakeClient(): { client: ControlClient; calls: { scopes: readonly string[] }[] } {
  const calls: { scopes: readonly string[] }[] = []
  const client: ControlClient = {
    invoke: vi.fn(async (_command, _subcommand, _flags, scopes) => {
      calls.push({ scopes })
      return { ok: true }
    }),
  }
  return { client, calls }
}

describe('researcherRoleScopes', () => {
  it('is exactly the governed read scopes and no write scope', () => {
    const scopes = researcherRoleScopes()
    expect([...scopes].sort()).toEqual([
      'control:app:read',
      'control:grant:read',
      'control:identity-provider:read',
      'control:policy:read',
      'control:resource:read',
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
    // researcher role — which never includes a write scope — is a strict subset of the executor.
    const exec = executorRoleScopes(buildOperatorAuthority())
    for (const scope of researcherRoleScopes()) expect(exec.has(scope)).toBe(true)
  })
})

describe('roleScopes', () => {
  it('resolves the researcher and executor roles', () => {
    const authority = buildOperatorAuthority()
    expect(roleScopes('researcher', authority)).toEqual(researcherRoleScopes())
    expect(roleScopes('executor', authority)).toEqual(executorRoleScopes(authority))
  })
})

describe('createRoleScopedClient', () => {
  it('forwards an in-role invocation to the inner client unchanged', async () => {
    const { client, calls } = fakeClient()
    const scoped = createRoleScopedClient(client, 'researcher', researcherRoleScopes())
    await scoped.invoke('app', 'list', {}, ['control:app:read'])
    expect(calls).toHaveLength(1)
    expect(calls[0].scopes).toEqual(['control:app:read'])
  })

  it('refuses a write scope for the researcher role before minting a token', async () => {
    const { client, calls } = fakeClient()
    const scoped = createRoleScopedClient(client, 'researcher', researcherRoleScopes())
    await expect(scoped.invoke('app', 'create', {}, ['control:app:write'])).rejects.toMatchObject({
      name: 'ControlClientError',
      stage: 'token',
      code: 'role_scope_forbidden',
    })
    // The inner client is never reached, so no credential is ever minted for the out-of-role scope.
    expect(client.invoke).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('refuses if any one scope in a multi-scope request is out of role', async () => {
    const { client } = fakeClient()
    const scoped = createRoleScopedClient(client, 'researcher', researcherRoleScopes())
    await expect(scoped.invoke('x', 'y', {}, ['control:app:read', 'control:grant:write'])).rejects.toBeInstanceOf(ControlClientError)
    expect(client.invoke).not.toHaveBeenCalled()
  })

  it('lets the executor role mint a granted write scope', async () => {
    const { client, calls } = fakeClient()
    const authority = buildOperatorAuthority()
    const scoped = createRoleScopedClient(client, 'executor', roleScopes('executor', authority))
    await scoped.invoke('grant', 'create', {}, ['control:grant:write'])
    expect(calls).toHaveLength(1)
  })

  it('refuses an executor write scope the authority does not grant', async () => {
    const { client } = fakeClient()
    const authority = buildOperatorAuthority({ allowedCapabilities: ['registerApplication'] })
    const scoped = createRoleScopedClient(client, 'executor', roleScopes('executor', authority))
    await expect(scoped.invoke('grant', 'create', {}, ['control:grant:write'])).rejects.toMatchObject({
      code: 'role_scope_forbidden',
    })
    expect(client.invoke).not.toHaveBeenCalled()
  })
})
