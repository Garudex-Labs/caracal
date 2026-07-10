// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Per-agent role scope derivation for the Operator multi-agent system: each role's least-privilege scope set becomes its own Caracal application's control traits.

import { CONTROL_CAPABILITIES } from './operator-control-map.js'
import { CAPABILITIES } from './operator-capabilities.js'
import type { OperatorAuthority } from './operator-authority.js'

// The bounded principals the orchestrator spawns. researcher reads live state to ground an answer;
// executor applies an approved plan. Each is a distinct permission boundary provisioned as its own
// Caracal application, so the STS itself refuses to mint a scope outside the role's traits - a
// read worker can never mint a write token because its application was never granted one.
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
// executor by the Operator's own authority makes its application's traits a structural floor
// beneath the plan-step authority check: a mutating scope the Operator was never granted can never
// be minted, even if a step slipped past the authority check.
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
