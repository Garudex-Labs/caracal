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
// triage tier, the planner's plan, the correctness critic's verdict, then the security analyst's
// advisory.
function composingGateway(plan: object, advisory: object): Gateway {
  const completeObject = vi
    .fn()
    .mockResolvedValueOnce({ value: { tier: 'compound' }, provider: 't', model: 'm' })
    .mockResolvedValueOnce({ value: plan, provider: 't', model: 'm' })
    .mockResolvedValueOnce({ value: { verdict: 'sound', summary: 'Plan achieves the goal.', deficiencies: [] }, provider: 't', model: 'm' })
    .mockResolvedValueOnce({ value: advisory, provider: 't', model: 'm' })
  return { status: () => ({ enabled: true, providers: [] }), completeObject } as unknown as Gateway
}

// A gateway whose triage classifies as the policy tier and whose next structured completion is the
// policy specialist's authored draft.
function policyGateway(draft: object): Gateway {
  const completeObject = vi
    .fn()
    .mockResolvedValueOnce({ value: { tier: 'policy' }, provider: 't', model: 'm' })
    .mockResolvedValueOnce({ value: draft, provider: 't', model: 'm' })
  return { status: () => ({ enabled: true, providers: [] }), completeObject } as unknown as Gateway
}

// A valid Caracal data document the policy specialist can author: the directive, package
// caracal.authz, and one data rule that is not `result`.
const POLICY_DOC = [
  '# caracal:data-document',
  'package caracal.authz',
  '',
  'import rego.v1',
  '',
  'grants := {"resource://nucleus": {"application": "reporting", "roles": {"reader": ["nucleus:read"]}}}',
].join('\n')

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

  it('maps the policy tier to the policy-authoring skill', () => {
    const registry = createSkillRegistry()
    const skill = registry.select({ tier: 'policy', topic: 'general' })
    expect(skill.kind).toBe('policy')
    expect(skill.id).toBe('policy-author')
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

  it('authors a validated draft for a policy tier and emits the authoring stage', async () => {
    const draft = {
      summary: 'Grant reporting read on Nucleus.',
      intent: 'Give reporting read-only access to Nucleus.',
      documents: [{ concern: 'reporting read grant', filename: 'grants.rego', content: POLICY_DOC, explanation: 'Binds reporting to a reader role.' }],
    }
    const stages: string[] = []
    const result = await createOrchestrator().handle(policyGateway(draft), 'write a policy giving reporting read on nucleus', emptyContext, {
      onProgress: (event) => stages.push(event.stage),
    })
    expect(result.tier).toBe('policy')
    expect(result.outcome.kind).toBe('policy')
    if (result.outcome.kind === 'policy') {
      expect(result.outcome.result.ok).toBe(true)
      if (result.outcome.result.ok) {
        expect(result.outcome.result.value.documents).toHaveLength(1)
        expect(result.outcome.result.value.provenance.aiAssisted).toBe(true)
      }
    }
    expect(stages).toContain('authoring')
  })

  it('streams answer tokens to onAnswerDelta while still returning the assembled answer', async () => {
    const completeObject = vi.fn().mockResolvedValue({ value: { tier: 'read', topic: 'general' }, provider: 't', model: 'm' })
    const stream = vi.fn(async (_messages: unknown, handlers: { onText: (chunk: string) => void }) => {
      handlers.onText('the ')
      handlers.onText('full ')
      handlers.onText('answer')
      return { text: 'the full answer', provider: 't', model: 'm' } satisfies CompletionResult
    })
    const gateway = { status: () => ({ enabled: true, providers: [] }), completeObject, stream } as unknown as Gateway
    const deltas: string[] = []
    const result = await createOrchestrator().handle(gateway, 'why denied', emptyContext, {
      onAnswerDelta: (chunk) => deltas.push(chunk),
    })
    expect(result.outcome.kind).toBe('answer')
    expect(deltas.join('')).toBe('the full answer')
    if (result.outcome.kind === 'answer' && result.outcome.result.ok) {
      expect(result.outcome.result.value.text).toContain('the full answer')
    }
  })

  it('streams reasoning deltas to onReasoningDelta alongside the answer', async () => {
    const completeObject = vi.fn().mockResolvedValue({ value: { tier: 'read', topic: 'general' }, provider: 't', model: 'm' })
    const stream = vi.fn(
      async (_messages: unknown, handlers: { onText: (chunk: string) => void; onReasoning?: (chunk: string) => void }) => {
        handlers.onReasoning?.('weighing ')
        handlers.onReasoning?.('options')
        handlers.onText('the answer')
        return { text: 'the answer', reasoning: 'weighing options', provider: 't', model: 'm' } satisfies CompletionResult
      },
    )
    const gateway = { status: () => ({ enabled: true, providers: [] }), completeObject, stream } as unknown as Gateway
    const thinking: string[] = []
    const result = await createOrchestrator().handle(gateway, 'why denied', emptyContext, {
      onAnswerDelta: () => {},
      onReasoningDelta: (chunk) => thinking.push(chunk),
    })
    expect(result.outcome.kind).toBe('answer')
    expect(thinking.join('')).toBe('weighing options')
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

  it('relays a planner clarification as an answer instead of an actionable plan', async () => {
    const clarification = {
      summary: 'Need to know which resource to grant access to',
      steps: [],
      clarification: 'Which resource should the application be granted access to?',
    }
    const result = await createOrchestrator().handle(planningGateway('change', clarification), 'grant access', emptyContext)
    expect(result.tier).toBe('change')
    expect(result.outcome.kind).toBe('answer')
    if (result.outcome.kind === 'answer') {
      expect(result.outcome.result.ok).toBe(true)
      if (result.outcome.result.ok) {
        expect(result.outcome.result.value.text).toBe('Which resource should the application be granted access to?')
      }
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

  it('grounds a plan in retrieved documentation passed to the planner', async () => {
    const docs = [
      {
        id: '/guides/provider-recipes',
        title: 'Provider recipes',
        url: 'https://docs/x',
        snippet: 'Use oauth2_client_credentials for service-to-service.',
      },
    ]
    const retriever = vi.fn().mockReturnValue(docs)
    let seenDocs: unknown
    const registry: SkillRegistry = {
      select: () => ({
        id: 'probe',
        kind: 'plan',
        run: async (_g, _m, context) => {
          seenDocs = context.docs
          return { ok: true, value: { summary: 'noop', steps: [] } }
        },
      }),
    }
    await createOrchestrator(registry).handle(planningGateway('change', {}), 'connect github with client credentials', emptyContext, {
      docs: retriever,
    })
    // Planning grounds in the real documentation too, so the planner quotes exact provider auth
    // modes, scopes, and recipes rather than inventing them: the retriever is queried with the
    // request and its passages reach the planning skill's context.
    expect(retriever).toHaveBeenCalledWith('connect github with client credentials')
    expect(seenDocs).toEqual(docs)
  })

  it('appends a Caracal correction when the grounding check finds a read answer ungrounded', async () => {
    // completeObject returns the read triage, then the grounding verdict; the answer skill draws its
    // text from complete. The answer claims a provider that the evidence shows does not exist.
    const completeObject = vi
      .fn()
      .mockResolvedValueOnce({ value: { tier: 'read', topic: 'general' }, provider: 't', model: 'm' })
      .mockResolvedValueOnce({
        value: { grounded: false, correction: 'No Stripe provider exists in this zone.' },
        provider: 't',
        model: 'm',
      })
    const complete = vi.fn().mockResolvedValue({ text: 'You have a Stripe provider connected.', provider: 't', model: 'm' })
    const gateway = { status: () => ({ enabled: true, providers: [] }), complete, completeObject } as unknown as Gateway
    const evidence = [{ capability: 'listProviders', domain: 'provider', ok: true, count: 0, names: [] }]
    const researcher = { gather: vi.fn().mockResolvedValue({ evidence }) }
    const result = await createOrchestrator().handle(gateway, 'do i have stripe', emptyContext, { researcher })
    expect(result.outcome.kind).toBe('answer')
    if (result.outcome.kind === 'answer' && result.outcome.result.ok) {
      // The original answer stands and Caracal appends the grounding correction so the user is not misled.
      expect(result.outcome.result.value.text).toContain('You have a Stripe provider connected.')
      expect(result.outcome.result.value.text).toContain('Correction: No Stripe provider exists in this zone.')
    }
  })

  it('leaves a grounded read answer unchanged', async () => {
    const completeObject = vi
      .fn()
      .mockResolvedValueOnce({ value: { tier: 'read', topic: 'general' }, provider: 't', model: 'm' })
      .mockResolvedValueOnce({ value: { grounded: true }, provider: 't', model: 'm' })
    const complete = vi.fn().mockResolvedValue({ text: 'You have one provider: GitHub.', provider: 't', model: 'm' })
    const gateway = { status: () => ({ enabled: true, providers: [] }), complete, completeObject } as unknown as Gateway
    const evidence = [{ capability: 'listProviders', domain: 'provider', ok: true, count: 1, names: ['GitHub'] }]
    const researcher = { gather: vi.fn().mockResolvedValue({ evidence }) }
    const result = await createOrchestrator().handle(gateway, 'what providers do i have', emptyContext, { researcher })
    if (result.outcome.kind === 'answer' && result.outcome.result.ok) {
      expect(result.outcome.result.value.text).toBe('You have one provider: GitHub.')
    }
  })

  it('does not run the grounding check when no evidence was gathered', async () => {
    // A conversational turn reads no state, so there is nothing to ground against and the check is
    // skipped — only the single triage completeObject call is made, never a grounding call.
    const gateway = gatewayFor('conversational', 'Caracal issues short-lived scoped mandates.')
    const result = await createOrchestrator().handle(gateway, 'what is a mandate', emptyContext)
    if (result.outcome.kind === 'answer' && result.outcome.result.ok) {
      expect(result.outcome.result.value.text).toBe('Caracal issues short-lived scoped mandates.')
    }
    expect(gateway.completeObject as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1)
  })

  it('reads the domains the planner asks for and replans once on the gathered evidence', async () => {
    // The planner first declines to plan and names the domains it must see; Caracal reads exactly
    // those, merges the evidence, and runs the planner again, which now proposes a real plan.
    const plan = {
      summary: 'Register the application',
      steps: [{ id: 's1', capability: 'registerApplication', args: { name: 'Son of Anton' } }],
    }
    const completeObject = vi
      .fn()
      .mockResolvedValueOnce({ value: { tier: 'change' }, provider: 't', model: 'm' })
      .mockResolvedValueOnce({
        value: { summary: 'Need the live objects first', steps: [], needs: { domains: ['resource', 'application'] } },
        provider: 't',
        model: 'm',
      })
      .mockResolvedValueOnce({ value: plan, provider: 't', model: 'm' })
      .mockResolvedValueOnce({
        value: { verdict: 'sound', summary: 'Plan achieves the goal.', deficiencies: [] },
        provider: 't',
        model: 'm',
      })
      .mockResolvedValueOnce({ value: { summary: 'No concerns.', findings: [] }, provider: 't', model: 'm' })
    const gateway = { status: () => ({ enabled: true, providers: [] }), completeObject } as unknown as Gateway
    const researcher = {
      gather: vi
        .fn()
        .mockResolvedValueOnce({ evidence: [] })
        .mockResolvedValueOnce({ evidence: [{ capability: 'listResources', domain: 'resource', ok: true, count: 1, names: ['Nucleus'] }] }),
    }
    const result = await createOrchestrator().handle(gateway, 'register the application', emptyContext, { researcher })
    expect(researcher.gather).toHaveBeenCalledTimes(2)
    expect(researcher.gather).toHaveBeenLastCalledWith(['resource', 'application'])
    expect(result.outcome.kind).toBe('plan')
    if (result.outcome.kind === 'plan' && result.outcome.result.ok) {
      expect(result.outcome.result.value.steps).toHaveLength(1)
    }
  })

  it('does not expand evidence when no researcher can read the requested domains', async () => {
    // The planner asks to see more state, but the turn has no researcher, so Caracal cannot read and
    // the empty plan stands — the planner is never called a second time.
    const completeObject = vi
      .fn()
      .mockResolvedValueOnce({ value: { tier: 'change' }, provider: 't', model: 'm' })
      .mockResolvedValueOnce({
        value: { summary: 'Need the live objects first', steps: [], needs: { domains: ['resource'] } },
        provider: 't',
        model: 'm',
      })
    const gateway = { status: () => ({ enabled: true, providers: [] }), completeObject } as unknown as Gateway
    const result = await createOrchestrator().handle(gateway, 'register the application', emptyContext)
    expect(completeObject).toHaveBeenCalledTimes(2)
    expect(result.outcome.kind).toBe('plan')
    if (result.outcome.kind === 'plan' && result.outcome.result.ok) {
      expect(result.outcome.result.value.steps).toHaveLength(0)
    }
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

  it('leads with guidance when the guardian judges a plan misaligned, keeping the plan approvable', async () => {
    const plan = {
      summary: 'Expose the internal billing resource publicly',
      steps: [
        {
          id: 's1',
          capability: 'grantAccess',
          args: { application_id: 'app_public', user_id: 'user_anon', resource_id: 'res_billing', scopes: ['write'] },
        },
      ],
    }
    const advisory = {
      summary: 'Exposes an internal resource broadly — a Caracal anti-pattern.',
      alignment: 'misaligned',
      findings: [{ severity: 'warning', concern: 'public exposure of an internal resource' }],
      recommendation: 'Model a narrow scoped grant to the specific application instead of public write access.',
    }
    const result = await createOrchestrator().handle(
      composingGateway(plan, advisory),
      'just give everyone write access to billing',
      emptyContext,
    )
    expect(result.outcome.kind).toBe('plan')
    if (result.outcome.kind === 'plan') {
      // The plan is still produced and still approvable behind the human gate — guidance leads, it
      // does not delete the plan.
      expect(result.outcome.result.ok).toBe(true)
      expect(result.outcome.advisory).toEqual(advisory)
      // The misaligned verdict demotes the turn to teach the Caracal-correct path first.
      expect(result.outcome.guidance).toBe(advisory.recommendation)
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
      .mockResolvedValueOnce({
        value: { verdict: 'sound', summary: 'Plan achieves the goal.', deficiencies: [] },
        provider: 't',
        model: 'm',
      })
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
      .mockResolvedValueOnce({
        value: { verdict: 'sound', summary: 'Plan achieves the goal.', deficiencies: [] },
        provider: 't',
        model: 'm',
      })
      .mockResolvedValueOnce({ value: advisory, provider: 't', model: 'm' })
    const gateway = { status: () => ({ enabled: true, providers: [] }), completeObject } as unknown as Gateway
    const result = await createOrchestrator().handle(gateway, 'connect github', emptyContext)
    // A first proposal that fails catalog validation triggers exactly one repair pass; the corrected
    // plan replaces it before the guardian and the route ever see it.
    expect(result.outcome.kind).toBe('plan')
    if (result.outcome.kind === 'plan' && result.outcome.result.ok) {
      expect(result.outcome.result.value.steps[0].capability).toBe('connectProvider')
    }
    // triage + first plan + repair plan + correctness critic + guardian review.
    expect(completeObject).toHaveBeenCalledTimes(5)
  })

  it('revises a catalog-valid plan when the correctness critic finds a material defect', async () => {
    const firstPlan = {
      summary: 'Connect GitHub with a static key',
      steps: [{ id: 's1', capability: 'connectProvider', args: { name: 'GitHub', kind: 'api_key' } }],
    }
    const revisedPlan = {
      summary: 'Connect GitHub over OAuth',
      steps: [{ id: 's1', capability: 'connectProvider', args: { name: 'GitHub', kind: 'oauth2_authorization_code' } }],
    }
    const critique = {
      verdict: 'revise',
      summary: 'A static key is the wrong auth mode for GitHub.',
      deficiencies: [{ issue: 'GitHub should be connected over OAuth, not with a static api_key.' }],
    }
    const completeObject = vi
      .fn()
      .mockResolvedValueOnce({ value: { tier: 'change' }, provider: 't', model: 'm' })
      .mockResolvedValueOnce({ value: firstPlan, provider: 't', model: 'm' })
      .mockResolvedValueOnce({ value: critique, provider: 't', model: 'm' })
      .mockResolvedValueOnce({ value: revisedPlan, provider: 't', model: 'm' })
    const gateway = { status: () => ({ enabled: true, providers: [] }), completeObject } as unknown as Gateway
    const result = await createOrchestrator().handle(gateway, 'connect github', emptyContext)
    expect(result.outcome.kind).toBe('plan')
    if (result.outcome.kind === 'plan' && result.outcome.result.ok) {
      // The critic-driven revision replaces the catalog-valid first plan before the guardian and the
      // route ever see it, because the revision still proposes steps and still validates.
      expect(result.outcome.result.value.summary).toBe('Connect GitHub over OAuth')
      expect(result.outcome.result.value.steps[0].args.kind).toBe('oauth2_authorization_code')
    }
    // triage + first plan + correctness critic + revised plan + guardian review.
    expect(completeObject).toHaveBeenCalledTimes(5)
  })

  it('keeps a plan the correctness critic judges sound without a revision pass', async () => {
    const plan = {
      summary: 'Connect GitHub',
      steps: [{ id: 's1', capability: 'connectProvider', args: { name: 'GitHub', kind: 'api_key' } }],
    }
    const completeObject = vi
      .fn()
      .mockResolvedValueOnce({ value: { tier: 'change' }, provider: 't', model: 'm' })
      .mockResolvedValueOnce({ value: plan, provider: 't', model: 'm' })
      .mockResolvedValueOnce({
        value: { verdict: 'sound', summary: 'Plan achieves the goal.', deficiencies: [] },
        provider: 't',
        model: 'm',
      })
      .mockResolvedValueOnce({ value: { summary: 'Narrow and aligned.', findings: [] }, provider: 't', model: 'm' })
    const gateway = { status: () => ({ enabled: true, providers: [] }), completeObject } as unknown as Gateway
    const result = await createOrchestrator().handle(gateway, 'connect github', emptyContext)
    expect(result.outcome.kind).toBe('plan')
    if (result.outcome.kind === 'plan' && result.outcome.result.ok) {
      expect(result.outcome.result.value.summary).toBe('Connect GitHub')
    }
    // triage + plan + sound critic + guardian — a sound verdict adds no revision planner pass.
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
      .mockResolvedValueOnce({
        value: { verdict: 'sound', summary: 'Plan achieves the goal.', deficiencies: [] },
        provider: 't',
        model: 'm',
      })
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

  it('refuses to author a policy in ask mode and answers with a switch-to-agent message', async () => {
    // The gateway would author a draft, but ask mode short-circuits before the specialist: a policy
    // draft's only action is a governed create the ask-mode write path rejects, so no draft is
    // surfaced. Only triage runs and the deterministic switch-to-agent answer is returned.
    const draft = {
      summary: 'Reporting read on nucleus',
      documents: [{ concern: 'reporting read grant', filename: 'grants.rego', content: POLICY_DOC, explanation: 'Binds reporting to a reader role.' }],
    }
    const gateway = policyGateway(draft)
    const result = await createOrchestrator().handle(gateway, 'write a policy giving reporting read on nucleus', emptyContext, { mode: 'ask' })
    expect(result.tier).toBe('policy')
    expect(result.outcome.kind).toBe('answer')
    if (result.outcome.kind === 'answer') {
      expect(result.outcome.result.ok).toBe(true)
      if (result.outcome.result.ok) expect(result.outcome.result.value.text).toBe(ASK_MODE_CHANGE_MESSAGE)
    }
    // Only triage ran; the policy specialist was never called, so no draft was authored.
    expect((gateway.completeObject as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1)
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

  it('emits the deliberation stages of a plan turn in order to a progress listener', async () => {
    const plan = {
      summary: 'Connect GitHub',
      steps: [{ id: 's1', capability: 'connectProvider', args: { name: 'GitHub', kind: 'api_key' } }],
    }
    const advisory = { summary: 'Narrow and aligned.', findings: [] }
    const stages: string[] = []
    await createOrchestrator().handle(composingGateway(plan, advisory), 'connect github', emptyContext, {
      researcher: { gather: vi.fn().mockResolvedValue({ evidence: [] }) },
      onProgress: (event) => stages.push(event.stage),
    })
    // A clean plan walks triage → gather → plan → critique → guard; no repair or revise pass runs
    // because the first proposal validates and the critic finds it sound.
    expect(stages).toEqual(['triaging', 'gathering', 'planning', 'critiquing', 'guarding'])
  })

  it('emits the read stages and never a plan stage for an answer turn', async () => {
    const stages: string[] = []
    await createOrchestrator().handle(gatewayFor('read', 'two providers'), 'what do i have', emptyContext, {
      researcher: { gather: vi.fn().mockResolvedValue({ evidence: [] }) },
      onProgress: (event) => stages.push(event.stage),
    })
    // A read turn triages, gathers state, and answers — it never enters the planning stages.
    expect(stages).toEqual(['triaging', 'gathering', 'answering'])
  })

  it('emits no gathering stage for a conversational turn that reads no state', async () => {
    const stages: string[] = []
    await createOrchestrator().handle(gatewayFor('conversational'), 'hi', emptyContext, {
      onProgress: (event) => stages.push(event.stage),
    })
    expect(stages).toEqual(['triaging', 'answering'])
  })
})
