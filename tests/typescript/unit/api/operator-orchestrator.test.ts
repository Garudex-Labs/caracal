// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the Operator orchestrator and skill registry: tier-to-skill selection and typed-artifact dispatch.

import { describe, it, expect, vi } from 'vitest'
import { createSkillRegistry, createOrchestrator, type SkillRegistry, type Skill } from '../../../../apps/api/src/operator-orchestrator.js'
import type { Gateway, CompletionResult, CompletionObjectResult } from '../../../../apps/api/src/operator-gateway.js'

const emptyContext = { facts: null, state: null }

// A gateway stub whose triage classification and free-text answer are scripted, so the
// orchestrator's dispatch is exercised without a live model. The first structured completion is
// the triage tier; free-text completions are the answer skill's output.
function gatewayFor(tier: string, answer = 'an answer'): Gateway {
  const completeObject = vi.fn().mockResolvedValue({ value: { tier }, provider: 't', model: 'm' } satisfies CompletionObjectResult<object>)
  const complete = vi.fn().mockResolvedValue({ text: answer, provider: 't', model: 'm' } satisfies CompletionResult)
  return { status: () => ({ enabled: true, providers: [] }), complete, completeObject } as unknown as Gateway
}

// A gateway whose triage classifies as a planning tier and whose structured completions return,
// in order, the triage tier then the planner's plan.
function planningGateway(tier: 'change' | 'compound', plan: object): Gateway {
  const completeObject = vi
    .fn()
    .mockResolvedValueOnce({ value: { tier }, provider: 't', model: 'm' })
    .mockResolvedValueOnce({ value: plan, provider: 't', model: 'm' })
  return { status: () => ({ enabled: true, providers: [] }), completeObject } as unknown as Gateway
}

describe('createSkillRegistry', () => {
  it('maps change and compound tiers to the planning skill', () => {
    const registry = createSkillRegistry()
    expect(registry.forTier('change').kind).toBe('plan')
    expect(registry.forTier('compound').kind).toBe('plan')
  })

  it('maps conversational and read tiers to the answering skill', () => {
    const registry = createSkillRegistry()
    expect(registry.forTier('conversational').kind).toBe('answer')
    expect(registry.forTier('read').kind).toBe('answer')
  })
})

describe('createOrchestrator', () => {
  it('answers a read tier with the answer skill', async () => {
    const result = await createOrchestrator().handle(gatewayFor('read', 'because the scope is missing'), 'why denied', emptyContext)
    expect(result.tier).toBe('read')
    expect(result.outcome.kind).toBe('answer')
    if (result.outcome.kind === 'answer') {
      expect(result.outcome.result.ok).toBe(true)
      if (result.outcome.result.ok) expect(result.outcome.result.value.text).toContain('scope is missing')
    }
  })

  it('answers a conversational tier with the answer skill', async () => {
    const result = await createOrchestrator().handle(gatewayFor('conversational'), 'hi', emptyContext)
    expect(result.tier).toBe('conversational')
    expect(result.outcome.kind).toBe('answer')
  })

  it('plans a change tier with the plan skill', async () => {
    const plan = {
      summary: 'Connect GitHub',
      steps: [{ id: 's1', capability: 'connectProvider', args: { name: 'GitHub', kind: 'api_key' } }],
    }
    const result = await createOrchestrator().handle(planningGateway('change', plan), 'connect github', emptyContext)
    expect(result.tier).toBe('change')
    expect(result.outcome.kind).toBe('plan')
    if (result.outcome.kind === 'plan') {
      expect(result.outcome.result.ok).toBe(true)
      if (result.outcome.result.ok) expect(result.outcome.result.value.steps).toHaveLength(1)
    }
  })

  it('defaults to the read tier and answers when triage fails the schema', async () => {
    const completeObject = vi.fn().mockRejectedValue(new Error('schema validation failed'))
    const complete = vi.fn().mockResolvedValue({ text: 'fallback answer', provider: 't', model: 'm' })
    const gateway = { status: () => ({ enabled: true, providers: [] }), complete, completeObject } as unknown as Gateway
    const result = await createOrchestrator().handle(gateway, 'ambiguous', emptyContext)
    // A failed triage never escalates to a planning tier, so an ambiguous request can never
    // silently produce a plan — it is answered as text in the read tier.
    expect(result.tier).toBe('read')
    expect(result.outcome.kind).toBe('answer')
  })

  it('selects the skill the injected registry maps the tier to', async () => {
    const calls: string[] = []
    const probeSkill: Skill = {
      id: 'probe',
      kind: 'answer',
      run: async () => {
        calls.push('probe')
        return { ok: true, value: { text: 'probed' } }
      },
    }
    const registry: SkillRegistry = { forTier: () => probeSkill }
    const result = await createOrchestrator(registry).handle(gatewayFor('change'), 'anything', emptyContext)
    // The orchestrator runs exactly the skill the registry returns, regardless of tier — the
    // seam later phases extend with specialist skills.
    expect(calls).toEqual(['probe'])
    expect(result.outcome.kind).toBe('answer')
  })

  it('grounds a read tier in evidence gathered through the researcher', async () => {
    const evidence = [{ capability: 'listProviders', domain: 'provider', ok: true, count: 1, names: ['GitHub'] }]
    const researcher = { gather: vi.fn().mockResolvedValue({ evidence }) }
    let seen: unknown
    const registry: SkillRegistry = {
      forTier: () => ({
        id: 'probe',
        kind: 'answer',
        run: async (_g, _m, context) => {
          seen = context.evidence
          return { ok: true, value: { text: 'grounded' } }
        },
      }),
    }
    await createOrchestrator(registry).handle(gatewayFor('read'), 'what providers do i have', emptyContext, { researcher })
    // A read tier inspects state, so the researcher is invoked and its evidence reaches the
    // answering skill's context.
    expect(researcher.gather).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(evidence)
  })

  it('does not gather evidence for a conversational tier', async () => {
    const researcher = { gather: vi.fn().mockResolvedValue({ evidence: [] }) }
    await createOrchestrator().handle(gatewayFor('conversational'), 'hi', emptyContext, { researcher })
    // Greetings and capability questions need no state read, so the governed reads never run.
    expect(researcher.gather).not.toHaveBeenCalled()
  })

  it('does not gather evidence for a planning tier', async () => {
    const plan = {
      summary: 'Connect GitHub',
      steps: [{ id: 's1', capability: 'connectProvider', args: { name: 'GitHub', kind: 'api_key' } }],
    }
    const researcher = { gather: vi.fn().mockResolvedValue({ evidence: [] }) }
    await createOrchestrator().handle(planningGateway('change', plan), 'connect github', emptyContext, { researcher })
    expect(researcher.gather).not.toHaveBeenCalled()
  })

  it('answers without evidence when the researcher throws', async () => {
    const researcher = { gather: vi.fn().mockRejectedValue(new Error('control unreachable')) }
    let seen: unknown = 'unset'
    const registry: SkillRegistry = {
      forTier: () => ({
        id: 'probe',
        kind: 'answer',
        run: async (_g, _m, context) => {
          seen = context.evidence
          return { ok: true, value: { text: 'degraded' } }
        },
      }),
    }
    const result = await createOrchestrator(registry).handle(gatewayFor('read'), 'state', emptyContext, { researcher })
    // A researcher failure degrades to no evidence; the turn still answers rather than erroring.
    expect(result.outcome.kind).toBe('answer')
    expect(seen).toBeUndefined()
  })
})
