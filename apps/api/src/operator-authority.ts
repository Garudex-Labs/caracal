// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// The reserved, least-privilege Operator identity and the authority checks that bound what it may execute and where.

import { CAPABILITIES } from './operator-capabilities.js'
import { isControlExecutable } from './operator-control-map.js'

// The reserved principal the Operator executes as. It is distinct from the human
// operator who approves a plan: the human's authorization is recorded in the admin
// audit log, while this principal records the attenuated authority that actually
// applied the change - the Operator's own delegated identity, dogfooding Caracal's
// delegation model against itself.
export const OPERATOR_PRINCIPAL = 'system:caracal-operator'

export interface OperatorAuthority {
  principal: string
  // The capabilities the Operator is permitted to execute. A strict subset of the
  // catalog: read-only capabilities are always permitted because they change
  // nothing, so this set governs mutating capabilities only.
  allowedCapabilities: ReadonlySet<string>
  // Zones the Operator must never operate in. The isolation boundary that keeps the
  // Operator away from system infrastructure even though it holds operator authority.
  systemZones: ReadonlySet<string>
}

// The least-privilege default: exactly the mutating capabilities that are governed-
// executable through the control plane. The Operator cannot execute a newly added
// capability until it is both mapped to a governed control command and explicitly
// granted, so the catalog can grow without silently widening the Operator's authority.
function defaultAllowedCapabilities(): Set<string> {
  const allowed = new Set<string>()
  for (const capability of Object.values(CAPABILITIES)) {
    if (capability.mutating && isControlExecutable(capability.id)) allowed.add(capability.id)
  }
  return allowed
}

export interface OperatorAuthorityInput {
  allowedCapabilities?: string[] | null
  systemZones?: string[] | null
}

// Resolves the Operator authority from configuration, failing closed on any
// misconfiguration: an allowed capability that is unknown or non-mutating is a
// configuration error rather than a silently ignored entry.
export function buildOperatorAuthority(input: OperatorAuthorityInput = {}): OperatorAuthority {
  let allowed: Set<string>
  if (input.allowedCapabilities && input.allowedCapabilities.length > 0) {
    allowed = new Set<string>()
    for (const id of input.allowedCapabilities) {
      const capability = CAPABILITIES[id]
      if (!capability) {
        throw new Error(`operator authority: unknown capability '${id}'`)
      }
      if (!capability.mutating) {
        throw new Error(`operator authority: capability '${id}' is read-only and need not be granted`)
      }
      allowed.add(id)
    }
  } else {
    allowed = defaultAllowedCapabilities()
  }

  return {
    principal: OPERATOR_PRINCIPAL,
    allowedCapabilities: allowed,
    systemZones: new Set(input.systemZones ?? []),
  }
}

export function isZoneIsolated(authority: OperatorAuthority, zoneId: string): boolean {
  return authority.systemZones.has(zoneId)
}

export type AuthorityDenialCode = 'capability_forbidden' | 'capability_unknown'

export interface AuthorityDecision {
  ok: boolean
  code?: AuthorityDenialCode
  message?: string
}

// Decides whether the Operator may execute a single capability. Read-only
// capabilities are always permitted; mutating capabilities must be in the granted
// set. Unknown capabilities are denied, so the check fails closed.
export function authorizeCapability(authority: OperatorAuthority, capabilityId: string): AuthorityDecision {
  const capability = CAPABILITIES[capabilityId]
  if (!capability) {
    return { ok: false, code: 'capability_unknown', message: `unknown capability '${capabilityId}'` }
  }
  if (!capability.mutating) return { ok: true }
  if (authority.allowedCapabilities.has(capabilityId)) return { ok: true }
  return {
    ok: false,
    code: 'capability_forbidden',
    message: `the Operator is not authorized to execute '${capabilityId}'`,
  }
}

export interface StepAuthorityDenial {
  step_id: string
  capability: string
  code: AuthorityDenialCode
  message: string
}

// Returns one denial per step the Operator is not authorized to execute. An empty
// result means every step is within the Operator's granted authority.
export function authorizePlanSteps(authority: OperatorAuthority, steps: { id: string; capability: string }[]): StepAuthorityDenial[] {
  const denials: StepAuthorityDenial[] = []
  for (const step of steps) {
    const decision = authorizeCapability(authority, step.capability)
    if (!decision.ok) {
      denials.push({
        step_id: step.id,
        capability: step.capability,
        code: decision.code!,
        message: decision.message!,
      })
    }
  }
  return denials
}
