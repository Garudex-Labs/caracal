// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// The Caracal-governed autopilot evaluator: decides deterministically whether a plan's human approval step may be auto-satisfied, never by the model.

import { CAPABILITIES } from './operator-capabilities.js'
import { isControlExecutable } from './operator-control-map.js'
import type { PlanPreview } from './operator-preview.js'
import type { SecurityAdvisory } from './operator-agents.js'

// Capabilities that always require a human even if a deployment allowlists them. Granting access
// and rotating a credential are the high-blast-radius, "major" changes the autopilot floor must
// never auto-approve: a grant authorizes new access, and a rotation changes a live credential. The
// floor is enforced both when an autopilot policy is built (allowlisting one is a configuration
// error) and again in the evaluator, so a denied capability can never be auto-approved even if a
// policy were constructed another way.
export const AUTOPILOT_DENIED_CAPABILITIES: ReadonlySet<string> = new Set(['grantAccess', 'rotateApplicationSecret'])

// The Caracal-side autopilot policy: the deployment-set boundary of what may ever be
// auto-approved. enabled is the master kill switch — false disables all auto-approval regardless
// of any conversation's engage flag. capabilities is the explicit allowlist of low-risk
// capabilities; empty means nothing is auto-approvable. maxStepsPerPlan bounds a single plan's
// blast radius, and windowMaxApprovals over windowSec bounds how many auto-approvals a
// conversation may accrue in a rolling window. Every field defaults to the safe direction so
// autopilot approves nothing until a deployment explicitly, narrowly enables it.
export interface AutopilotPolicy {
  enabled: boolean
  capabilities: ReadonlySet<string>
  maxStepsPerPlan: number
  windowSec: number
  windowMaxApprovals: number
}

export interface AutopilotPolicyInput {
  enabled?: boolean
  capabilities?: string[] | null
  maxStepsPerPlan?: number
  windowSec?: number
  windowMaxApprovals?: number
}

// Builds the autopilot policy from configuration, failing closed on any misconfiguration so an
// unsafe policy never silently takes effect. An allowlisted capability must be a known, mutating,
// governed-executable capability that is not on the denied floor: a read-only capability needs no
// approval, a non-executable one can never be applied, and a denied one is a major change that
// always requires a human. Numeric bounds are clamped to safe minimums.
export function buildAutopilotPolicy(input: AutopilotPolicyInput = {}): AutopilotPolicy {
  const capabilities = new Set<string>()
  for (const id of input.capabilities ?? []) {
    const capability = CAPABILITIES[id]
    if (!capability) {
      throw new Error(`autopilot policy: unknown capability '${id}'`)
    }
    if (!capability.mutating) {
      throw new Error(`autopilot policy: capability '${id}' is read-only and needs no approval`)
    }
    if (!isControlExecutable(id)) {
      throw new Error(`autopilot policy: capability '${id}' is not governed-executable and can never be auto-applied`)
    }
    if (AUTOPILOT_DENIED_CAPABILITIES.has(id)) {
      throw new Error(`autopilot policy: capability '${id}' is a major change that always requires human approval`)
    }
    capabilities.add(id)
  }
  return {
    enabled: input.enabled ?? false,
    capabilities,
    maxStepsPerPlan: Math.max(1, Math.trunc(input.maxStepsPerPlan ?? 1)),
    windowSec: Math.max(0, Math.trunc(input.windowSec ?? 3600)),
    windowMaxApprovals: Math.max(0, Math.trunc(input.windowMaxApprovals ?? 10)),
  }
}

// Whether autopilot is available at all for this deployment: the master switch is on and the
// allowlist is non-empty. Used to surface autopilot's availability without exposing the policy,
// and to skip evaluation cheaply when it could never approve anything.
export function autopilotAvailable(policy: AutopilotPolicy): boolean {
  return policy.enabled && policy.capabilities.size > 0
}

// The evidence the evaluator judges, gathered by the route from the same deterministic spine that
// governs a human approval: the conversation's engage flag, the plan's steps, the live preview,
// the advisory security review if one was produced, and how many auto-approvals this conversation
// has already accrued in the rolling window.
export interface AutopilotEvaluation {
  engaged: boolean
  steps: { id: string; capability: string }[]
  preview: PlanPreview
  advisory: SecurityAdvisory | undefined
  recentAutoApprovals: number
}

// The decision: either the approval step may be auto-satisfied, or it must stop for a human with a
// machine-readable reason. The reason is recorded so an operator can see exactly why autopilot did
// or did not act.
export type AutopilotDecision = { autoApprove: true } | { autoApprove: false; reason: string }

const CLEAN_EFFECTS: ReadonlySet<string> = new Set(['create', 'update', 'read_only'])

// Decides whether a plan's human approval may be auto-satisfied. Every condition is evaluated by
// Caracal deterministically — the model proposed the plan but has no say here. Auto-approval
// requires, in order: the master switch on; the conversation engaged; a non-empty plan within the
// per-plan step bound; the rolling window budget not exhausted; a clean preview (every step
// resolves to a create, update, or read-only effect — never blocked, drift, or an already-existing
// target); every capability on the allowlist and off the denied floor; and no advisory warning.
// Any single failure stops for a human, which is the safe direction; only an all-clear plan that a
// deployment pre-authorized as low-risk is ever auto-approved.
export function mayAutoApprove(evaluation: AutopilotEvaluation, policy: AutopilotPolicy): AutopilotDecision {
  if (!policy.enabled) return { autoApprove: false, reason: 'autopilot_disabled' }
  if (!evaluation.engaged) return { autoApprove: false, reason: 'autopilot_not_engaged' }

  const steps = evaluation.steps
  if (steps.length === 0) return { autoApprove: false, reason: 'empty_plan' }
  if (steps.length > policy.maxStepsPerPlan) return { autoApprove: false, reason: 'exceeds_max_steps' }
  if (evaluation.recentAutoApprovals >= policy.windowMaxApprovals) {
    return { autoApprove: false, reason: 'window_budget_exhausted' }
  }

  if (!evaluation.preview.ok) return { autoApprove: false, reason: 'preview_not_clean' }
  const effectById = new Map(evaluation.preview.steps.map((step) => [step.id, step.effect]))
  for (const step of steps) {
    if (AUTOPILOT_DENIED_CAPABILITIES.has(step.capability)) {
      return { autoApprove: false, reason: 'capability_requires_human' }
    }
    if (!policy.capabilities.has(step.capability)) {
      return { autoApprove: false, reason: 'capability_not_allowlisted' }
    }
    const effect = effectById.get(step.id)
    if (effect === undefined || !CLEAN_EFFECTS.has(effect)) {
      return { autoApprove: false, reason: 'preview_not_clean' }
    }
  }

  if (evaluation.advisory && evaluation.advisory.findings.some((finding) => finding.severity === 'warning')) {
    return { autoApprove: false, reason: 'security_warning' }
  }

  return { autoApprove: true }
}
