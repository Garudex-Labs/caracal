/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Pure orchestration for the audit-driven policy iteration loop: diagnose, simulate, regression-check, decide, activate.
*/

// pickDeniedInput returns the reconstructed policy_input from the first denied
// entry of a decision trace, or null when the request was not denied.
export function pickDeniedInput(trace) {
  if (!trace || !Array.isArray(trace.denied) || trace.denied.length === 0) return null
  return trace.denied[0].policy_input ?? null
}

// summarizeTrace flattens the denied entries into a readable diagnosis.
export function summarizeTrace(trace) {
  const denied = Array.isArray(trace?.denied) ? trace.denied : []
  return {
    requestId: trace?.request_id ?? null,
    finalDecision: trace?.final_decision ?? 'unknown',
    reasons: denied.flatMap((entry) =>
      (Array.isArray(entry.diagnostics) ? entry.diagnostics : []).map((d) => d.reason ?? JSON.stringify(d)),
    ),
    determiningPolicies: denied.flatMap((entry) =>
      (Array.isArray(entry.determining_policies) ? entry.determining_policies : []).map((p) => p.policy ?? JSON.stringify(p)),
    ),
  }
}

// assessSimulation normalizes a simulate response into the fields the verdict
// depends on. A null result means the STS engine did not execute the input
// (for example, simulation is not configured), which is never safe to ship.
export function assessSimulation(simulation) {
  const result = simulation?.result ?? null
  return {
    decision: result?.decision ?? 'not_executed',
    executed: result !== null,
    wouldActivate: simulation?.would_activate === true,
    warnings: Array.isArray(simulation?.warnings) ? simulation.warnings : [],
    diagnostics: Array.isArray(result?.diagnostics) ? result.diagnostics : [],
  }
}

// runRegressions replays known-good inputs against the candidate version so a
// policy loosened to fix one denial cannot silently change other decisions.
// Each case carries the decision the team expects the candidate to return.
export async function runRegressions({ transport, policySetId, candidateVersionId, cases }) {
  const results = []
  for (const c of cases) {
    const assessment = assessSimulation(await transport.simulate(policySetId, candidateVersionId, c.input))
    results.push({
      name: c.name,
      expected: c.expect,
      actual: assessment.decision,
      passed: assessment.executed && assessment.decision === c.expect,
      warnings: assessment.warnings,
    })
  }
  return results
}

// verdict gates activation: the candidate must allow the previously denied
// input, pass the server-side rollout contract, produce no warnings, and keep
// every regression case at its expected decision.
export function verdict({ candidate, regressions }) {
  const blockers = []
  if (!candidate.executed) blockers.push('simulation_not_executed')
  else if (candidate.decision !== 'allow') blockers.push(`candidate_still_denies:${candidate.decision}`)
  if (!candidate.wouldActivate) blockers.push('rollout_contract_rejected')
  for (const w of candidate.warnings) blockers.push(`simulation_warning:${w}`)
  for (const r of regressions.filter((r) => !r.passed)) {
    blockers.push(`regression_failed:${r.name}:expected_${r.expected}_got_${r.actual}`)
  }
  return { safeToActivate: blockers.length === 0, blockers }
}

// awaitPropagation polls activation status until the new version is loaded by
// the STS runtime, the rollout fails, or attempts run out.
export async function awaitPropagation({ transport, policySetId, versionId, outboxId, attempts = 10, wait = () => new Promise((r) => setTimeout(r, 1000)) }) {
  let status = null
  for (let i = 0; i < attempts; i += 1) {
    status = await transport.activationStatus(policySetId, versionId, outboxId)
    if (status?.propagation_status === 'loaded' || status?.propagation_status === 'failed') break
    await wait()
  }
  return {
    propagationStatus: status?.propagation_status ?? 'unknown',
    active: status?.active === true,
    loaded: status?.propagation_status === 'loaded',
  }
}

// iterate runs the full loop against an injected Admin API transport:
//
//   1. diagnose  — explain the denied request and reconstruct its policy_input
//   2. simulate  — replay that input against the staged candidate version
//   3. regress   — replay expected-decision cases against the same candidate
//   4. decide    — gate activation on the simulation and regression evidence
//   5. activate  — optionally activate and wait for runtime propagation
//
// Activation only happens when activate=true AND the verdict has no blockers,
// so the default run is always a safe dry run.
export async function iterate({ transport, requestId, policySetId, candidateVersionId, regressionCases = [], activate = false, log = () => {}, wait }) {
  log('diagnose', `explaining request ${requestId} from audit`)
  const trace = await transport.explain(requestId)
  const summary = summarizeTrace(trace)
  const input = pickDeniedInput(trace)
  if (!input) {
    log('diagnose', `request ${requestId} was not denied (final decision: ${summary.finalDecision}); nothing to iterate on`)
    return { reproduced: false, trace: summary, candidate: null, regressions: [], verdict: null, activation: null }
  }
  log('diagnose', `denial reproduced — reasons: [${summary.reasons.join(', ')}], determining policies: [${summary.determiningPolicies.join(', ')}]`)

  log('simulate', `replaying denied input against candidate version ${candidateVersionId}`)
  const candidate = assessSimulation(await transport.simulate(policySetId, candidateVersionId, input))
  log('simulate', `candidate decision: ${candidate.decision}, contract ok: ${candidate.wouldActivate}, warnings: ${candidate.warnings.length}`)

  log('regress', `replaying ${regressionCases.length} regression case(s) against the candidate`)
  const regressions = await runRegressions({ transport, policySetId, candidateVersionId, cases: regressionCases })
  for (const r of regressions) {
    log('regress', `${r.passed ? 'pass' : 'FAIL'} ${r.name}: expected ${r.expected}, got ${r.actual}`)
  }

  const decision = verdict({ candidate, regressions })
  log('decide', decision.safeToActivate
    ? 'all gates passed — candidate is safe to activate'
    : `holding activation — blockers: [${decision.blockers.join(', ')}]`)

  let activation = null
  if (decision.safeToActivate && activate) {
    log('activate', `activating version ${candidateVersionId}`)
    const accepted = await transport.activate(policySetId, candidateVersionId)
    activation = await awaitPropagation({ transport, policySetId, versionId: candidateVersionId, outboxId: accepted?.outbox_id, wait })
    log('activate', `propagation status: ${activation.propagationStatus}`)
  } else if (decision.safeToActivate) {
    log('activate', 'dry run — re-run with ACTIVATE=true to roll out this version')
  }

  return { reproduced: true, trace: summary, policyInput: input, candidate, regressions, verdict: decision, activation }
}
