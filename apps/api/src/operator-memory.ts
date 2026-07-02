// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Deterministic conversation memory: compresses a long Operator history into a bounded set of facts.

import type { TurnRecord } from './operator-state.js'

// A decided plan, reduced to its outcome. The detail an agent needs to maintain
// continuity without replaying the plan's full step list.
export interface DecidedPlanFact {
  seq: number
  summary: string
  decision: 'approved' | 'rejected'
  executed: boolean
  steps_succeeded: number
  steps_failed: number
}

// The compressed memory of everything before the recent window. Bounded in size
// regardless of conversation length, so an agent's context cost does not grow with
// the history — the architecture's compress-to-facts in place of an ever-growing
// transcript.
export interface ConversationFacts {
  decided_plans: DecidedPlanFact[]
  // Capabilities that appeared in plans the operator rejected. Carried so the
  // planner does not re-propose an operation the operator has already turned down.
  rejected_capabilities: string[]
  // Total steps that have been successfully applied across the whole session.
  applied_change_count: number
  // The most recent post-apply verification, but only when it reported drift: an
  // applied change whose live state diverged from the plan's intent. Carried so the
  // planner reconciles an outstanding drift instead of re-creating over it. A later
  // verification that matched supersedes it, so a reconciled drift stops being carried.
  last_drift: { seq: number; summary: string } | null
  last_error: { seq: number; message: string } | null
}

const DEFAULT_PLAN_CAP = 10

interface PlanAccumulator {
  seq: number
  summary: string
  capabilities: string[]
  decision: 'pending' | 'approved' | 'rejected'
  succeeded: number
  failed: number
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

// Folds the full ordered turn history into a compact facts object. Plans are matched
// with their decisions and executions; only decided plans become facts, capped to
// the most recent so the result stays small for arbitrarily long conversations.
export function summarizeHistory(turns: TurnRecord[], options: { planCap?: number } = {}): ConversationFacts {
  const ordered = [...turns].sort((a, b) => a.seq - b.seq)
  const planCap = Math.max(1, options.planCap ?? DEFAULT_PLAN_CAP)

  const plans = new Map<number, PlanAccumulator>()
  let appliedChangeCount = 0
  let lastError: ConversationFacts['last_error'] = null
  let lastVerification: { seq: number; status: string; summary: string } | null = null

  for (const turn of ordered) {
    const content = asRecord(turn.content)
    if (turn.kind === 'plan') {
      const steps = Array.isArray(content.steps) ? content.steps : []
      plans.set(turn.seq, {
        seq: turn.seq,
        summary: asString(content.summary),
        capabilities: steps.map((raw) => asString(asRecord(raw).capability)).filter((c) => c.length > 0),
        decision: 'pending',
        succeeded: 0,
        failed: 0,
      })
    } else if (turn.kind === 'approval') {
      const plan = plans.get(Number(content.plan_seq))
      if (plan) plan.decision = 'approved'
    } else if (turn.kind === 'rejection') {
      const plan = plans.get(Number(content.plan_seq))
      if (plan) plan.decision = 'rejected'
    } else if (turn.kind === 'execution') {
      const plan = plans.get(Number(content.plan_seq))
      if (content.status === 'failed') {
        if (plan) plan.failed += 1
      } else {
        appliedChangeCount += 1
        if (plan) plan.succeeded += 1
      }
    } else if (turn.kind === 'error') {
      lastError = { seq: turn.seq, message: asString(content.message) }
    } else if (turn.kind === 'note') {
      const status = asString(asRecord(content.verification).status)
      if (status) lastVerification = { seq: turn.seq, status, summary: asString(asRecord(content.verification).summary) }
    }
  }

  const decided: DecidedPlanFact[] = []
  const rejected = new Set<string>()
  for (const plan of plans.values()) {
    if (plan.decision === 'pending') continue
    decided.push({
      seq: plan.seq,
      summary: plan.summary,
      decision: plan.decision,
      executed: plan.succeeded + plan.failed > 0,
      steps_succeeded: plan.succeeded,
      steps_failed: plan.failed,
    })
    if (plan.decision === 'rejected') {
      for (const capability of plan.capabilities) rejected.add(capability)
    }
  }

  decided.sort((a, b) => a.seq - b.seq)
  const cappedPlans = decided.slice(-planCap)

  return {
    decided_plans: cappedPlans,
    rejected_capabilities: [...rejected].sort(),
    applied_change_count: appliedChangeCount,
    last_drift:
      lastVerification && lastVerification.status === 'drifted' ? { seq: lastVerification.seq, summary: lastVerification.summary } : null,
    last_error: lastError,
  }
}

// Renders the facts as a compact prompt block. Returns an empty string when there is
// nothing worth carrying, so a short conversation adds no context overhead.
export function describeFacts(facts: ConversationFacts | null): string {
  if (!facts) return ''
  const lines: string[] = []
  if (facts.decided_plans.length > 0) {
    const applied = facts.decided_plans.filter((p) => p.decision === 'approved').length
    const rejectedCount = facts.decided_plans.filter((p) => p.decision === 'rejected').length
    lines.push(`${facts.decided_plans.length} earlier plan(s) decided (${applied} approved, ${rejectedCount} rejected).`)
  }
  if (facts.applied_change_count > 0) {
    lines.push(`${facts.applied_change_count} change(s) already applied in this session.`)
  }
  if (facts.rejected_capabilities.length > 0) {
    lines.push(`Previously rejected operations (do not propose again unless asked): ${facts.rejected_capabilities.join(', ')}.`)
  }
  if (facts.last_drift) {
    lines.push(
      `Most recent post-apply verification reported drift (confirm against live state and reconcile if still unresolved): ${facts.last_drift.summary}`,
    )
  }
  if (facts.last_error) {
    lines.push(`Most recent error: ${facts.last_error.message}`)
  }
  return lines.join('\n')
}
