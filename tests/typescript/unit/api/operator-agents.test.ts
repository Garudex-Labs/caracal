// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the Operator agents: intent routing, planning, and explanation.

import { describe, it, expect, vi } from 'vitest'
import {
  buildPlannerMessages,
  buildExplainerMessages,
  buildTroubleshooterMessages,
  buildTranslatorMessages,
  buildSecurityAnalystMessages,
  buildVerifierMessages,
  buildTriageMessages,
  runTriage,
  tierPlans,
  tierReadsState,
  tierComposes,
  runPlanner,
  runExplainer,
  runTroubleshooter,
  runTranslator,
  runSecurityAnalyst,
  runVerifier,
} from '../../../../apps/api/src/operator-agents.js'
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

describe('runTriage', () => {
  it('returns the classified tier and topic', async () => {
    const { gateway } = gatewayProducing({ tier: 'change', topic: 'general' })
    expect(await runTriage(gateway, 'connect github')).toEqual({ ok: true, value: { tier: 'change', topic: 'general' } })
  })

  it('classifies a read question into the read tier', async () => {
    const { gateway } = gatewayProducing({ tier: 'read', topic: 'general' })
    expect(await runTriage(gateway, 'what providers do I have')).toEqual({ ok: true, value: { tier: 'read', topic: 'general' } })
  })

  it('classifies a diagnostic read with the diagnostic topic', async () => {
    const { gateway } = gatewayProducing({ tier: 'read', topic: 'diagnostic' })
    expect(await runTriage(gateway, 'why was my agent denied')).toEqual({ ok: true, value: { tier: 'read', topic: 'diagnostic' } })
  })

  it('defaults the topic to general when the model omits it', async () => {
    const { gateway } = gatewayProducing({ tier: 'read' })
    expect(await runTriage(gateway, 'what is in my zone')).toEqual({ ok: true, value: { tier: 'read', topic: 'general' } })
  })

  it('carries the relevant domains when the model names them', async () => {
    const { gateway } = gatewayProducing({ tier: 'read', topic: 'general', domains: ['provider', 'resource'] })
    expect(await runTriage(gateway, 'what providers and resources do I have')).toEqual({
      ok: true,
      value: { tier: 'read', topic: 'general', domains: ['provider', 'resource'] },
    })
  })

  it('omits domains entirely when the model returns an empty set', async () => {
    const { gateway } = gatewayProducing({ tier: 'conversational', topic: 'general', domains: [] })
    expect(await runTriage(gateway, 'hi')).toEqual({ ok: true, value: { tier: 'conversational', topic: 'general' } })
  })

  it('fails closed when classification does not pass the schema', async () => {
    const { gateway } = gatewayProducing(new Error('schema validation failed'))
    const result = await runTriage(gateway, 'hmm')
    expect(result.ok).toBe(false)
  })
})

describe('tierPlans', () => {
  it('plans only for change and compound tiers', () => {
    expect(tierPlans('change')).toBe(true)
    expect(tierPlans('compound')).toBe(true)
    expect(tierPlans('conversational')).toBe(false)
    expect(tierPlans('read')).toBe(false)
  })
})

describe('buildTriageMessages', () => {
  it('names every tier so the model classifies into the smallest sufficient one', () => {
    const system = buildTriageMessages('hello')[0].content
    expect(system).toContain('conversational')
    expect(system).toContain('read')
    expect(system).toContain('change')
    expect(system).toContain('compound')
  })

  it('names the read topics so the model can route to a specialist', () => {
    const system = buildTriageMessages('hello')[0].content
    expect(system).toContain('diagnostic')
    expect(system).toContain('integration')
    expect(system).toContain('general')
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

  it('grounds the planner with durable zone memory carried across conversations', () => {
    const messages = buildPlannerMessages('register the billing app', {
      facts: null,
      state: null,
      zoneMemory: [
        { text: 'Connect the Hooli OIDC provider', created_at: '2026-06-01T00:00:00Z' },
        { text: 'Register the Son of Anton application', created_at: '2026-06-02T00:00:00Z' },
      ],
    })
    const content = messages[1].content
    expect(content).toContain('Durable zone memory')
    expect(content).toContain('Connect the Hooli OIDC provider')
    expect(content).toContain('Register the Son of Anton application')
  })
})

describe('buildExplainerMessages', () => {
  it('grounds the answer in live state evidence with names and counts', () => {
    const messages = buildExplainerMessages('what providers do i have', {
      facts: null,
      state: null,
      evidence: [
        { capability: 'listProviders', domain: 'provider', ok: true, count: 2, names: ['GitHub', 'Stripe'] },
        { capability: 'listResources', domain: 'resource', ok: true, count: 0, names: [] },
      ],
    })
    const content = messages[1].content
    expect(content).toContain('Live state (read just now)')
    expect(content).toContain('provider (2): GitHub, Stripe')
    expect(content).toContain('resource: none')
    // The system prompt instructs the model to ground in the live state and not invent entities.
    expect(messages[0].content).toContain('do not invent')
  })

  it('truncates the names list while keeping the live count', () => {
    const messages = buildExplainerMessages('list apps', {
      facts: null,
      state: null,
      evidence: [{ capability: 'listApplications', domain: 'application', ok: true, count: 9, names: ['a', 'b', 'c'] }],
    })
    expect(messages[1].content).toContain('application (9): a, b, c, …')
  })

  it('reports a read that could not be gathered without failing the answer', () => {
    const messages = buildExplainerMessages('what policies', {
      facts: null,
      state: null,
      evidence: [{ capability: 'listPolicies', domain: 'policy', ok: false, error: 'missing scope control:policy:read' }],
    })
    expect(messages[1].content).toContain('policy: could not read (missing scope control:policy:read)')
  })

  it('omits the live state block when no evidence was gathered', () => {
    const messages = buildExplainerMessages('what is a zone', { facts: null, state: null })
    expect(messages[1].content).not.toContain('Live state')
  })
})

describe('shared prompt foundations', () => {
  // The ground-up rewrite gives every reasoning agent the same identity, platform model, behavioral
  // spine, and documentation discipline, so they reason from a correct model of Caracal rather than
  // pattern-matching. These assertions lock that foundation into the substantive agents.
  const ctx = { facts: null, state: null }
  const reasoningAgents: [string, string][] = [
    ['planner', buildPlannerMessages('connect github', ctx)[0].content],
    ['explainer', buildExplainerMessages('what is a zone', ctx)[0].content],
    ['troubleshooter', buildTroubleshooterMessages('why was my agent denied', ctx)[0].content],
    ['translator', buildTranslatorMessages('connect github', ctx)[0].content],
  ]

  it('gives every reasoning agent the Operator persona and the Caracal platform model', () => {
    for (const [, system] of reasoningAgents) {
      expect(system).toContain('Caracal Operator')
      // The authority model is the spine of the platform knowledge core.
      expect(system).toContain('Granting authority and using authority are separate')
      // The behavioral spine: reason about real intent, not the literal ask.
      expect(system).toContain('Solve for the goal behind the words')
    }
  })

  it('gives the text-answering agents the documentation discipline with a canonical page map', () => {
    for (const system of [reasoningAgents[1][1], reasoningAgents[2][1], reasoningAgents[3][1]]) {
      expect(system).toContain('USING DOCUMENTATION')
      expect(system).toContain('single most relevant page')
      expect(system).toContain('/concepts/authority-model')
    }
  })

  it('keeps the planner and security analyst on a strict JSON-only output contract', () => {
    expect(buildPlannerMessages('do it', ctx)[0].content).toContain('Reply with ONLY a JSON object')
    expect(buildSecurityAnalystMessages({ summary: 's', steps: [] }, ctx)[0].content).toContain('Reply with ONLY a JSON object')
  })
})

describe('tierReadsState', () => {
  it('reads state only for the read tier', () => {
    expect(tierReadsState('read')).toBe(true)
    expect(tierReadsState('conversational')).toBe(false)
    expect(tierReadsState('change')).toBe(false)
    expect(tierReadsState('compound')).toBe(false)
  })
})

describe('tierComposes', () => {
  it('composes specialists only for the compound tier', () => {
    expect(tierComposes('compound')).toBe(true)
    expect(tierComposes('change')).toBe(false)
    expect(tierComposes('read')).toBe(false)
    expect(tierComposes('conversational')).toBe(false)
  })
})

describe('buildSecurityAnalystMessages', () => {
  const plan = {
    summary: 'Grant Finance read-only Stripe invoices',
    steps: [{ id: 's1', capability: 'grantAccess', args: { application_id: 'app-1', resource_id: 'res-1', scopes: ['invoices:read'] } }],
  }

  it('renders the plan steps and arguments for review', () => {
    const messages = buildSecurityAnalystMessages(plan, { facts: null, state: null })
    const content = messages[1].content
    expect(content).toContain('grantAccess')
    expect(content).toContain('invoices:read')
    // The review is framed as advisory and never blocking.
    expect(messages[0].content).toContain('advisory')
    expect(messages[0].content).toContain('over-grant')
  })

  it('includes live state evidence so the review judges against current state', () => {
    const messages = buildSecurityAnalystMessages(plan, {
      facts: null,
      state: null,
      evidence: [{ capability: 'listResources', domain: 'resource', ok: true, count: 1, names: ['Stripe invoices'] }],
    })
    expect(messages[1].content).toContain('Live state (read just now)')
    expect(messages[1].content).toContain('Stripe invoices')
  })
})

describe('runSecurityAnalyst', () => {
  const plan = { summary: 'Grant access', steps: [{ id: 's1', capability: 'grantAccess', args: {} }] }

  it('returns the advisory summary and findings', async () => {
    const { gateway } = gatewayProducing({
      summary: 'The grant is broader than the request implies.',
      findings: [{ severity: 'caution', concern: 'Write scope requested where read would suffice.' }],
    })
    const result = await runSecurityAnalyst(gateway, plan, { facts: null, state: null })
    expect(result).toEqual({
      ok: true,
      value: {
        summary: 'The grant is broader than the request implies.',
        findings: [{ severity: 'caution', concern: 'Write scope requested where read would suffice.' }],
      },
    })
  })

  it('accepts a clean review with no findings', async () => {
    const { gateway } = gatewayProducing({ summary: 'The plan is least-privilege and well-scoped.', findings: [] })
    const result = await runSecurityAnalyst(gateway, plan, { facts: null, state: null })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.findings).toEqual([])
  })

  it('fails closed when the review is off-schema, so no advisory is attached', async () => {
    const { gateway } = gatewayProducing(new Error('schema validation failed'))
    const result = await runSecurityAnalyst(gateway, plan, { facts: null, state: null })
    expect(result.ok).toBe(false)
  })
})

describe('buildVerifierMessages', () => {
  const plan = {
    summary: 'Register the Billing application',
    steps: [{ id: 's1', capability: 'registerApplication', args: { name: 'Billing' } }],
  }

  it('renders the applied plan and frames the turn as post-execution verification', () => {
    const messages = buildVerifierMessages(plan, { facts: null, state: null })
    expect(messages[0].content).toContain('POST-EXECUTION VERIFICATION')
    expect(messages[1].content).toContain('Applied plan')
    expect(messages[1].content).toContain('registerApplication')
    expect(messages[1].content).toContain('Billing')
  })

  it('includes the live state read after the apply so the verdict judges against current state', () => {
    const messages = buildVerifierMessages(plan, {
      facts: null,
      state: null,
      evidence: [{ capability: 'listApplications', domain: 'application', ok: true, count: 1, names: ['Billing'] }],
    })
    expect(messages[1].content).toContain('Live state (read just now)')
    expect(messages[1].content).toContain('Billing')
  })
})

describe('runVerifier', () => {
  const plan = {
    summary: 'Register the Billing application',
    steps: [{ id: 's1', capability: 'registerApplication', args: { name: 'Billing' } }],
  }

  it('returns a matched verdict when live state reflects the applied plan', async () => {
    const { gateway } = gatewayProducing({
      status: 'matched',
      summary: 'The Billing application is present in current state.',
      findings: [],
    })
    const result = await runVerifier(gateway, plan, { facts: null, state: null })
    expect(result).toEqual({
      ok: true,
      value: { status: 'matched', summary: 'The Billing application is present in current state.', findings: [] },
    })
  })

  it('returns a drifted verdict with a corrective follow-up when state diverges from intent', async () => {
    const { gateway } = gatewayProducing({
      status: 'drifted',
      summary: 'The application the plan should have registered is not present.',
      findings: [{ observation: 'No application named Billing appears in the live read.' }],
      followUp: 'Re-run the registration for the Billing application.',
    })
    const result = await runVerifier(gateway, plan, { facts: null, state: null })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.status).toBe('drifted')
      expect(result.value.followUp).toBe('Re-run the registration for the Billing application.')
    }
  })

  it('fails closed when the verdict is off-schema, so the turn is left unverified', async () => {
    const { gateway } = gatewayProducing(new Error('schema validation failed'))
    const result = await runVerifier(gateway, plan, { facts: null, state: null })
    expect(result.ok).toBe(false)
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

describe('buildTroubleshooterMessages', () => {
  it('frames a diagnosis grounded in evidence and recent activity, never acting', () => {
    const messages = buildTroubleshooterMessages('why was my agent denied', {
      facts: null,
      state: null,
      evidence: [{ capability: 'listResources', domain: 'resource', ok: true, count: 1, names: ['Stripe invoices'] }],
    })
    const system = messages[0].content
    expect(system).toContain('troubleshooting')
    expect(system).toContain('denied')
    expect(system).toContain('never make changes')
    expect(messages[1].content).toContain('Live state (read just now)')
  })
})

describe('runTroubleshooter', () => {
  it('returns the diagnostic answer text', async () => {
    const { gateway } = gatewayReturning('  No grant exists yet for that resource.  ')
    const result = await runTroubleshooter(gateway, 'why denied', { facts: null, state: null })
    expect(result).toEqual({ ok: true, value: { text: 'No grant exists yet for that resource.', reasoning: undefined } })
  })

  it('fails closed on an empty answer', async () => {
    const { gateway } = gatewayReturning('   ')
    const result = await runTroubleshooter(gateway, 'why', { facts: null, state: null })
    expect(result).toMatchObject({ ok: false })
  })
})

describe('buildTranslatorMessages', () => {
  it('grounds integration guidance in the capability catalog and never acts', () => {
    const messages = buildTranslatorMessages('how do I connect GitHub', { facts: null, state: null })
    const system = messages[0].content
    // The new translator prompt maps a real-world integration onto Caracal's model: it names the
    // provider auth modes and the stable resource identifier convention, drawing connection kinds
    // from the real catalog, and it never acts.
    expect(system).toContain('oauth2_client_credentials')
    expect(system).toContain('resource://')
    expect(system).toContain('connectProvider')
    expect(system).toContain('never make changes')
  })
})

describe('runTranslator', () => {
  it('returns the integration guidance text', async () => {
    const { gateway } = gatewayReturning('  Connect GitHub as an OAuth authorization-code provider.  ')
    const result = await runTranslator(gateway, 'how do I connect GitHub', { facts: null, state: null })
    expect(result).toEqual({ ok: true, value: { text: 'Connect GitHub as an OAuth authorization-code provider.', reasoning: undefined } })
  })

  it('fails closed on an empty answer', async () => {
    const { gateway } = gatewayReturning('   ')
    const result = await runTranslator(gateway, 'how', { facts: null, state: null })
    expect(result).toMatchObject({ ok: false })
  })
})
