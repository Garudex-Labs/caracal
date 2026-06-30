// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the Operator orchestrator and skill registry: tier-to-skill selection and typed-artifact dispatch.

import { describe, it, expect, vi } from 'vitest'
import {
  createSkillRegistry,
  createOrchestrator,
  ASK_MODE_CHANGE_MESSAGE,
  type SkillRegistry,
  type Skill,
} from '../../../../apps/api/src/operator-orchestrator.js'
import type { Gateway, CompletionResult, CompletionObjectResult } from '../../../../apps/api/src/operator-gateway.js'

const emptyContext = { facts: null, state: null }

// A gateway stub whose triage classification and free-text answer are scripted, so the
// orchestrator's dispatch is exercised without a live model. The first structured completion is
// the triage classification (tier and topic); free-text completions are the answer skill's output.
function gatewayFor(tier: string, answer = 'an answer', topic = 'general'): Gateway {
  const completeObject = vi
    .fn()
    .mockResolvedValue({ value: { tier, topic }, provider: 't', model: 'm' } satisfies CompletionObjectResult<object>)
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

// A gateway for the compound composition: structured completions return, in order, the compound
// triage tier, the planner's plan, then the security analyst's advisory.
function composingGateway(plan: object, advisory: object): Gateway {
  const completeObject = vi
    .fn()
    .mockResolvedValueOnce({ value: { tier: 'compound' }, provider: 't', model: 'm' })
    .mockResolvedValueOnce({ value: plan, provider: 't', model: 'm' })
    .mockResolvedValueOnce({ value: advisory, provider: 't', model: 'm' })
  return { status: () => ({ enabled: true, providers: [] }), completeObject } as unknown as Gateway
}

describe('createSkillRegistry', () => {
  it('maps change and compound tiers to the planning skill', () => {
    const registry = createSkillRegistry()
    expect(registry.select({ tier: 'change', topic: 'general' }).kind).toBe('plan')
    expect(registry.select({ tier: 'compound', topic: 'general' }).kind).toBe('plan')
  })

  it('maps conversational and read tiers to the answering skill', () => {
    const registry = createSkillRegistry()
    expect(registry.select({ tier: 'conversational', topic: 'general' }).kind).toBe('answer')
    expect(registry.select({ tier: 'read', topic: 'general' }).kind).toBe('answer')
  })

  it('routes a read tier to the answer specialist named by its topic', () => {
    const registry = createSkillRegistry()
    expect(registry.select({ tier: 'read', topic: 'general' }).id).toBe('explainer')
    expect(registry.select({ tier: 'read', topic: 'diagnostic' }).id).toBe('troubleshooter')
    expect(registry.select({ tier: 'read', topic: 'integration' }).id).toBe('translator')
  })

  it('keeps a conversational tier on the general explainer regardless of topic', () => {
    const registry = createSkillRegistry()
    expect(registry.select({ tier: 'conversational', topic: 'diagnostic' }).id).toBe('explainer')
    expect(registry.select({ tier: 'conversational', topic: 'integration' }).id).toBe('explainer')
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
    const registry: SkillRegistry = { select: () => probeSkill }
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
      select: () => ({
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

  it('scopes evidence gathering to the domains triage names', async () => {
    const completeObject = vi
      .fn()
      .mockResolvedValueOnce({ value: { tier: 'read', topic: 'general', domains: ['provider'] }, provider: 't', model: 'm' })
    const complete = vi.fn().mockResolvedValue({ text: 'one provider', provider: 't', model: 'm' })
    const gateway = { status: () => ({ enabled: true, providers: [] }), complete, completeObject } as unknown as Gateway
    const researcher = { gather: vi.fn().mockResolvedValue({ evidence: [] }) }
    await createOrchestrator().handle(gateway, 'what providers do i have', emptyContext, { researcher })
    // The reads are scoped to exactly the domains triage named, so the turn reads only what the
    // request concerns rather than fanning out across every governed read.
    expect(researcher.gather).toHaveBeenCalledWith(['provider'])
  })

  it('grounds an answer in retrieved documentation passed to the answer skill', async () => {
    const docs = [{ id: '/sdks/typescript', title: 'TypeScript SDK', url: 'https://docs/x', snippet: 'npm install @caracalai/sdk' }]
    const retriever = vi.fn().mockReturnValue(docs)
    let seenDocs: unknown
    const registry: SkillRegistry = {
      select: () => ({
        id: 'probe',
        kind: 'answer',
        run: async (_g, _m, context) => {
          seenDocs = context.docs
          return { ok: true, value: { text: 'grounded in docs' } }
        },
      }),
    }
    await createOrchestrator(registry).handle(gatewayFor('conversational'), 'what is the typescript sdk package', emptyContext, {
      docs: retriever,
    })
    // The retriever is queried with the request and its passages reach the answering skill, so the
    // answer is grounded in real documentation rather than the model's recall.
    expect(retriever).toHaveBeenCalledWith('what is the typescript sdk package')
    expect(seenDocs).toEqual(docs)
  })

  it('does not retrieve documentation for a planning tier', async () => {
    const retriever = vi.fn().mockReturnValue([])
    const plan = {
      summary: 'connect',
      steps: [{ id: 's1', capability: 'connectProvider', args: { name: 'GitHub', kind: 'oauth2_authorization_code' } }],
    }
    await createOrchestrator().handle(planningGateway('change', plan), 'connect github', emptyContext, { docs: retriever })
    // Planning grounds in the capability catalog and live state, not prose docs, so the retriever is
    // never invoked on the change path.
    expect(retriever).not.toHaveBeenCalled()
  })

  it('routes a diagnostic read to the troubleshooter and an integration read to the translator', async () => {
    // The default registry is used, so the real specialists run; the topic in the scripted triage
    // decides which one. Both are read-only answer skills grounded in the gathered evidence.
    const diagnostic = await createOrchestrator().handle(
      gatewayFor('read', 'It was denied because no grant exists.', 'diagnostic'),
      'why was my agent denied',
      emptyContext,
    )
    expect(diagnostic.tier).toBe('read')
    expect(diagnostic.outcome.kind).toBe('answer')

    const integration = await createOrchestrator().handle(
      gatewayFor('read', 'Connect it as an OAuth authorization-code provider.', 'integration'),
      'how do I connect GitHub',
      emptyContext,
    )
    expect(integration.tier).toBe('read')
    expect(integration.outcome.kind).toBe('answer')
  })

  it('runs the read specialist the injected registry selects for a topic without any orchestrator change', async () => {
    // The evolvability property: a new read specialist is added by registering it against a topic;
    // the orchestrator selects and runs it unchanged.
    const calls: string[] = []
    const registry: SkillRegistry = {
      select: ({ topic }) => ({
        id: `probe-${topic}`,
        kind: 'answer',
        run: async () => {
          calls.push(topic)
          return { ok: true, value: { text: 'probed' } }
        },
      }),
    }
    await createOrchestrator(registry).handle(gatewayFor('read', 'x', 'diagnostic'), 'why denied', emptyContext)
    expect(calls).toEqual(['diagnostic'])
  })

  it('does not gather evidence for a conversational tier', async () => {
    const researcher = { gather: vi.fn().mockResolvedValue({ evidence: [] }) }
    await createOrchestrator().handle(gatewayFor('conversational'), 'hi', emptyContext, { researcher })
    // Greetings and capability questions need no state read, so the governed reads never run.
    expect(researcher.gather).not.toHaveBeenCalled()
  })

  it('grounds a planning tier in evidence gathered through the researcher', async () => {
    const plan = {
      summary: 'Connect GitHub',
      steps: [{ id: 's1', capability: 'connectProvider', args: { name: 'GitHub', kind: 'api_key' } }],
    }
    const researcher = { gather: vi.fn().mockResolvedValue({ evidence: [] }) }
    await createOrchestrator().handle(planningGateway('change', plan), 'connect github', emptyContext, { researcher })
    // Every plan is proposed against freshly read live state, so the planner and the guardian judge
    // against what actually exists rather than in the abstract.
    expect(researcher.gather).toHaveBeenCalledTimes(1)
  })

  it('answers without evidence when the researcher throws', async () => {
    const researcher = { gather: vi.fn().mockRejectedValue(new Error('control unreachable')) }
    let seen: unknown = 'unset'
    const registry: SkillRegistry = {
      select: () => ({
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

  it('marks live state unavailable for a read tier when no researcher is active for the zone', async () => {
    let marked: unknown = 'unset'
    const registry: SkillRegistry = {
      select: () => ({
        id: 'probe',
        kind: 'answer',
        run: async (_g, _m, context) => {
          marked = context.liveStateUnavailable
          return { ok: true, value: { text: 'no live state' } }
        },
      }),
    }
    // No researcher: the Operator holds no governed read mandate for this zone, so the read agent
    // is told live state could not be read rather than left to invent it.
    const result = await createOrchestrator(registry).handle(gatewayFor('read'), 'how many apps', emptyContext, { researcher: null })
    expect(result.outcome.kind).toBe('answer')
    expect(marked).toBe(true)
  })

  it('composes a compound tier: gathers evidence, plans against it, and attaches an advisory', async () => {
    const plan = {
      summary: 'Grant Finance read-only Stripe',
      steps: [
        {
          id: 's1',
          capability: 'grantAccess',
          args: { application_id: 'app_finance', user_id: 'user_richard', resource_id: 'res_stripe', scopes: ['read'] },
        },
      ],
    }
    const advisory = { summary: 'Scoped to read; low blast-radius.', findings: [] }
    const evidence = [{ capability: 'listResources', domain: 'resource', ok: true, count: 1, names: ['Stripe invoices'] }]
    const researcher = { gather: vi.fn().mockResolvedValue({ evidence }) }
    const result = await createOrchestrator().handle(
      composingGateway(plan, advisory),
      'give finance read-only stripe and tidy permissions',
      emptyContext,
      { researcher },
    )
    expect(result.tier).toBe('compound')
    // A compound request inspects state before planning.
    expect(researcher.gather).toHaveBeenCalledTimes(1)
    expect(result.outcome.kind).toBe('plan')
    if (result.outcome.kind === 'plan') {
      // The plan is still produced and still requires approval — the advisory does not gate it.
      expect(result.outcome.result.ok).toBe(true)
      expect(result.outcome.advisory).toEqual(advisory)
    }
  })

  it('runs the guardian on a single change plan and attaches its advisory', async () => {
    const plan = {
      summary: 'Connect GitHub',
      steps: [{ id: 's1', capability: 'connectProvider', args: { name: 'GitHub', kind: 'api_key' } }],
    }
    const advisory = { summary: 'Narrow connection; aligned.', alignment: 'aligned', findings: [] }
    const completeObject = vi
      .fn()
      .mockResolvedValueOnce({ value: { tier: 'change' }, provider: 't', model: 'm' })
      .mockResolvedValueOnce({ value: plan, provider: 't', model: 'm' })
      .mockResolvedValueOnce({ value: advisory, provider: 't', model: 'm' })
    const gateway = { status: () => ({ enabled: true, providers: [] }), completeObject } as unknown as Gateway
    const result = await createOrchestrator().handle(gateway, 'connect github', emptyContext)
    // The guardian reviews every mutating plan, not only composed ones, so a single risky change is
    // never proposed for approval without an independent critique and alignment verdict alongside it.
    expect(result.outcome.kind).toBe('plan')
    if (result.outcome.kind === 'plan') expect(result.outcome.advisory).toEqual(advisory)
  })

  it('repairs a plan that fails validation and returns the corrected plan', async () => {
    const broken = { summary: 'Connect GitHub', steps: [{ id: 's1', capability: 'connectNexus', args: {} }] }
    const fixed = {
      summary: 'Connect GitHub',
      steps: [{ id: 's1', capability: 'connectProvider', args: { name: 'GitHub', kind: 'api_key' } }],
    }
    const advisory = { summary: 'Narrow connection; aligned.', findings: [] }
    const completeObject = vi
      .fn()
      .mockResolvedValueOnce({ value: { tier: 'change' }, provider: 't', model: 'm' })
      .mockResolvedValueOnce({ value: broken, provider: 't', model: 'm' })
      .mockResolvedValueOnce({ value: fixed, provider: 't', model: 'm' })
      .mockResolvedValueOnce({ value: advisory, provider: 't', model: 'm' })
    const gateway = { status: () => ({ enabled: true, providers: [] }), completeObject } as unknown as Gateway
    const result = await createOrchestrator().handle(gateway, 'connect github', emptyContext)
    // A first proposal that fails catalog validation triggers exactly one repair pass; the corrected
    // plan replaces it before the guardian and the route ever see it.
    expect(result.outcome.kind).toBe('plan')
    if (result.outcome.kind === 'plan' && result.outcome.result.ok) {
      expect(result.outcome.result.value.steps[0].capability).toBe('connectProvider')
    }
    // triage + first plan + repair plan + guardian review.
    expect(completeObject).toHaveBeenCalledTimes(4)
  })

  it('attaches no advisory when a compound plan proposes no steps', async () => {
    const emptyPlan = { summary: 'Nothing maps', steps: [] }
    // Only triage + planner complete; the analyst is never called because there is nothing to review.
    const completeObject = vi
      .fn()
      .mockResolvedValueOnce({ value: { tier: 'compound' }, provider: 't', model: 'm' })
      .mockResolvedValueOnce({ value: emptyPlan, provider: 't', model: 'm' })
    const gateway = { status: () => ({ enabled: true, providers: [] }), completeObject } as unknown as Gateway
    const researcher = { gather: vi.fn().mockResolvedValue({ evidence: [] }) }
    const result = await createOrchestrator().handle(gateway, 'do something unmappable', emptyContext, { researcher })
    expect(result.outcome.kind).toBe('plan')
    if (result.outcome.kind === 'plan') expect(result.outcome.advisory).toBeUndefined()
    // Exactly two structured calls: triage + planner. No advisory review on an empty plan.
    expect(completeObject).toHaveBeenCalledTimes(2)
  })

  it('still returns the compound plan when the advisory review fails', async () => {
    const plan = {
      summary: 'Grant access',
      steps: [
        {
          id: 's1',
          capability: 'grantAccess',
          args: { application_id: 'app_finance', user_id: 'user_richard', resource_id: 'res_stripe', scopes: ['read'] },
        },
      ],
    }
    const completeObject = vi
      .fn()
      .mockResolvedValueOnce({ value: { tier: 'compound' }, provider: 't', model: 'm' })
      .mockResolvedValueOnce({ value: plan, provider: 't', model: 'm' })
      .mockRejectedValueOnce(new Error('advisory off-schema'))
    const gateway = { status: () => ({ enabled: true, providers: [] }), completeObject } as unknown as Gateway
    const result = await createOrchestrator().handle(gateway, 'grant finance and cleanup', emptyContext, {
      researcher: { gather: vi.fn().mockResolvedValue({ evidence: [] }) },
    })
    // A failed advisory attaches nothing but never blocks the plan.
    expect(result.outcome.kind).toBe('plan')
    if (result.outcome.kind === 'plan') {
      expect(result.outcome.result.ok).toBe(true)
      expect(result.outcome.advisory).toBeUndefined()
    }
  })

  it('refuses to plan in ask mode and answers with a switch-to-agent message', async () => {
    // The gateway would happily plan, but ask mode short-circuits before the planner: only triage
    // runs, and the deterministic switch-to-agent answer is returned with no plan.
    const plan = {
      summary: 'Connect GitHub',
      steps: [{ id: 's1', capability: 'connectProvider', args: { name: 'GitHub', kind: 'api_key' } }],
    }
    const gateway = planningGateway('change', plan)
    const result = await createOrchestrator().handle(gateway, 'connect github', emptyContext, { mode: 'ask' })
    expect(result.tier).toBe('change')
    expect(result.outcome.kind).toBe('answer')
    if (result.outcome.kind === 'answer') {
      expect(result.outcome.result.ok).toBe(true)
      if (result.outcome.result.ok) expect(result.outcome.result.value.text).toBe(ASK_MODE_CHANGE_MESSAGE)
    }
    // Only triage ran; the planner was never called, so the model could not produce a plan.
    expect((gateway.completeObject as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1)
  })

  it('refuses to plan a compound request in ask mode without gathering evidence', async () => {
    const plan = { summary: 'Grant + cleanup', steps: [{ id: 's1', capability: 'grantAccess', args: {} }] }
    const researcher = { gather: vi.fn().mockResolvedValue({ evidence: [] }) }
    const result = await createOrchestrator().handle(planningGateway('compound', plan), 'do a lot', emptyContext, {
      mode: 'ask',
      researcher,
    })
    expect(result.outcome.kind).toBe('answer')
    // Ask mode short-circuits before any evidence gathering or planning.
    expect(researcher.gather).not.toHaveBeenCalled()
  })

  it('still answers a read request normally in ask mode', async () => {
    const researcher = { gather: vi.fn().mockResolvedValue({ evidence: [] }) }
    const result = await createOrchestrator().handle(gatewayFor('read', 'two providers'), 'what do i have', emptyContext, {
      mode: 'ask',
      researcher,
    })
    // Reads are allowed in ask mode and still gather evidence; only changes are withheld.
    expect(result.outcome.kind).toBe('answer')
    expect(researcher.gather).toHaveBeenCalledTimes(1)
  })

  it('plans normally in agent mode (the default)', async () => {
    const plan = {
      summary: 'Connect GitHub',
      steps: [{ id: 's1', capability: 'connectProvider', args: { name: 'GitHub', kind: 'api_key' } }],
    }
    const result = await createOrchestrator().handle(planningGateway('change', plan), 'connect github', emptyContext, { mode: 'agent' })
    expect(result.outcome.kind).toBe('plan')
  })
})
