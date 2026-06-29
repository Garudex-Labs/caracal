// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// The Operator agent layer: purpose-built agents that turn intent into typed artifacts the deterministic engine governs.

import { z } from 'zod'
import { describeCapabilitiesForPrompt, ProposedPlan, type ProposedPlanInput } from './operator-capabilities.js'
import type { ConversationState } from './operator-state.js'
import { describeFacts, type ConversationFacts } from './operator-memory.js'
import type { Evidence } from './operator-research.js'
import { GatewayBudgetError, type Gateway, type GatewayMessage } from './operator-gateway.js'

// The agents never hold authority. Each one produces a typed artifact — an intent,
// a proposed plan, or an explanation — that the deterministic pipeline then
// validates, previews, and governs. A model can propose; only Caracal decides.

const TRIAGE_MAX_TOKENS = 32
const PLANNER_MAX_TOKENS = 800
const EXPLAINER_MAX_TOKENS = 600
const SECURITY_ANALYST_MAX_TOKENS = 500
const TROUBLESHOOTER_MAX_TOKENS = 600
const TRANSLATOR_MAX_TOKENS = 600

// The handling tier a request is triaged into: the smallest sufficient path, so a simple turn
// never pays the planning pipeline. conversational and read are answered directly as text;
// change and compound produce a proposed plan. The four tiers are the stable taxonomy the
// orchestration grows into — later phases add specialist skills and parallel composition for
// the compound tier without changing this classification.
export type OperatorTier = 'conversational' | 'read' | 'change' | 'compound'

// The operation mode of a conversation, a Caracal-side setting enforced deterministically and
// never chosen by the model. agent is the full path: read, propose, and — after human approval —
// apply. ask is strictly read-only: no plan is ever produced and no change path is reachable, so
// an ask conversation is provably write-incapable. The mode gates skill selection here and the
// write routes independently, so a read-only conversation stays read-only at both layers.
export type OperatorMode = 'ask' | 'agent'

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

// Whether a tier composes multiple specialists rather than running a single skill. compound is a
// request that combines several changes or needs investigation first, so it gathers live state
// evidence to plan against and runs an advisory security review over the proposed plan. change is
// a single-domain request and stays the cheap single-skill path; both still require human
// approval before anything is applied.
export function tierComposes(tier: OperatorTier): boolean {
  return tier === 'compound'
}

const TriageOutput = z
  .object({
    tier: z.enum(['conversational', 'read', 'change', 'compound']),
    topic: z.enum(['general', 'diagnostic', 'integration']).optional(),
  })
  .strict()

// The answer specialty a read request is routed to, so a read tier picks the best-suited
// read-only answer skill rather than always the general explainer. diagnostic routes a
// "why was X denied / why did this fail" question to the troubleshooter; integration routes a
// "how do I connect X / what scopes does Y need" question to the provider-resource translator;
// general is everything else and uses the explainer. The topic only refines which read-only
// answer skill replies — it never widens authority and is ignored on the planning tiers.
export type OperatorTopic = 'general' | 'diagnostic' | 'integration'

// The triage classification: the handling tier plus, for an answer, its specialty. The orchestrator
// selects a skill from this — Caracal decides which skill runs, the model only classifies.
export interface OperatorTriage {
  tier: OperatorTier
  topic: OperatorTopic
}

export function buildTriageMessages(message: string): GatewayMessage[] {
  return [
    {
      role: 'system',
      content:
        'You triage a Caracal operator request into the smallest sufficient handling tier. Reply ' +
        'with ONLY a JSON object {"tier":"<tier>","topic":"<topic>"} and no prose. Tiers:\n' +
        '- "conversational": a greeting, small talk, an acknowledgement, a question about what you ' +
        "can do, or a clarifying question — nothing about the operator's actual Caracal state.\n" +
        '- "read": a question that inspects or explains current state or a past decision, changing ' +
        'nothing.\n' +
        '- "change": a request to create, connect, rotate, grant, or set up ONE thing.\n' +
        '- "compound": a request that combines several changes, or needs investigation before acting.\n' +
        'topic refines a read: "diagnostic" for why something was denied or a change failed, ' +
        '"integration" for how to connect a provider or what scopes a resource needs, "general" for ' +
        'anything else. Use "general" when unsure or when the tier is not read.',
    },
    { role: 'user', content: message },
  ]
}

// Classifies a request into the smallest sufficient tier and, for a read, its answer specialty.
// The answer is generated as a schema-validated object, so an off-schema classification fails
// closed as an error rather than a guessed tier; the orchestrator then defaults to a general read,
// which never acts. topic defaults to general when the model omits it, so an older classification
// shape stays valid and an absent specialty simply uses the explainer.
export async function runTriage(gateway: Gateway, message: string): Promise<AgentResult<OperatorTriage>> {
  try {
    const completion = await gateway.completeObject(buildTriageMessages(message), TriageOutput, {
      maxTokens: TRIAGE_MAX_TOKENS,
      temperature: 0,
    })
    return { ok: true, value: { tier: completion.value.tier, topic: completion.value.topic ?? 'general' } }
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
  // True when this turn needed live state but no governed read mandate is active for the
  // conversation's zone, so nothing could be read. The read agents must then say so plainly
  // instead of inventing applications, providers, resources, policies, or counts.
  liveStateUnavailable?: boolean
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
  else if (context.liveStateUnavailable) {
    sections.push(
      'Live state: could not be read for this zone — no governed read mandate is active here, ' +
        'so nothing about this zone was inspected this turn.',
    )
  }

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
// valid "nothing maps" result. A per-turn budget refusal is a governance stop, not a plan
// failure, so it propagates to the route rather than being reported as an unmappable request.
export async function runPlanner(gateway: Gateway, message: string, context: AgentContext): Promise<AgentResult<ProposedPlanInput>> {
  try {
    const completion = await gateway.completeObject(buildPlannerMessages(message, context), PlannerPlan, {
      maxTokens: PLANNER_MAX_TOKENS,
      temperature: 0,
    })
    return { ok: true, value: completion.value }
  } catch (err) {
    if (err instanceof GatewayBudgetError) throw err
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
        'providers, resources, or policies it does not list. When the context says live state could ' +
        'not be read for this zone, do not guess or assert counts, names, or that something does or ' +
        'does not exist; say plainly that you could not read this zone’s live state and that it is ' +
        'available in the system zone today, and ask the operator to retry once a read mandate is ' +
        'active for this zone. You never make changes and must not claim to; if the operator wants to ' +
        'change something, tell them to ask for that change so it can be planned and approved.',
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

export function buildTroubleshooterMessages(message: string, context: AgentContext): GatewayMessage[] {
  return [
    {
      role: 'system',
      content:
        'You are a read-only Caracal troubleshooting assistant. The operator is asking why an access ' +
        'was denied or why a change failed. Diagnose the most likely cause in plain language and give ' +
        'a concrete next step, for an operator who should not need to know Caracal internals. Ground ' +
        'your diagnosis in the live state and the recent activity in the context — the last error, ' +
        'the latest plan and how it was decided, and what exists in the zone — and do not invent ' +
        'applications, providers, resources, or policies the context does not show. A denial is ' +
        'usually a missing grant, a missing scope, or a resource or application that does not exist ' +
        'yet. When the context says live state could not be read for this zone, do not guess specific ' +
        'state; say you could not read this zone’s live state and ask the operator to retry once a ' +
        'read mandate is active for this zone. You never make changes and must not claim to; when a ' +
        'fix needs a change, tell the operator to ask for it so it can be planned and approved.',
    },
    { role: 'user', content: `Context:\n${describeContext(context)}\n\nProblem: ${message}` },
  ]
}

// Diagnoses a denial or failure as a read-only answer. It shares the read tier's governed
// evidence and the conversation's error and decision history; it carries no authority and
// performs no action, so a diagnosis can only inform — any fix still flows through the governed
// plan path.
export async function runTroubleshooter(
  gateway: Gateway,
  message: string,
  context: AgentContext,
): Promise<AgentResult<{ text: string; reasoning?: string }>> {
  const completion = await gateway.complete(buildTroubleshooterMessages(message, context), {
    maxTokens: TROUBLESHOOTER_MAX_TOKENS,
    temperature: 0.2,
  })
  const text = completion.text.trim()
  if (text.length === 0) return { ok: false, error: 'troubleshooter returned an empty answer' }
  return { ok: true, value: { text, reasoning: completion.reasoning } }
}

export function buildTranslatorMessages(message: string, context: AgentContext): GatewayMessage[] {
  return [
    {
      role: 'system',
      content:
        'You are a read-only Caracal integration assistant. The operator is asking how to connect a ' +
        'provider or what a resource and its scopes should look like. Translate the real-world nouns ' +
        'they use — a SaaS product, an API, a permission — into the Caracal terms that express them, ' +
        'using ONLY the capabilities below. Name the provider connection kind that fits (for example ' +
        'an OAuth authorization-code flow for a user-facing SaaS, client credentials for a ' +
        'service-to-service API, or an API key or bearer token for a simple keyed API), and describe ' +
        'the resource and scopes that would model the access. Ground your guidance in the live state ' +
        'in the context so you do not propose something that already exists. You never make changes ' +
        'and must not claim to; tell the operator to ask for the change so it can be planned and ' +
        'approved.\n\nCapabilities:\n' +
        describeCapabilitiesForPrompt(),
    },
    { role: 'user', content: `Context:\n${describeContext(context)}\n\nQuestion: ${message}` },
  ]
}

// Translates a real-world integration request into Caracal connection and resource guidance as a
// read-only answer. It is grounded in the capability catalog and the read tier's live evidence; it
// carries no authority and performs no action, so it can only guide — the connection itself still
// flows through the governed plan path.
export async function runTranslator(
  gateway: Gateway,
  message: string,
  context: AgentContext,
): Promise<AgentResult<{ text: string; reasoning?: string }>> {
  const completion = await gateway.complete(buildTranslatorMessages(message, context), {
    maxTokens: TRANSLATOR_MAX_TOKENS,
    temperature: 0.2,
  })
  const text = completion.text.trim()
  if (text.length === 0) return { ok: false, error: 'translator returned an empty answer' }
  return { ok: true, value: { text, reasoning: completion.reasoning } }
}
export type AdvisorySeverity = 'info' | 'caution' | 'warning'

export interface AdvisoryFinding {
  severity: AdvisorySeverity
  concern: string
}

// The security analyst's advisory review of a proposed plan: a short plain-language summary and
// any findings about over-grant, least-privilege, or blast-radius. It carries no authority — a
// plan is approved or denied by the deterministic spine and the human, never by this review — so
// it can only inform, never block or widen what a plan may do.
export interface SecurityAdvisory {
  summary: string
  findings: AdvisoryFinding[]
}

const SecurityAdvisorySchema = z
  .object({
    summary: z.string().min(1).max(1000),
    findings: z.array(z.object({ severity: z.enum(['info', 'caution', 'warning']), concern: z.string().min(1).max(500) }).strict()).max(20),
  })
  .strict()

// Renders a proposed plan compactly for review: its summary and one line per step naming the
// capability and its arguments, so the analyst reasons over exactly what the plan would do.
function describePlanForReview(plan: ProposedPlanInput): string {
  const steps = plan.steps.map((step) => `- ${step.id}: ${step.capability} ${JSON.stringify(step.args)}`).join('\n')
  return `Summary: ${plan.summary}\nSteps:\n${steps}`
}

export function buildSecurityAnalystMessages(plan: ProposedPlanInput, context: AgentContext): GatewayMessage[] {
  return [
    {
      role: 'system',
      content:
        'You are a security reviewer for a proposed Caracal change plan. Review it for over-grant, ' +
        'least-privilege violations, and blast-radius — for example a grant broader than the request ' +
        'implies, a write scope where a read would suffice, or a change that affects more than ' +
        'intended. When the context includes live state read just now, judge the plan against it. ' +
        'Reply with ONLY a JSON object {"summary": string, "findings": [{"severity": ' +
        '"info"|"caution"|"warning", "concern": string}]}. Your review is advisory: it informs the ' +
        'human who approves the plan and never blocks it. Report an empty findings array when the ' +
        'plan is least-privilege and well-scoped.',
    },
    { role: 'user', content: `Context:\n${describeContext(context)}\n\nProposed plan:\n${describePlanForReview(plan)}` },
  ]
}

// Reviews a proposed plan and returns advisory findings. The answer is generated as a
// schema-validated object, so a malformed or off-schema review fails closed as an error rather
// than a guessed verdict; the orchestrator then simply attaches no advisory. The review never
// gates the plan — it only informs the human — so a failed review never blocks a change.
export async function runSecurityAnalyst(
  gateway: Gateway,
  plan: ProposedPlanInput,
  context: AgentContext,
): Promise<AgentResult<SecurityAdvisory>> {
  try {
    const completion = await gateway.completeObject(buildSecurityAnalystMessages(plan, context), SecurityAdvisorySchema, {
      maxTokens: SECURITY_ANALYST_MAX_TOKENS,
      temperature: 0,
    })
    return { ok: true, value: completion.value }
  } catch {
    return { ok: false, error: 'security review did not produce a usable advisory' }
  }
}
