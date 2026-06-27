// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// The Operator agent layer: purpose-built agents that turn intent into typed artifacts the deterministic engine governs.

import { z } from 'zod'
import { describeCapabilitiesForPrompt, ProposedPlan, type ProposedPlanInput } from './operator-capabilities.js'
import type { ConversationState } from './operator-state.js'
import { describeFacts, type ConversationFacts } from './operator-memory.js'
import type { Gateway, GatewayMessage } from './operator-gateway.js'

// The agents never hold authority. Each one produces a typed artifact — an intent,
// a proposed plan, or an explanation — that the deterministic pipeline then
// validates, previews, and governs. A model can propose; only Caracal decides.

const ROUTER_MAX_TOKENS = 16
const PLANNER_MAX_TOKENS = 800
const EXPLAINER_MAX_TOKENS = 600

export type OperatorIntent = 'plan' | 'explain'

export type AgentResult<T> = { ok: true; value: T } | { ok: false; error: string }

const RouterOutput = z.object({ intent: z.enum(['plan', 'explain']) }).strict()

export function buildRouterMessages(message: string): GatewayMessage[] {
  return [
    {
      role: 'system',
      content:
        'You route a Caracal operator request to one handler. Reply with ONLY a JSON object ' +
        '{"intent":"plan"} when the user wants to create, change, connect, rotate, grant, or set ' +
        'something up, or {"intent":"explain"} when the user wants to understand, inspect, or ask ' +
        'why. No prose, no code fences.',
    },
    { role: 'user', content: message },
  ]
}

// Classifies a request into an actionable intent. The model's answer is generated as a
// schema-validated object, so an off-schema classification fails closed as an error
// rather than a guessed action.
export async function runRouter(gateway: Gateway, message: string): Promise<AgentResult<OperatorIntent>> {
  try {
    const completion = await gateway.completeObject(buildRouterMessages(message), RouterOutput, {
      maxTokens: ROUTER_MAX_TOKENS,
      temperature: 0,
    })
    return { ok: true, value: completion.value.intent }
  } catch {
    return { ok: false, error: 'router returned an unrecognized intent' }
  }
}

// The context an agent reasons over: the compressed facts of the older history plus
// the live working-memory snapshot of the recent window. Together they give an agent
// continuity across a long conversation at a bounded token cost.
export interface AgentContext {
  facts: ConversationFacts | null
  state: ConversationState | null
}

// Renders the agent context into a compact block: the compressed session facts first,
// then the recent working memory. Older history is summarized rather than replayed,
// so the prompt stays small no matter how long the conversation is.
function describeContext(context: AgentContext): string {
  const sections: string[] = []
  const facts = describeFacts(context.facts)
  if (facts) sections.push(`Session facts:\n${facts}`)

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
        'language for an operator who should not need to know Caracal internals. You never make ' +
        'changes and must not claim to; if the operator wants to change something, tell them to ask ' +
        'for that change so it can be planned and approved.',
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
