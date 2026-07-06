// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// The governed Operator executor: applies an approved plan's steps through the control plane as the Operator's own scoped identity, never the admin token.

import { CONTROL_CAPABILITIES } from './operator-control-map.js'
import { CAPABILITIES, parseStepReference } from './operator-capabilities.js'
import { ControlClientError, type ControlClient } from '@caracalai/admin'

// One applied step: the ledger-safe detail persisted to the turn and any one-time output
// (such as an issued or rotated client secret) returned to the caller in the response
// only. Mirrors the shape the execute route records for each governed control-plane step.
export interface GovernedStepResult {
  id: string
  capability: string
  detail: string
  output?: Record<string, unknown>
}

// A step that failed to apply, carrying the structured control reason so the route can
// record a precise error turn without leaking secrets or internal error text. terminal is
// true when the control command may already have been applied (an ambiguous server or
// transport failure), so the plan must not be retried; it is false only when the failure
// is definitive - the token was never minted, or the control plane rejected the command -
// so nothing was applied and the plan is safe to retry.
export interface GovernedStepFailure {
  stepId: string
  capability: string
  reason: string
  code?: string
  terminal: boolean
}

// The outcome of applying a plan through the control plane. The governed path cannot wrap
// multiple control commands in one transaction - each is its own authenticated HTTP call,
// exactly as a customer operating the control plane experiences - so a plan applies wave
// by wave and stops scheduling at the first failure. applied lists every step that
// succeeded before the stop, in deterministic plan order; failure is the step that stopped
// it, or null when the whole plan applied.
export interface GovernedExecutionResult {
  applied: GovernedStepResult[]
  failure: GovernedStepFailure | null
}

export interface GovernedPlanStep {
  id: string
  capability: string
  args: Record<string, unknown>
  // Dependency step ids, validated acyclic by the catalog validator. Carries both the
  // plan's declared dependencies and those implied by step-output references. A dependency
  // naming a step outside this list was applied in a prior run and is already satisfied.
  depends_on?: string[]
  // Credentials the operator pasted through the console's secure prompt, opened from the
  // sealed vault by the execute pre-flight for exactly this step. Held in memory only and
  // merged into the control invocation; never recorded, logged, or echoed.
  secrets?: Record<string, string>
}

// Substitutes every whole-string {{steps.<id>.outputs.<key>}} reference in a step's
// arguments with the value the producing step surfaced, walking nested arrays and records.
// A reference whose output was never produced fails the step definitively - nothing was
// invoked for it - so the plan stops with a precise reason instead of sending a placeholder
// string to the control plane.
function resolveStepArgs(
  args: Record<string, unknown>,
  outputs: Map<string, Record<string, unknown>>,
): { ok: true; args: Record<string, unknown> } | { ok: false; reason: string } {
  let missing: string | null = null
  const walk = (value: unknown): unknown => {
    const ref = parseStepReference(value)
    if (ref) {
      const produced = outputs.get(ref.stepId)?.[ref.output]
      if (produced === undefined || produced === null) {
        missing ??= `step output '${ref.output}' of step '${ref.stepId}' was not produced`
        return value
      }
      return produced
    }
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, walk(item)]))
    }
    return value
  }
  const resolved = Object.fromEntries(Object.entries(args).map(([key, value]) => [key, walk(value)]))
  return missing ? { ok: false, reason: missing } : { ok: true, args: resolved }
}

// Groups the steps into dependency waves: each wave holds the steps whose dependencies are
// all satisfied by earlier waves or prior runs, in plan order, so scheduling is fully
// deterministic. The validator has already proven the graph acyclic; an unexpected cycle
// here returns null and the executor fails the plan closed rather than looping.
function dependencyWaves(steps: GovernedPlanStep[]): GovernedPlanStep[][] | null {
  const pending = new Set(steps.map((step) => step.id))
  const waves: GovernedPlanStep[][] = []
  while (pending.size > 0) {
    const wave = steps.filter((step) => pending.has(step.id) && (step.depends_on ?? []).every((dep) => !pending.has(dep)))
    if (wave.length === 0) return null
    for (const step of wave) pending.delete(step.id)
    waves.push(wave)
  }
  return waves
}

type StepApply = { ok: true; result: GovernedStepResult } | { ok: false; failure: GovernedStepFailure }

// Applies one step: resolves its output references, mints a least-privilege token narrowed
// to exactly the capability's scopes, and invokes the governed control command; the control
// plane authorizes, executes, and audits it. The produced outputs register under the step
// id so later steps can bind to them.
async function applyStep(
  client: ControlClient,
  step: GovernedPlanStep,
  outputs: Map<string, Record<string, unknown>>,
): Promise<StepApply> {
  const capability = CONTROL_CAPABILITIES[step.capability]
  if (!capability) {
    return {
      ok: false,
      failure: { stepId: step.id, capability: step.capability, reason: 'capability is not governed-executable', terminal: false },
    }
  }
  const resolved = resolveStepArgs(step.args, outputs)
  if (!resolved.ok) {
    return { ok: false, failure: { stepId: step.id, capability: step.capability, reason: resolved.reason, terminal: false } }
  }
  const invocation = capability.buildInvocation(resolved.args, step.secrets)
  try {
    const result = await client.invoke(invocation.command, invocation.subcommand, invocation.flags, capability.scopes)
    const outcome = capability.describeOutcome(result, resolved.args)
    if (outcome.output) outputs.set(step.id, outcome.output)
    return { ok: true, result: { id: step.id, capability: step.capability, detail: outcome.detail, output: outcome.output } }
  } catch (err) {
    if (err instanceof ControlClientError) {
      // A definitive failure applies nothing and is safe to retry. An ambiguous one - a
      // server error or a lost response at the invoke stage - may have applied the
      // mutation, so it is terminal.
      return {
        ok: false,
        failure: { stepId: step.id, capability: step.capability, reason: err.reason, code: err.code, terminal: !err.definitive },
      }
    }
    // An unknown throw cannot be proven not to have applied, so it is treated as terminal.
    const reason = err instanceof Error ? err.message : 'step failed'
    return { ok: false, failure: { stepId: step.id, capability: step.capability, reason, terminal: true } }
  }
}

// Applies a plan as a dependency-ordered directed acyclic graph through the control plane
// as the Operator's scoped identity. Steps group into deterministic waves from their
// validated dependencies; within a wave the read-only steps resolve concurrently - they
// change nothing, so parallelism is safe - and the mutating steps apply sequentially in
// plan order. Later steps bind to earlier outputs through {{steps.<id>.outputs.<key>}}
// references, resolved from the outputs each applied step surfaced (seeded with the
// persisted outputs of a prior partial run on resume). The model proposes and the
// deterministic pipeline has already validated and previewed the plan - this only carries
// each approved step to the governed surface. A failure stops all further scheduling and
// is returned as the failure, so a plan never silently half-applies.
export async function executeViaControlPlane(
  client: ControlClient,
  steps: GovernedPlanStep[],
  priorOutputs: Record<string, Record<string, unknown>> = {},
): Promise<GovernedExecutionResult> {
  const applied: GovernedStepResult[] = []
  const outputs = new Map<string, Record<string, unknown>>(Object.entries(priorOutputs))
  const waves = dependencyWaves(steps)
  if (!waves) {
    const first = steps[0]
    return {
      applied,
      failure: { stepId: first.id, capability: first.capability, reason: 'plan dependencies do not resolve to an order', terminal: false },
    }
  }

  for (const wave of waves) {
    const reads = wave.filter((step) => CAPABILITIES[step.capability]?.mutating !== true)
    const writes = wave.filter((step) => CAPABILITIES[step.capability]?.mutating === true)

    const readResults = await Promise.all(reads.map((step) => applyStep(client, step, outputs)))
    let failure: GovernedStepFailure | null = null
    for (const settled of readResults) {
      if (settled.ok) applied.push(settled.result)
      else failure ??= settled.failure
    }
    if (failure) return { applied, failure }

    for (const step of writes) {
      const settled = await applyStep(client, step, outputs)
      if (!settled.ok) return { applied, failure: settled.failure }
      applied.push(settled.result)
    }
  }
  return { applied, failure: null }
}
