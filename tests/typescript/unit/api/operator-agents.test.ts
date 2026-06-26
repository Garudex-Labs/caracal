// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the Operator agents: JSON extraction, intent routing, planning, and explanation.

import { describe, it, expect, vi } from 'vitest'
import { extractJson, buildPlannerMessages, runRouter, runPlanner, runExplainer } from '../../../../apps/api/src/operator-agents.js'
import type { Gateway, CompletionResult } from '../../../../apps/api/src/operator-gateway.js'

// A gateway stub whose completions are scripted, so the agent's prompt construction
// and output handling are exercised without a live model.
function gatewayReturning(...texts: string[]): { gateway: Gateway; complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn()
  for (const text of texts) {
    complete.mockResolvedValueOnce({ text, provider: 'test', model: 'm' } satisfies CompletionResult)
  }
  return {
    gateway: { status: () => ({ enabled: true, providers: [] }), complete } as unknown as Gateway,
    complete,
  }
}

describe('extractJson', () => {
  it('parses a bare JSON object', () => {
    expect(extractJson('{"intent":"plan"}')).toEqual({ intent: 'plan' })
  })

  it('parses JSON inside a fenced code block', () => {
    expect(extractJson('Here:\n```json\n{"intent":"explain"}\n```')).toEqual({ intent: 'explain' })
  })

  it('parses JSON embedded in prose', () => {
    expect(extractJson('Sure! {"summary":"x","steps":[]} done')).toEqual({ summary: 'x', steps: [] })
  })

  it('returns null when there is no JSON object', () => {
    expect(extractJson('no json here')).toBeNull()
  })

  it('returns null on malformed JSON', () => {
    expect(extractJson('{"a": }')).toBeNull()
  })
})

describe('runRouter', () => {
  it('returns the classified intent', async () => {
    const { gateway } = gatewayReturning('{"intent":"plan"}')
    expect(await runRouter(gateway, 'connect github')).toEqual({ ok: true, value: 'plan' })
  })

  it('fails closed on an unrecognized classification', async () => {
    const { gateway } = gatewayReturning('{"intent":"banana"}')
    const result = await runRouter(gateway, 'hmm')
    expect(result.ok).toBe(false)
  })
})

describe('buildPlannerMessages', () => {
  it('grounds the planner with the capability catalog', () => {
    const messages = buildPlannerMessages('connect github', { facts: null, state: null })
    const system = messages[0].content
    expect(system).toContain('connectProvider')
    expect(system).toContain('createZone')
    // The effect classification is surfaced so the model cannot mislabel a step.
    expect(system).toContain('changes state')
  })

  it('includes prior context in the user turn', () => {
    const messages = buildPlannerMessages('do it', {
      facts: null,
      state: {
        latest_plan: null,
        pending_approval: false,
        recent_messages: [{ seq: 1, role: 'user', text: 'earlier message' }],
        last_error: null,
      },
    })
    expect(messages[1].content).toContain('earlier message')
  })

  it('renders compressed session facts including rejection memory', () => {
    const messages = buildPlannerMessages('do it', {
      facts: {
        decided_plans: [{ seq: 2, summary: 'old plan', decision: 'rejected', executed: false, steps_succeeded: 0, steps_failed: 0 }],
        rejected_capabilities: ['grantAccess'],
        applied_change_count: 3,
        last_error: null,
      },
      state: null,
    })
    const content = messages[1].content
    expect(content).toContain('Session facts')
    expect(content).toContain('Previously rejected operations')
    expect(content).toContain('grantAccess')
    expect(content).toContain('3 change(s) already applied')
  })
})

describe('runPlanner', () => {
  it('returns a parsed proposed plan', async () => {
    const plan = {
      summary: 'Connect GitHub',
      steps: [{ id: 's1', capability: 'connectProvider', args: { name: 'GitHub', kind: 'oauth2_authorization_code' } }],
    }
    const { gateway } = gatewayReturning('```json\n' + JSON.stringify(plan) + '\n```')
    const result = await runPlanner(gateway, 'connect github', { facts: null, state: null })
    expect(result).toEqual({ ok: true, value: plan })
  })

  it('fails closed when the model returns no JSON', async () => {
    const { gateway } = gatewayReturning('I am not sure how to help.')
    const result = await runPlanner(gateway, 'connect github', { facts: null, state: null })
    expect(result).toMatchObject({ ok: false })
  })

  it('fails closed when the JSON does not match the plan schema', async () => {
    const { gateway } = gatewayReturning('{"summary":"x"}')
    const result = await runPlanner(gateway, 'connect github', { facts: null, state: null })
    expect(result).toMatchObject({ ok: false })
  })
})

describe('runExplainer', () => {
  it('returns the model answer text', async () => {
    const { gateway } = gatewayReturning('  Your agent was denied because it lacks the scope.  ')
    const result = await runExplainer(gateway, 'why was it denied', { facts: null, state: null })
    expect(result).toEqual({ ok: true, value: 'Your agent was denied because it lacks the scope.' })
  })

  it('fails closed on an empty answer', async () => {
    const { gateway } = gatewayReturning('   ')
    const result = await runExplainer(gateway, 'why', { facts: null, state: null })
    expect(result).toMatchObject({ ok: false })
  })
})
