// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the Caracal-governed autopilot evaluator: policy construction fail-closed rules and the deterministic auto-approval triggers.

import { describe, it, expect } from 'vitest'
import {
  buildAutopilotPolicy,
  autopilotAvailable,
  mayAutoApprove,
  type AutopilotEvaluation,
} from '../../../../apps/api/src/operator-autopilot.js'

function evaluation(over: Partial<AutopilotEvaluation> = {}): AutopilotEvaluation {
  return {
    engaged: true,
    applicable: true,
    steps: [{ id: 's1', capability: 'registerApplication' }],
    ...over,
  }
}

describe('buildAutopilotPolicy', () => {
  it('defaults to a disabled policy that is unavailable', () => {
    const policy = buildAutopilotPolicy()
    expect(policy.enabled).toBe(false)
    expect(autopilotAvailable(policy)).toBe(false)
  })

  it('is available once the master switch is on', () => {
    const policy = buildAutopilotPolicy({ enabled: true })
    expect(policy.enabled).toBe(true)
    expect(autopilotAvailable(policy)).toBe(true)
  })
})

describe('mayAutoApprove', () => {
  it('approves any non-empty engaged plan when the master switch is on', () => {
    expect(mayAutoApprove(evaluation(), buildAutopilotPolicy({ enabled: true }))).toEqual({ autoApprove: true })
  })

  it('approves a plan whose capability the old allowlist would have excluded', () => {
    const ev = evaluation({ steps: [{ id: 's1', capability: 'connectProvider' }] })
    expect(mayAutoApprove(ev, buildAutopilotPolicy({ enabled: true }))).toEqual({ autoApprove: true })
  })

  it('approves a high-blast-radius change such as granting access', () => {
    const ev = evaluation({ steps: [{ id: 's1', capability: 'grantAccess' }] })
    expect(mayAutoApprove(ev, buildAutopilotPolicy({ enabled: true }))).toEqual({ autoApprove: true })
  })

  it('approves a multi-step plan', () => {
    const ev = evaluation({
      steps: [
        { id: 's1', capability: 'registerApplication' },
        { id: 's2', capability: 'defineResource' },
        { id: 's3', capability: 'grantAccess' },
      ],
    })
    expect(mayAutoApprove(ev, buildAutopilotPolicy({ enabled: true }))).toEqual({ autoApprove: true })
  })

  it('stops when the master switch is off', () => {
    expect(mayAutoApprove(evaluation(), buildAutopilotPolicy({ enabled: false }))).toEqual({
      autoApprove: false,
      reason: 'autopilot_disabled',
    })
  })

  it('stops when the conversation has not engaged autopilot', () => {
    expect(mayAutoApprove(evaluation({ engaged: false }), buildAutopilotPolicy({ enabled: true }))).toEqual({
      autoApprove: false,
      reason: 'autopilot_not_engaged',
    })
  })

  it('stops on an empty plan', () => {
    expect(mayAutoApprove(evaluation({ steps: [] }), buildAutopilotPolicy({ enabled: true }))).toEqual({
      autoApprove: false,
      reason: 'empty_plan',
    })
  })

  it('stops when the plan preview says it cannot apply', () => {
    expect(mayAutoApprove(evaluation({ applicable: false }), buildAutopilotPolicy({ enabled: true }))).toEqual({
      autoApprove: false,
      reason: 'plan_not_applicable',
    })
  })
})
