// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// The Caracal-governed autopilot evaluator: decides deterministically whether a plan's human approval step may be auto-satisfied, never by the model.

// The Caracal-side autopilot policy: the deployment master switch for auto-approval. enabled is the
// kill switch — false disables all auto-approval regardless of any conversation's engage flag, and
// defaults off so a deployment opts in explicitly before autopilot can ever act.
export interface AutopilotPolicy {
  enabled: boolean
}

export interface AutopilotPolicyInput {
  enabled?: boolean
}

// Builds the autopilot policy from configuration. The master switch defaults off so autopilot is
// unavailable until a deployment turns it on.
export function buildAutopilotPolicy(input: AutopilotPolicyInput = {}): AutopilotPolicy {
  return { enabled: input.enabled ?? false }
}

// Whether autopilot is available at all for this deployment: the master switch is on. Used to
// surface availability to the console and to skip evaluation cheaply when it is off.
export function autopilotAvailable(policy: AutopilotPolicy): boolean {
  return policy.enabled
}

// The evidence the evaluator judges: the conversation's engage flag, whether the plan's own
// deterministic preview says it can apply, and the plan's steps. The plan was proposed by the model
// but the decision is Caracal's alone.
export interface AutopilotEvaluation {
  engaged: boolean
  applicable: boolean
  steps: { id: string; capability: string }[]
}

// The decision: either the approval step may be auto-satisfied, or it must stop for a human with a
// machine-readable reason recorded so an operator can see why autopilot did or did not act.
export type AutopilotDecision = { autoApprove: true } | { autoApprove: false; reason: string }

// Decides whether a plan's human approval may be auto-satisfied. With the master switch on and the
// conversation engaged, a non-empty plan whose preview says it can apply is auto-approved: an
// engaged conversation has opted into acting without a human in the loop. A plan the deterministic
// preview already marks unapplicable — a blocked step whose target cannot exist when the plan runs —
// is never auto-approved: it would only fail on apply, so it stops for a human who can see why.
// Authority is never widened — the governed execute path still enforces the capability allowlist,
// least-privilege executor token, and zone isolation when the plan is applied, so autopilot removes
// the approval step, never the deterministic controls.
export function mayAutoApprove(evaluation: AutopilotEvaluation, policy: AutopilotPolicy): AutopilotDecision {
  if (!policy.enabled) return { autoApprove: false, reason: 'autopilot_disabled' }
  if (!evaluation.engaged) return { autoApprove: false, reason: 'autopilot_not_engaged' }
  if (evaluation.steps.length === 0) return { autoApprove: false, reason: 'empty_plan' }
  if (!evaluation.applicable) return { autoApprove: false, reason: 'plan_not_applicable' }
  return { autoApprove: true }
}
