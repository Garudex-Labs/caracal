// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// The Operator agent layer: purpose-built agents that turn intent into typed artifacts the deterministic engine governs.

import { z } from 'zod'
import { describeCapabilitiesForPrompt, ProposedPlan, type ProposedPlanInput } from './operator-capabilities.js'
import type { ConversationState } from './operator-state.js'
import { describeFacts, type ConversationFacts } from './operator-memory.js'
import type { Evidence } from './operator-research.js'
import type { Gateway, GatewayMessage } from './operator-gateway.js'

// The agents never hold authority. Each one produces a typed artifact — an intent,
// a proposed plan, or an explanation — that the deterministic pipeline then
// validates, previews, and governs. A model can propose; only Caracal decides.

const TRIAGE_MAX_TOKENS = 16
const PLANNER_MAX_TOKENS = 800
const EXPLAINER_MAX_TOKENS = 600

// The handling tier a request is triaged into: the smallest sufficient path, so a simple turn
// never pays the planning pipeline. conversational and read are answered directly as text;
// change and compound produce a proposed plan. The four tiers are the stable taxonomy the
// orchestration grows into — later phases add specialist skills and parallel composition for
// the compound tier without changing this classification.
export type OperatorTier = 'conversational' | 'read' | 'change' | 'compound'

export type AgentResult<T> = { ok: true; value: T } | { ok: false; error: string }

// Whether a tier produces a state-changing plan. conversational and read are read-only and are
// answered as text; change and compound flow through propose → preview → decide → apply. This
// is the single deterministic branch the orchestrator takes on a triaged tier.
export function tierPlans(tier: OperatorTier): boolean {
  return tier === 'change' || tier === 'compound'
}

// Whether a tier should be grounded in freshly read live state. read inspects current state, so
// it is gathered through governed reads before answering; conversational is greetings, concepts,
// and capability questions that need no state read, so it pays nothing.
export function tierReadsState(tier: OperatorTier): boolean {
  return tier === 'read'
}

const TriageOutput = z.object({ tier: z.enum(['conversational', 'read', 'change', 'compound']) }).strict()

export function buildTriageMessages(message: string): GatewayMessage[] {
  return [
    {
      role: 'system',
      content:
        'You triage a Caracal operator request into the smallest sufficient handling tier. Reply ' +
        'with ONLY a JSON object {"tier":"<tier>"} and no prose. Tiers:\n' +
        '- "conversational": a greeting, small talk, an acknowledgement, a question about what you ' +
        "can do, or a clarifying question — nothing about the operator's actual Caracal state.\n" +
        '- "read": a question that inspects or explains current state or a past decision, changing ' +
        'nothing.\n' +
        '- "change": a request to create, connect, rotate, grant, or set up ONE thing.\n' +
        '- "compound": a request that combines several changes, or needs investigation before acting.',
    },
    { role: 'user', content: message },
  ]
}

// Classifies a request into the smallest sufficient tier. The model's answer is generated as a
// schema-validated object, so an off-schema classification fails closed as an error rather than
// a guessed tier; the orchestrator then defaults to the read tier, which never acts.
export async function runTriage(gateway: Gateway, message: string): Promise<AgentResult<OperatorTier>> {
  try {
    const completion = await gateway.completeObject(buildTriageMessages(message), TriageOutput, {
      maxTokens: TRIAGE_MAX_TOKENS,
      temperature: 0,
    })
    return { ok: true, value: completion.value.tier }
  } catch {
    return { ok: false, error: 'triage returned an unrecognized tier' }
  }
}

// The context an agent reasons over: the compressed facts of the older history plus
// the live working-memory snapshot of the recent window, and the live state evidence a
// researcher gathered for this turn. Together they give an agent continuity across a long
// conversation and grounding in current state, both at a bounded token cost.
export interface AgentContext {
  facts: ConversationFacts | null
  state: ConversationState | null
  evidence?: Evidence[]
}

// Renders the live state evidence into a compact block: one line per governed read, with the
// live count and a bounded list of names, or the typed reason a read could not be gathered. Only
// names reach the prompt, never whole rows, so a read never leaks an arbitrary field.
function describeEvidence(evidence: Evidence[] | undefined): string | null {
  if (!evidence || evidence.length === 0) return null
  const lines = evidence.map((item) => {
    if (!item.ok) return `- ${item.domain}: could not read (${item.error ?? 'read failed'})`
    const count = item.count ?? 0
    const names = item.names ?? []
    if (count === 0) return `- ${item.domain}: none`
    const listed = names.length > 0 ? `: ${names.join(', ')}${count > names.length ? ', …' : ''}` : ''
    return `- ${item.domain} (${count})${listed}`
  })
  return `Live state (read just now):\n${lines.join('\n')}`
}

// Renders the agent context into a compact block: the compressed session facts first,
// then the live state evidence, then the recent working memory. Older history is summarized
// rather than replayed, so the prompt stays small no matter how long the conversation is.
function describeContext(context: AgentContext): string {
  const sections: string[] = []
  const facts = describeFacts(context.facts)
  if (facts) sections.push(`Session facts:\n${facts}`)

  const evidence = describeEvidence(context.evidence)
  if (evidence) sections.push(evidence)

  const recent: string[] = []
  if (context.state?.latest_plan) {
    recent.push(
      `Latest plan (seq ${context.state.latest_plan.seq}): ${context.state.latest_plan.summary} [${context.state.latest_plan.decision}]`,
    )
  }
  for (const message of context.state?.recent_messages.slice(-6) ?? []) {
    recent.push(`${message.role}: ${message.text}`)
  }
  if (recent.length > 0) sections.push(`Recent activity:\n${recent.join('\n')}`)

  return sections.length > 0 ? sections.join('\n\n') : 'No prior context.'
}

export function buildPlannerMessages(message: string, context: AgentContext): GatewayMessage[] {
  return [
    {
      role: 'system',
      content:
        'You are the planning agent for Caracal, a control-plane authority platform. Translate the ' +
        "operator's request into a plan using ONLY the capabilities below. Reply with ONLY a JSON " +
        'object of the form {"summary": string, "steps": [{"id": string, "capability": string, ' +
        '"args": object}]}. Use a short unique id per step (s1, s2, ...). Use exactly the capability ' +
        'ids and argument names listed. Do not invent capabilities or arguments. If the request maps ' +
        'to no listed capability, return a plan with an empty steps array.\n\nCapabilities:\n' +
        describeCapabilitiesForPrompt(),
    },
    { role: 'user', content: `Context:\n${describeContext(context)}\n\nRequest: ${message}` },
  ]
}

// The planner may legitimately return zero steps when nothing maps to a capability, so
// it is parsed against a schema that permits an empty plan. The strict ProposedPlan used
// by the governed /plan endpoint still requires at least one step; an empty plan here is
// simply surfaced as "no actionable plan" by the orchestrator.
const PlannerPlan = z
  .object({
    summary: z.string().min(1).max(2000),
    steps: z.array(ProposedPlan.shape.steps.element).max(50),
  })
  .strict()

// Produces a proposed plan from intent. The model's answer is generated as a
// schema-validated object, so anything malformed or off-schema fails closed and a
// hallucinated plan never leaves this function as a success. An empty steps array is a
// valid "nothing maps" result.
export async function runPlanner(gateway: Gateway, message: string, context: AgentContext): Promise<AgentResult<ProposedPlanInput>> {
  try {
    const completion = await gateway.completeObject(buildPlannerMessages(message, context), PlannerPlan, {
      maxTokens: PLANNER_MAX_TOKENS,
      temperature: 0,
    })
    return { ok: true, value: completion.value }
  } catch {
    return { ok: false, error: 'planner returned a plan that failed the schema' }
  }
}

export function buildExplainerMessages(message: string, context: AgentContext): GatewayMessage[] {
  return [
    {
      role: 'system',
      content:
        'You are a read-only Caracal operator assistant. Explain clearly and concisely in plain ' +
        'language for an operator who should not need to know Caracal internals. When the context ' +
        'includes live state read just now, ground your answer in it and do not invent applications, ' +
        'providers, resources, or policies it does not list. You never make changes and must not ' +
        'claim to; if the operator wants to change something, tell them to ask for that change so it ' +
        'can be planned and approved.',
    },
    { role: 'user', content: `Context:\n${describeContext(context)}\n\nQuestion: ${message}` },
  ]
}

// Answers a read-only question. Returns the model's text directly along with any chain
// of thought the model exposed; it carries no authority and performs no action.
export async function runExplainer(
  gateway: Gateway,
  message: string,
  context: AgentContext,
): Promise<AgentResult<{ text: string; reasoning?: string }>> {
  const completion = await gateway.complete(buildExplainerMessages(message, context), {
    maxTokens: EXPLAINER_MAX_TOKENS,
    temperature: 0.2,
  })
  const text = completion.text.trim()
  if (text.length === 0) return { ok: false, error: 'explainer returned an empty answer' }
  return { ok: true, value: { text, reasoning: completion.reasoning } }
}
