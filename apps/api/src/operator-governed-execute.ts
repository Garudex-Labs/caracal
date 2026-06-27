// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// The governed Operator executor: applies an approved plan's steps through the control plane as the Operator's own scoped identity, never the admin token.

import { randomBytes } from 'node:crypto'
import { CONTROL_CAPABILITIES, type ControlGen } from './operator-control-map.js'
import { ControlClientError, type ControlClient } from './control-client.js'

// One applied step: the ledger-safe detail persisted to the turn and any one-time output
// (such as an issued or rotated client secret) returned to the caller in the response
// only. Mirrors the shape the execute route records, so the route is agnostic to whether
// a step ran through the control plane or the legacy path.
export interface GovernedStepResult {
  id: string
  capability: string
  detail: string
  output?: Record<string, unknown>
}

// A step that failed to apply, carrying the structured control reason so the route can
// record a precise error turn without leaking secrets or internal error text.
export interface GovernedStepFailure {
  stepId: string
  capability: string
  reason: string
  code?: string
}

// The outcome of applying a plan through the control plane. The governed path cannot wrap
// multiple control commands in one transaction — each is its own authenticated HTTP call,
// exactly as a customer operating the control plane experiences — so a plan applies step
// by step and stops at the first failure. applied lists every step that succeeded before
// the stop; failure is the step that stopped it, or null when the whole plan applied.
export interface GovernedExecutionResult {
  applied: GovernedStepResult[]
  failure: GovernedStepFailure | null
}

export interface GovernedPlanStep {
  id: string
  capability: string
  args: Record<string, unknown>
}

// Generates a fresh high-entropy client secret, matching the format the applications
// route issues, so a rotation through the control plane sets an equivalent secret.
function generateClientSecret(): string {
  return `cs_${randomBytes(32).toString('base64url')}`
}

// Applies every step in order through the control plane as the Operator's scoped identity.
// Each step mints a token narrowed to exactly that capability's scopes and invokes the
// governed control command; the control plane authorizes, executes, and audits it. The
// model proposes and the deterministic pipeline has already validated and previewed the
// plan — this only carries each approved step to the governed surface. A control denial or
// failure stops the plan and is returned as the failure, so a plan never silently
// half-applies. genSecret is injectable for deterministic tests.
export async function executeViaControlPlane(
  client: ControlClient,
  steps: GovernedPlanStep[],
  genSecret: () => string = generateClientSecret,
): Promise<GovernedExecutionResult> {
  const applied: GovernedStepResult[] = []
  for (const step of steps) {
    const capability = CONTROL_CAPABILITIES[step.capability]
    if (!capability) {
      return {
        applied,
        failure: { stepId: step.id, capability: step.capability, reason: 'capability is not governed-executable' },
      }
    }
    const gen: ControlGen = { secret: genSecret() }
    const invocation = capability.buildInvocation(step.args, gen)
    try {
      const result = await client.invoke(invocation.command, invocation.subcommand, invocation.flags, capability.scopes)
      const outcome = capability.describeOutcome(result, step.args, gen)
      applied.push({ id: step.id, capability: step.capability, detail: outcome.detail, output: outcome.output })
    } catch (err) {
      if (err instanceof ControlClientError) {
        return { applied, failure: { stepId: step.id, capability: step.capability, reason: err.reason, code: err.code } }
      }
      const reason = err instanceof Error ? err.message : 'step failed'
      return { applied, failure: { stepId: step.id, capability: step.capability, reason } }
    }
  }
  return { applied, failure: null }
}
