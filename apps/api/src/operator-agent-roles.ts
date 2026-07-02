// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Per-agent role boundaries for the Operator multi-agent system: each spawned worker runs under a control client structurally bounded to its role's scopes.

import { CONTROL_CAPABILITIES } from './operator-control-map.js'
import { CAPABILITIES } from './operator-capabilities.js'
import { ControlClientError, type ControlClient } from './control-client.js'
import type { OperatorAuthority } from './operator-authority.js'

// The bounded principals the orchestrator spawns. researcher reads live state to ground an answer;
// executor applies an approved plan. Each is a distinct role with its own least-privilege scope
// set, so a worker can only ever request the scopes its role needs - a read worker can never mint a
// write token even though it shares the Operator's underlying control identity.
export type AgentRole = 'researcher' | 'executor'

// The scopes the researcher role may ever request: exactly the scopes of the governed read
// capabilities. Derived from the catalog's mutating flag and the control mapping, never
// hand-listed, so the read role can never drift to include a write scope - a capability whose
// mutating flag flips out of the read set drops its scope from the role automatically.
export function researcherRoleScopes(): Set<string> {
  const scopes = new Set<string>()
  for (const [id, control] of Object.entries(CONTROL_CAPABILITIES)) {
    const capability = CAPABILITIES[id]
    if (capability && !capability.mutating) {
      for (const scope of control.scopes) scopes.add(scope)
    }
  }
  return scopes
}

// The scopes the executor role may ever request: the scopes of every governed read capability plus
// the scopes of the mutating capabilities the Operator's authority actually grants. Bounding the
// executor by the Operator's own authority makes the role client a structural floor beneath the
// plan-step authority check: a mutating scope the Operator was never granted can never be minted,
// even if a step slipped past the authority check.
export function executorRoleScopes(authority: OperatorAuthority): Set<string> {
  const scopes = new Set<string>()
  for (const [id, control] of Object.entries(CONTROL_CAPABILITIES)) {
    const capability = CAPABILITIES[id]
    if (!capability) continue
    if (!capability.mutating || authority.allowedCapabilities.has(id)) {
      for (const scope of control.scopes) scopes.add(scope)
    }
  }
  return scopes
}

// The scope set a role may request, resolved from the role and the Operator's authority. A single
// resolver so the spawn sites name a role, not a hand-built scope list.
export function roleScopes(role: AgentRole, authority: OperatorAuthority): Set<string> {
  return role === 'researcher' ? researcherRoleScopes() : executorRoleScopes(authority)
}

// Wraps a control client so a spawned worker can only ever invoke with scopes inside its role's
// allowed set. Any out-of-role scope is refused before a token is minted, so an out-of-role request
// never reaches the STS and no credential is ever issued for it. The refusal is a token-stage
// ControlClientError, so the executor treats it as a definitive, nothing-applied failure and the
// researcher folds it into a typed evidence entry - both existing call sites handle it unchanged.
export function createRoleScopedClient(inner: ControlClient, role: AgentRole, allowedScopes: ReadonlySet<string>): ControlClient {
  return {
    async invoke(command, subcommand, flags, scopes) {
      const forbidden = scopes.filter((scope) => !allowedScopes.has(scope))
      if (forbidden.length > 0) {
        throw new ControlClientError(
          'token',
          403,
          `the ${role} agent is not permitted the scope ${forbidden.join(', ')}`,
          'role_scope_forbidden',
        )
      }
      return inner.invoke(command, subcommand, flags, scopes)
    },
  }
}
