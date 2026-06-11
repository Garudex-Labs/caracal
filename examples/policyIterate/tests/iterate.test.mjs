/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Offline tests for the policy iteration loop using an injected Admin API transport.
*/

import assert from "node:assert/strict"
import { test } from "node:test"
import {
  assessSimulation,
  awaitPropagation,
  iterate,
  pickDeniedInput,
  runRegressions,
  summarizeTrace,
  verdict,
} from "../iterate.mjs"

const deniedInput = {
  schema_version: "2026-05-20",
  principal: { type: "Application", id: "app-1", zone_id: "z1" },
  resource: { type: "Resource", identifier: "resource://pipernet", scopes: ["pipernet:read"] },
  action: { id: "TokenExchange" },
  context: { actor_claims: {}, requested_scopes: ["pipernet:read"], challenge_resolved: false },
}

const deniedTrace = {
  request_id: "r1",
  final_decision: "deny",
  denied: [
    {
      event_id: "a1",
      diagnostics: [{ reason: "no_matching_policy" }],
      determining_policies: [{ policy: "baseline-scope-allowlist" }],
      metadata: { resource: "resource://pipernet" },
      policy_input: deniedInput,
    },
  ],
}

const allowTrace = { request_id: "r2", final_decision: "allow", denied: [] }

const allowSimulation = { would_activate: true, warnings: [], result: { decision: "allow", diagnostics: [] } }
const denySimulation = { would_activate: true, warnings: [], result: { decision: "deny", diagnostics: [{ reason: "no_matching_policy" }] } }

test("pickDeniedInput returns the reconstructed input", () => {
  assert.equal(pickDeniedInput(deniedTrace).principal.id, "app-1")
  assert.equal(pickDeniedInput(allowTrace), null)
})

test("summarizeTrace flattens reasons and policies", () => {
  const summary = summarizeTrace(deniedTrace)
  assert.deepEqual(summary.reasons, ["no_matching_policy"])
  assert.deepEqual(summary.determiningPolicies, ["baseline-scope-allowlist"])
})

test("assessSimulation flags an unexecuted simulation", () => {
  const assessment = assessSimulation({ would_activate: true, warnings: [], result: null })
  assert.equal(assessment.executed, false)
  assert.equal(assessment.decision, "not_executed")
})

test("runRegressions compares each case against its expected decision", async () => {
  const transport = {
    simulate: async (_set, _version, input) =>
      input.principal.id === "app-good" ? allowSimulation : denySimulation,
  }
  const cases = [
    { name: "good app allowed", expect: "allow", input: { principal: { id: "app-good" } } },
    { name: "bad app denied", expect: "deny", input: { principal: { id: "app-bad" } } },
    { name: "bad app wrongly expected allowed", expect: "allow", input: { principal: { id: "app-bad" } } },
  ]
  const results = await runRegressions({ transport, policySetId: "ps1", candidateVersionId: "v2", cases })
  assert.deepEqual(results.map((r) => r.passed), [true, true, false])
})

test("verdict passes only when every gate is clean", () => {
  const clean = verdict({
    candidate: { executed: true, decision: "allow", wouldActivate: true, warnings: [] },
    regressions: [{ name: "case", expected: "allow", actual: "allow", passed: true }],
  })
  assert.equal(clean.safeToActivate, true)
  assert.deepEqual(clean.blockers, [])
})

test("verdict blocks on denial, warnings, contract, and regressions", () => {
  const blocked = verdict({
    candidate: { executed: true, decision: "deny", wouldActivate: false, warnings: ["input_zone_mismatch"] },
    regressions: [{ name: "good app", expected: "allow", actual: "deny", passed: false }],
  })
  assert.equal(blocked.safeToActivate, false)
  assert.deepEqual(blocked.blockers, [
    "candidate_still_denies:deny",
    "rollout_contract_rejected",
    "simulation_warning:input_zone_mismatch",
    "regression_failed:good app:expected_allow_got_deny",
  ])
})

test("verdict blocks when the simulation engine did not execute", () => {
  const blocked = verdict({
    candidate: { executed: false, decision: "not_executed", wouldActivate: true, warnings: [] },
    regressions: [],
  })
  assert.deepEqual(blocked.blockers, ["simulation_not_executed"])
})

test("awaitPropagation polls until the version is loaded", async () => {
  const statuses = [
    { propagation_status: "waiting_for_outbox", active: true },
    { propagation_status: "waiting_for_sts", active: true },
    { propagation_status: "loaded", active: true },
  ]
  let calls = 0
  const transport = { activationStatus: async () => statuses[calls++] }
  const result = await awaitPropagation({ transport, policySetId: "ps1", versionId: "v2", wait: async () => {} })
  assert.equal(result.loaded, true)
  assert.equal(calls, 3)
})

test("awaitPropagation stops on failure", async () => {
  const transport = { activationStatus: async () => ({ propagation_status: "failed", active: true }) }
  const result = await awaitPropagation({ transport, policySetId: "ps1", versionId: "v2", wait: async () => {} })
  assert.equal(result.loaded, false)
  assert.equal(result.propagationStatus, "failed")
})

test("iterate holds activation when the candidate still denies", async () => {
  const transport = {
    explain: async () => deniedTrace,
    simulate: async () => denySimulation,
    activate: async () => { throw new Error("must not activate") },
  }
  const report = await iterate({ transport, requestId: "r1", policySetId: "ps1", candidateVersionId: "v2", activate: true })
  assert.equal(report.reproduced, true)
  assert.equal(report.verdict.safeToActivate, false)
  assert.equal(report.activation, null)
})

test("iterate holds activation when a regression fails", async () => {
  const transport = {
    explain: async () => deniedTrace,
    simulate: async (_set, _version, input) =>
      input.principal.id === "app-1" ? allowSimulation : denySimulation,
    activate: async () => { throw new Error("must not activate") },
  }
  const report = await iterate({
    transport,
    requestId: "r1",
    policySetId: "ps1",
    candidateVersionId: "v2",
    regressionCases: [{ name: "other app stays allowed", expect: "allow", input: { principal: { id: "app-2" } } }],
    activate: true,
  })
  assert.equal(report.verdict.safeToActivate, false)
  assert.match(report.verdict.blockers[0], /^regression_failed:other app stays allowed/)
})

test("iterate stays a dry run when activate is false", async () => {
  const transport = {
    explain: async () => deniedTrace,
    simulate: async () => allowSimulation,
    activate: async () => { throw new Error("must not activate") },
  }
  const report = await iterate({ transport, requestId: "r1", policySetId: "ps1", candidateVersionId: "v2" })
  assert.equal(report.verdict.safeToActivate, true)
  assert.equal(report.activation, null)
})

test("iterate activates and confirms propagation when all gates pass", async () => {
  const activated = []
  const transport = {
    explain: async () => deniedTrace,
    simulate: async (_set, _version, input) => {
      assert.equal(input.principal.id, "app-1")
      return allowSimulation
    },
    activate: async (setId, versionId) => {
      activated.push([setId, versionId])
      return { activated: true, version_id: versionId, outbox_id: "ob1" }
    },
    activationStatus: async (_set, _version, outboxId) => {
      assert.equal(outboxId, "ob1")
      return { propagation_status: "loaded", active: true }
    },
  }
  const phases = []
  const report = await iterate({
    transport,
    requestId: "r1",
    policySetId: "ps1",
    candidateVersionId: "v2",
    activate: true,
    log: (phase) => phases.push(phase),
    wait: async () => {},
  })
  assert.deepEqual(activated, [["ps1", "v2"]])
  assert.equal(report.activation.loaded, true)
  assert.ok(["diagnose", "simulate", "regress", "decide", "activate"].every((p) => phases.includes(p)))
})

test("iterate reports not reproduced when the request was not denied", async () => {
  const transport = { explain: async () => allowTrace, simulate: async () => { throw new Error("must not simulate") } }
  const report = await iterate({ transport, requestId: "r2", policySetId: "ps1", candidateVersionId: "v2" })
  assert.equal(report.reproduced, false)
  assert.equal(report.candidate, null)
  assert.equal(report.verdict, null)
})
