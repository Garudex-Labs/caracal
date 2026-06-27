// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the Operator agents: intent routing, planning, and explanation.

import { describe, it, expect, vi } from 'vitest'
import { buildPlannerMessages, runRouter, runPlanner, runExplainer } from '../../../../apps/api/src/operator-agents.js'
import type { Gateway, CompletionResult, CompletionObjectResult } from '../../../../apps/api/src/operator-gateway.js'

// A gateway stub whose free-text completions are scripted, so the explainer's prompt
// construction and output handling are exercised without a live model.
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

// A gateway stub whose structured completions are scripted: a value resolves as the
// schema-validated object, while an Error rejects as the SDK would on an off-schema
// answer, so the router and planner are exercised against both real outcomes.
function gatewayProducing(...results: (object | Error)[]): { gateway: Gateway; completeObject: ReturnType<typeof vi.fn> } {
  const completeObject = vi.fn()
  for (const result of results) {
    if (result instanceof Error) {
      completeObject.mockRejectedValueOnce(result)
    } else {
      completeObject.mockResolvedValueOnce({ value: result, provider: 'test', model: 'm' } satisfies CompletionObjectResult<object>)
    }
  }
  return {
    gateway: { status: () => ({ enabled: true, providers: [] }), completeObject } as unknown as Gateway,
    completeObject,
  }
}

describe('runRouter', () => {
  it('returns the classified intent', async () => {
    const { gateway } = gatewayProducing({ intent: 'plan' })
    expect(await runRouter(gateway, 'connect github')).toEqual({ ok: true, value: 'plan' })
  })

  it('fails closed when classification does not pass the schema', async () => {
    const { gateway } = gatewayProducing(new Error('schema validation failed'))
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
    const { gateway } = gatewayProducing(plan)
    const result = await runPlanner(gateway, 'connect github', { facts: null, state: null })
    expect(result).toEqual({ ok: true, value: plan })
  })

  it('fails closed when the plan does not pass the schema', async () => {
    const { gateway } = gatewayProducing(new Error('schema validation failed'))
    const result = await runPlanner(gateway, 'connect github', { facts: null, state: null })
    expect(result).toMatchObject({ ok: false })
  })

  it('accepts an empty plan as a valid "nothing maps" result', async () => {
    const { gateway } = gatewayProducing({ summary: 'No matching action', steps: [] })
    const result = await runPlanner(gateway, 'order me a pizza', { facts: null, state: null })
    expect(result).toEqual({ ok: true, value: { summary: 'No matching action', steps: [] } })
  })
})

describe('runExplainer', () => {
  it('returns the model answer text', async () => {
    const { gateway } = gatewayReturning('  Your agent was denied because it lacks the scope.  ')
    const result = await runExplainer(gateway, 'why was it denied', { facts: null, state: null })
    expect(result).toEqual({ ok: true, value: { text: 'Your agent was denied because it lacks the scope.', reasoning: undefined } })
  })

  it('surfaces the model reasoning when the gateway exposes it', async () => {
    const complete = vi.fn().mockResolvedValueOnce({
      text: 'It lacks the scope.',
      reasoning: 'The grant only covers read, the request needs write.',
      provider: 'test',
      model: 'm',
    } satisfies CompletionResult)
    const gateway = { status: () => ({ enabled: true, providers: [] }), complete } as unknown as Gateway
    const result = await runExplainer(gateway, 'why was it denied', { facts: null, state: null })
    expect(result).toEqual({
      ok: true,
      value: { text: 'It lacks the scope.', reasoning: 'The grant only covers read, the request needs write.' },
    })
  })

  it('fails closed on an empty answer', async () => {
    const { gateway } = gatewayReturning('   ')
    const result = await runExplainer(gateway, 'why', { facts: null, state: null })
    expect(result).toMatchObject({ ok: false })
  })
})
