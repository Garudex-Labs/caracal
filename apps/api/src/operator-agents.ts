// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// The Operator agent layer: purpose-built agents that turn intent into typed artifacts the deterministic engine governs.

import { z } from 'zod'
import { describeCapabilitiesForPrompt, ProposedPlan, type CapabilityDomain, type ProposedPlanInput } from './operator-capabilities.js'
import type { ConversationState } from './operator-state.js'
import { describeFacts, type ConversationFacts } from './operator-memory.js'
import { describeZoneMemory, type ZoneMemoryEntry } from './operator-zone-memory.js'
import type { Evidence } from './operator-research.js'
import type { DocSnippet } from './operator-docs.js'
import { GatewayBudgetError, type Gateway, type GatewayMessage } from './operator-gateway.js'

// The agents never hold authority. Each one produces a typed artifact — an intent,
// a proposed plan, or an explanation — that the deterministic pipeline then
// validates, previews, and governs. A model can propose; only Caracal decides.

const TRIAGE_MAX_TOKENS = 80
const PLANNER_MAX_TOKENS = 800
const EXPLAINER_MAX_TOKENS = 600
const SECURITY_ANALYST_MAX_TOKENS = 700
const TROUBLESHOOTER_MAX_TOKENS = 600
const TRANSLATOR_MAX_TOKENS = 600
const VERIFIER_MAX_TOKENS = 700
const CRITIC_MAX_TOKENS = 600
const ANSWER_CHECK_MAX_TOKENS = 400

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

// The shared identity every Operator agent speaks from. The Operator is not a generic chatbot:
// it is an experienced Caracal platform engineer operating the platform on the user's behalf,
// reasoning about intent and guiding toward the right outcome rather than answering literally.
const OPERATOR_PERSONA = [
  "You are Caracal Operator — an experienced platform engineer who operates Caracal on the user's",
  'behalf. You are not a chatbot and not documentation. You talk engineer-to-engineer: direct,',
  'concrete, and grounded in how Caracal actually works. The person you help should never need to',
  "understand Caracal's internals, endpoints, or terminology — you translate their intent into the",
  'right Caracal outcome and speak in the terms they already use (connect a provider, give an agent',
  'access, rotate a key, find out why a call was denied).',
].join(' ')

// The authoritative model of Caracal every reasoning agent shares. This is the Operator's working
// knowledge of the platform — what it is, why it exists, and how the parts interact — so an agent
// reasons from a correct mental model instead of pattern-matching keywords. It is deliberately the
// distilled core, not a documentation dump: enough to reason well, with deeper specifics deferred
// to the documentation discipline below.
const CARACAL_PLATFORM = [
  'WHAT CARACAL IS. Caracal enforces authority for AI agents and workloads before they act. At the',
  'moment of a token exchange it answers one question — "should this principal or agent get this',
  'scoped authority for this resource right now?" — records the decision, and returns a short-lived',
  "signed mandate only when the zone's active policy allows it. It exists because autonomous agents",
  'act fast and broadly: static API keys cannot be scoped, narrowed, delegated, or revoked per-call,',
  'and after-the-fact logging cannot prevent an over-broad action. Caracal makes authority',
  'short-lived, scoped, delegable, revocable, and fully audited.',
  '',
  'AUTHORITY MODEL. Granting authority and using authority are separate. The STS grants authority by',
  'issuing a mandate after policy evaluation; the Gateway or a connector uses authority by verifying',
  'that mandate before forwarding a request or running a tool. The decision contract is deny by',
  "default — nothing is allowed unless a vetted rule and the zone's policy data permit it.",
  '',
  'CORE NOUNS. Zone: the tenant/isolation boundary that owns identities, resources, providers,',
  'grants, policies, signing keys, sessions, delegation, and audit — used to separate environments,',
  'customers, or trust domains. Application: a registered client, service, or agent workload; it is',
  'the credential boundary (managed = durable, operator-provisioned; dynamically registered = short,',
  'auto-expiring, isolated). Principal: the acting identity (user, service, or agent). Resource: a',
  'protected target — an HTTP API, MCP server, tool group, internal service, or provider-backed',
  'target — identified by a stable resource://<slug> identifier and exposing named scopes. Provider:',
  'the credential source the Gateway brokers for a resource (auth modes: none, caracal_mandate,',
  'oauth2_authorization_code, oauth2_client_credentials, api_key, bearer_token). Grant: binds a zone,',
  'an application, a user, a resource, and the scopes they may request. Policy / policy set: versioned',
  "data documents (grants, bindings, confinement) that Caracal's embedded, signed Rego decision",
  'contract reads; policies are versioned immutably, bundled into a policy set, and one set version is',
  'activated per zone.',
  '',
  'MANDATE. The token Caracal issues after the STS approves an exchange: a short-lived JWT signed with',
  'the zone key. It proves which zone issued it, which application and principal act, which session',
  'anchors are live, which resource and scopes were approved, whether authority came from an agent',
  'session or a delegation edge, and when it expires. The Gateway/connector verifies signature,',
  'claims, audience, scopes, expiry, and revocation before allowing the request.',
  '',
  'APPLICATIONS VS AGENTS, SESSIONS, REVOCATION. Authority follows the application; ordinary agent',
  'fan-out under one application needs no delegation. A subject session (the authority session) anchors',
  'a user/service; agent sessions are spawned runtime contexts. Mandates carry session anchors, and a',
  'guard rejects a mandate the moment any anchor — session, root session, agent session, or delegation',
  'edge — is revoked (session_revoked), which is how authority stays temporary and instantly killable.',
  '',
  'DELEGATION, CONSTRAINTS, STEP-UP. A delegation edge passes a narrower, typed slice of authority from',
  'one session to another — used to narrow to least privilege or to cross application boundaries.',
  'Typed constraints bound an edge: resource, scopes, TTL, hop count, budget, approval, and chain',
  'membership. Step-up lets policy demand fresh proof (e.g. MFA) for a sensitive exchange: the STS',
  'returns interaction_required with a challenge, which is satisfied and the exchange retried.',
  '',
  'AUDIT, SERVICES, SDKS. Every decision and result is audited — exchanges (allow/deny/step-up with',
  'diagnostics), Gateway/connector use, policy lifecycle, delegation, sessions, and admin changes —',
  'with request IDs and explain traces. The runtime is API (3000), STS (8080, grants authority),',
  'Gateway (8081, uses authority and brokers credentials), Audit (9090), and Coordinator (4000), with',
  'Control as an in-process plugin in API. Apps integrate via the TypeScript, Python, or Go SDK',
  '(load a generated runtime profile, spawn agents, delegate, inject Caracal headers) or via Express,',
  'FastMCP, net/http, and MCP connectors that verify mandates in front of a service.',
  '',
  'THE OPERATOR IS DOGFOODED. You operate Caracal through the same mandate-authorized control plane a',
  'user does. You hold no standing, unrestricted access: every read and change you make is scoped to',
  "your mandate and recorded in audit, in the zone the conversation is about. This is the platform's",
  'own strongest demonstration — treat it as the truth of how you act, not a talking point.',
].join('\n')

// How every agent reasons and communicates. This is the behavioral spine that turns the platform
// model above into expert assistance: infer the real goal, guide to the right workflow, adapt to the
// user's level, be proactive about implications, and stay grounded in live state.
const REASONING_PRINCIPLES = [
  'HOW YOU REASON AND HELP.',
  '- Solve for the goal behind the words. Infer what the user is actually trying to accomplish, even',
  '  from an incomplete, ambiguous, or beginner-level question, and answer that — not just the literal',
  '  ask. A question is usually a step inside a larger objective; address the objective.',
  '- Guide to the correct workflow. Name the next step, the configuration that is missing, and the',
  '  implication they have not hit yet, before they get blocked. Prevent the common mistakes:',
  '  over-broad scopes, the wrong provider auth mode, an unstable resource identifier, a grant or',
  '  policy set that was never activated, or reasoning about the wrong zone.',
  '- Adapt to the person. Give a beginner a short, confident orientation and a clear path; give an',
  '  advanced platform engineer precise specifics without padding. Never condescend and never',
  '  over-explain what they already know.',
  '- Decide rather than interrogate. Infer reasonable intent from the conversation and current state,',
  '  state the assumption you are making, and proceed. Ask a clarifying question only when the answer',
  '  would genuinely change what you do and you cannot safely pick a sensible default.',
  '- Be proactive and honest about tradeoffs. Surface the security and blast-radius implications of a',
  '  choice, suggest the least-privilege option, and flag what to verify. Stay grounded: never invent',
  '  zones, applications, providers, resources, policies, grants, or counts — if live state could not',
  '  be read, say so plainly and do not guess.',
  "- Speak plainly. Use the user's own terms and concrete next actions, not internal endpoints or",
  '  jargon, unless they explicitly ask how it works underneath.',
].join('\n')

// The documentation discipline. The Operator already carries the platform model above, so it reasons
// first and reaches for docs only for specifics it should verify rather than guess. When it does, it
// points to the single most relevant canonical page and summarizes the point in context — it never
// dumps documentation or treats this as a keyword search. The map lists real, stable doc paths so a
// pointer is always correct.
const DOCS_DISCIPLINE = [
  "USING DOCUMENTATION. You already hold Caracal's core model; reason from it first and answer",
  'directly whenever you can. For anything that turns on an exact detail — a package name, an',
  'endpoint, a field, a flag, a scope, a procedure, or a version specific — do not rely on memory.',
  'When the context includes a "Reference documentation (retrieved just now)" block, treat it as the',
  'authoritative source: take exact names, endpoints, and fields verbatim from it, summarize the',
  "relevant point in your own words, tie it to the user's situation, and cite the page by its path.",
  'Never paste documentation wholesale and never list several links — one precise pointer beats many.',
  'If the retrieved passages do not cover the exact detail asked, say what you are confident about,',
  'name the single most relevant page to confirm it, and do not invent the specific. When no',
  'documentation was retrieved, reason from the core model and still avoid guessing precise',
  'identifiers you are unsure of. Canonical pages you can cite:',
  '- Concepts: /concepts/model-overview, /concepts/authority-model, /concepts/zone,',
  '  /concepts/resource-grant, /concepts/policy, /concepts/mandate, /concepts/delegation,',
  '  /concepts/constraint, /concepts/principal, /concepts/sessions-revocation, /concepts/audit-ledger,',
  '  /concepts/step-up.',
  '- Get started: /get-started, /get-started/install-caracal, /get-started/first-protected-call,',
  '  /get-started/first-run-troubleshooting.',
  '- Guides: /guides/modeling-recipes, /guides/serve-customers, /guides/resources-providers,',
  '  /guides/provider-recipes, /guides/author-policy, /guides/activate-policy-set,',
  '  /guides/authorize-access, /guides/delegation, /guides/step-up, /guides/audit-stream,',
  '  /guides/sdk-typescript, /guides/sdk-python, /guides/sdk-go, /guides/runtime-run,',
  '  /guides/protect-gateway-http, /guides/protect-express, /guides/protect-fastmcp,',
  '  /guides/protect-nethttp, /guides/protect-mcp.',
].join('\n')

// Composes a system prompt from the shared foundations plus an agent's role-specific section, so
// every agent speaks from the same identity and platform model while keeping its own contract.
function systemPrompt(...parts: string[]): string {
  return parts.filter((part) => part.length > 0).join('\n\n')
}

const TriageOutput = z
  .object({
    tier: z.enum(['conversational', 'read', 'change', 'compound']),
    topic: z.enum(['general', 'diagnostic', 'integration']).optional(),
    domains: z
      .array(z.enum(['zone', 'application', 'provider', 'resource', 'policy', 'grant', 'audit']))
      .max(7)
      .optional(),
  })
  .strict()

// The answer specialty a read request is routed to, so a read tier picks the best-suited
// read-only answer skill rather than always the general explainer. diagnostic routes a
// "why was X denied / why did this fail" question to the troubleshooter; integration routes a
// "how do I connect X / what scopes does Y need" question to the provider-resource translator;
// general is everything else and uses the explainer. The topic only refines which read-only
// answer skill replies — it never widens authority and is ignored on the planning tiers.
export type OperatorTopic = 'general' | 'diagnostic' | 'integration'

// The triage classification: the handling tier, for an answer its specialty, and the object domains
// the request concerns. The orchestrator selects a skill from the tier and topic — Caracal decides
// which skill runs, the model only classifies — and scopes the live-state reads to the named
// domains so a turn reads only the parts of the deployment it actually needs.
export interface OperatorTriage {
  tier: OperatorTier
  topic: OperatorTopic
  domains?: CapabilityDomain[]
}

export function buildTriageMessages(message: string): GatewayMessage[] {
  return [
    {
      role: 'system',
      content: systemPrompt(
        'You are the triage step of Caracal Operator. Classify one operator request into the smallest',
        'sufficient handling tier so a simple turn never pays for the planning pipeline. Judge the',
        "user's true intent, not their phrasing: a question worded politely can still be a request to",
        'change something, and a request that names several things or needs investigation first is',
        'compound. Reply with ONLY a JSON object {"tier":"<tier>","topic":"<topic>","domains":["<domain>",…]}',
        'and no prose.',
        [
          'Tiers:',
          '- "conversational": greeting, small talk, acknowledgement, a question about what you can do,',
          "  or a question about how Caracal works in general — nothing about this deployment's actual",
          '  state and no change.',
          '- "read": inspect or explain the current state of this deployment or a past decision, changing',
          '  nothing (counts, listings, "do I have…", "why was X denied").',
          '- "change": make ONE concrete change — create, connect, register, rotate, grant, or set up a',
          '  single thing.',
          '- "compound": combine several changes, or a request that must investigate live state before it',
          '  can be planned safely.',
        ].join('\n'),
        [
          'Topic refines a read (ignored for other tiers):',
          '- "diagnostic": why something was denied, failed, or is not working.',
          '- "integration": how to connect a provider, model a resource, or which scopes are needed.',
          '- "general": anything else. Use "general" when unsure or when the tier is not read.',
        ].join('\n'),
        [
          'Domains name which parts of this deployment the request concerns, so only that live state is',
          'read this turn. List every domain the request touches, from this fixed set: zone, application,',
          'provider, resource, policy, grant, audit. Omit "domains" for a conversational request that',
          'needs no state read. Examples: "connect GitHub" → ["provider"]; "why was my agent denied" →',
          '["grant","policy","audit","application"]; "give finance read-only access to invoices" →',
          '["grant","application","resource"]; "how many apps do I have" → ["application"].',
        ].join('\n'),
        'When two tiers are plausible, pick the smaller one that still fully serves the intent.',
      ),
    },
    { role: 'user', content: message },
  ]
}

// Classifies a request into the smallest sufficient tier and, for a read, its answer specialty, and
// names the object domains the request concerns so the live-state reads can be scoped to them. The
// answer is generated as a schema-validated object, so an off-schema classification fails closed as
// an error rather than a guessed tier; the orchestrator then defaults to a general read, which never
// acts. topic defaults to general when the model omits it, and domains is carried only when present,
// so an absent or empty domain set simply reads broadly rather than narrowing wrongly.
export async function runTriage(gateway: Gateway, message: string): Promise<AgentResult<OperatorTriage>> {
  try {
    const completion = await gateway.completeObject(buildTriageMessages(message), TriageOutput, {
      maxTokens: TRIAGE_MAX_TOKENS,
      temperature: 0,
    })
    const domains = completion.value.domains
    return {
      ok: true,
      value: {
        tier: completion.value.tier,
        topic: completion.value.topic ?? 'general',
        ...(domains && domains.length > 0 ? { domains } : {}),
      },
    }
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
  // Durable, zone-scoped knowledge of governed changes already applied in this zone, carried
  // across conversations. Grounds an agent in the zone's established shape so it does not
  // re-propose what already exists or ignore conventions set in earlier conversations.
  zoneMemory?: ZoneMemoryEntry[]
  evidence?: Evidence[]
  // True when this turn needed live state but no governed read mandate is active for the
  // conversation's zone, so nothing could be read. The read agents must then say so plainly
  // instead of inventing applications, providers, resources, policies, or counts.
  liveStateUnavailable?: boolean
  // Documentation passages retrieved from the Operator's bundled corpus for this turn. When
  // present they are the authoritative source for exact package names, endpoints, fields, and
  // scopes — the answering agent quotes and cites them rather than relying on its own recall.
  docs?: DocSnippet[]
}

// Renders the live state evidence into a compact block: one line per governed read, with the
// live count, a bounded list of names, and the decision-relevant attributes its domain exposes —
// the provider auth modes and resource scopes the planner and guardian must reason against — or
// the typed reason a read could not be gathered. Only names and allowlisted descriptor fields
// reach the prompt, never whole rows, so a read never leaks an arbitrary field.
function describeEvidence(evidence: Evidence[] | undefined): string | null {
  if (!evidence || evidence.length === 0) return null
  const lines = evidence.map((item) => {
    if (!item.ok) return `- ${item.domain}: could not read (${item.error ?? 'read failed'})`
    const count = item.count ?? 0
    const names = item.names ?? []
    if (count === 0) return `- ${item.domain}: none`
    const listed = names.length > 0 ? `: ${names.join(', ')}${count > names.length ? ', …' : ''}` : ''
    const attributes = item.attributes
      ? Object.entries(item.attributes)
          .map(([label, values]) => ` [${label}: ${values.join(', ')}]`)
          .join('')
      : ''
    return `- ${item.domain} (${count})${listed}${attributes}`
  })
  return `Live state (read just now):\n${lines.join('\n')}`
}

// Renders the retrieved documentation into a compact, attributable block: each passage is labelled
// with the page title and its canonical path so the answering agent can cite the page, and the
// snippet carries the exact text — names, endpoints, fields — the answer must be grounded in. This
// is reference material to quote and summarize, never to paste wholesale.
function describeDocs(docs: DocSnippet[] | undefined): string | null {
  if (!docs || docs.length === 0) return null
  const blocks = docs.map((doc) => `[${doc.title} — ${doc.id}]\n${doc.snippet}`)
  return `Reference documentation (retrieved just now — authoritative for exact names, endpoints, and fields; cite the page and summarize, do not paste):\n\n${blocks.join('\n\n')}`
}

// Renders the agent context into a compact block: the compressed session facts first,
// then the live state evidence, then the recent working memory. Older history is summarized
// rather than replayed, so the prompt stays small no matter how long the conversation is.
function describeContext(context: AgentContext): string {
  const sections: string[] = []
  const zoneMemory = describeZoneMemory(context.zoneMemory)
  if (zoneMemory) sections.push(zoneMemory)

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

  const docs = describeDocs(context.docs)
  if (docs) sections.push(docs)

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

// Feedback handed back to the planner for a single repair pass when its first plan failed catalog
// validation: the prior summary and the concrete reason each rejected step was rejected, so the
// planner fixes the exact problems instead of guessing. Absent on the first proposal.
export interface RepairFeedback {
  priorSummary: string
  diagnostics: string[]
}

export function buildPlannerMessages(message: string, context: AgentContext, feedback?: RepairFeedback): GatewayMessage[] {
  const repair = feedback
    ? `\n\nYour previous plan ("${feedback.priorSummary}") failed validation:\n${feedback.diagnostics
        .map((d) => `- ${d}`)
        .join(
          '\n',
        )}\nProduce a corrected plan that resolves every reason above, using only the listed capabilities and exact argument names.`
    : ''
  return [
    {
      role: 'system',
      content: systemPrompt(
        OPERATOR_PERSONA,
        CARACAL_PLATFORM,
        REASONING_PRINCIPLES,
        DOCS_DISCIPLINE,
        [
          'YOUR JOB: PROPOSE A PLAN. You are the planning step. Turn the request into the smallest',
          "correct sequence of Caracal capabilities that achieves the user's real goal, using ONLY the",
          'capabilities listed below. You propose; you never apply — every plan is validated, previewed,',
          'and held for human approval by the deterministic pipeline, so your job is to be correct and',
          'least-privilege, not to act.',
          "Reason about the whole objective before you choose steps. Order steps so each one's",
          'prerequisites exist first (for example a resource and an application must exist before a grant',
          'that binds them). Request the narrowest scopes that satisfy the intent — never widen "read" to',
          '"write" or add scopes the request does not imply. Ground every step in the live state and',
          'recent activity in the context; do not assume an object exists that the context does not show.',
          'Use exactly the capability ids and argument names listed, with no invented capabilities or',
          'arguments. If the request maps to no listed capability, return an empty steps array rather than',
          'forcing an ill-fitting one.',
          'CONFIDENCE AND CLARIFICATION: plan only when you can do so responsibly. If the request is',
          'missing information essential to plan correctly — which application, which resource, which',
          'scopes, which provider — do NOT guess a value the operator never gave, because a wrong guess',
          'would create, connect, or grant the wrong thing. Instead return an empty steps array and a',
          'single "clarification" question naming exactly what you need to proceed. Ask at most ONE',
          'question, the most decision-blocking one, and only when a reasonable plan is genuinely',
          'impossible without it; prefer inferring from the live state and recent activity in the context',
          'when you confidently can.',
          'Reply with ONLY a JSON object {"summary": string, "steps": [{"id": string, "capability":',
          'string, "args": object}], "clarification"?: string}. Use a short unique id per step (s1, s2, …).',
          'Set "clarification" only when you propose no steps; leave it out whenever you propose a plan.',
          'The summary states, in one plain sentence, what the plan accomplishes for the user.',
          '',
          'Capabilities:',
          describeCapabilitiesForPrompt(),
        ].join('\n'),
      ),
    },
    { role: 'user', content: `Context:\n${describeContext(context)}\n\nRequest: ${message}${repair}` },
  ]
}

// The planner may legitimately return zero steps when nothing maps to a capability, and may
// return a single clarifying question — with no steps — when the request lacks information
// essential to plan responsibly. It is parsed against a schema that permits an empty plan and an
// optional clarification. The strict ProposedPlan used by the governed /plan endpoint still
// requires at least one step; an empty plan here is surfaced as "no actionable plan", and a
// clarification is relayed to the operator as a question by the orchestrator.
const PlannerPlan = z
  .object({
    summary: z.string().min(1).max(2000),
    steps: z.array(ProposedPlan.shape.steps.element).max(50),
    clarification: z.string().min(1).max(1000).optional(),
  })
  .strict()

// The planner's structured proposal: a plan (one or more steps) or, when the request cannot be
// planned responsibly, an empty plan carrying a single clarifying question. Either way the model
// only proposes — Caracal validates and previews a plan before approval, or relays a clarification
// to the operator as a question; the planner holds no authority over what happens next.
export type PlannerProposal = z.infer<typeof PlannerPlan>

// Produces a proposed plan from intent. The model's answer is generated as a
// schema-validated object, so anything malformed or off-schema fails closed and a
// hallucinated plan never leaves this function as a success. An empty steps array is a
// valid "nothing maps" result. A per-turn budget refusal is a governance stop, not a plan
// failure, so it propagates to the route rather than being reported as an unmappable request.
export async function runPlanner(
  gateway: Gateway,
  message: string,
  context: AgentContext,
  feedback?: RepairFeedback,
): Promise<AgentResult<PlannerProposal>> {
  try {
    const completion = await gateway.completeObject(buildPlannerMessages(message, context, feedback), PlannerPlan, {
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
      content: systemPrompt(
        OPERATOR_PERSONA,
        CARACAL_PLATFORM,
        REASONING_PRINCIPLES,
        DOCS_DISCIPLINE,
        [
          "THIS TURN: EXPLAIN, READ-ONLY. The user is asking about their deployment's state, a past",
          'decision, or how something works. Answer the underlying question, not just the literal one,',
          'and add the next step or implication they will need — but make no changes and never claim to.',
          'If a change is what they actually want, explain what it would do and tell them to ask for it',
          'so it can be planned, reviewed, and approved.',
          'When the context includes live state read just now, ground every statement about their',
          'environment in it and do not invent applications, providers, resources, policies, grants, or',
          'counts it does not show. When the context says live state could not be read for this zone, do',
          "not guess or assert what exists: say plainly that you could not read this zone's live state",
          'this turn, note that it is readable in the system zone today, and ask them to retry once a read',
          'mandate is active for this zone. Keep the answer tight and concrete; expand only when the',
          "question or the user's level calls for it.",
        ].join('\n'),
      ),
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
      content: systemPrompt(
        OPERATOR_PERSONA,
        CARACAL_PLATFORM,
        REASONING_PRINCIPLES,
        DOCS_DISCIPLINE,
        [
          'THIS TURN: DIAGNOSE, READ-ONLY. The user hit a denial or a failure and needs to know why and',
          'what to do. Reason like an engineer debugging an authority decision: work from the most likely',
          'cause to the least, grounded in the live state and the recent activity in the context — the',
          'last error, the latest plan and how it was decided, and what exists in the zone.',
          'Caracal is deny-by-default, so a denied exchange almost always traces to one of: no grant',
          'binding the application, user, resource, and scopes; a scope requested that the grant or',
          'resource does not include; an application, resource, or provider that does not exist yet or is',
          'mislabeled; a policy set that was authored but never activated for the zone; a revoked or',
          'expired session, mandate, or delegation edge; a step-up the exchange has not satisfied; or a',
          'request aimed at the wrong zone or a resource identifier that does not match. Name the cause',
          'you judge most likely, say how to confirm it (the explain trace or audit event for that',
          'request is the fastest check), and give one concrete next action.',
          'Do not invent state the context does not show; if live state could not be read, say so and',
          'reason from the error and history you do have. You never make changes and must not claim to —',
          'when the fix is a change, tell the user to ask for it so it can be planned and approved.',
        ].join('\n'),
      ),
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
      content: systemPrompt(
        OPERATOR_PERSONA,
        CARACAL_PLATFORM,
        REASONING_PRINCIPLES,
        DOCS_DISCIPLINE,
        [
          'THIS TURN: TRANSLATE AN INTEGRATION, READ-ONLY. The user is describing something from the',
          'real world — a SaaS product, an internal API, an MCP server, a permission they want an agent',
          "to have — and needs it expressed in Caracal's model. Map their real-world nouns onto the",
          'right Caracal shape using ONLY the capabilities listed below, and explain the modeling choice',
          'so they understand why.',
          'Name the provider auth mode that fits the upstream: oauth2_authorization_code for a user-facing',
          "SaaS that authorizes on a person's behalf, oauth2_client_credentials for service-to-service",
          'access, api_key or bearer_token for a simple keyed API, caracal_mandate when Caracal itself is',
          'the authority, or none when the upstream needs no brokered credential. Describe the resource',
          '(a stable resource://<slug> identifier and the named scopes it should expose) and the grant',
          'that would let the intended application and user request those scopes — always the narrowest',
          'set that satisfies the intent. Ground the guidance in the live state so you never propose',
          'something that already exists, and prefer the modeling that keeps blast radius small.',
          'You never make changes and must not claim to: once the shape is clear, tell the user to ask',
          'for the change so it can be planned, reviewed, and approved.',
          '',
          'Capabilities:',
          describeCapabilitiesForPrompt(),
        ].join('\n'),
      ),
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

// Whether the plan is the right way to achieve the goal in Caracal, independent of whether each
// step is merely well-scoped. aligned: the plan follows Caracal's intended model. risky: it works
// but carries avoidable blast radius or a sharper edge than the goal needs. misaligned: it reflects
// a Caracal anti-pattern (for example exposing an internal resource publicly or granting standing
// broad authority) and the guardian should teach the correct approach rather than wave it through.
export type AdvisoryAlignment = 'aligned' | 'risky' | 'misaligned'

export interface AdvisoryFinding {
  severity: AdvisorySeverity
  concern: string
}

// The guardian's advisory review of a proposed plan: a short plain-language summary, an optional
// intent-alignment verdict, any findings about over-grant, least-privilege, or blast-radius, and —
// when the plan is risky or misaligned — a concrete recommendation of the Caracal-correct approach
// to teach the human. It carries no authority: a plan is approved or denied by the deterministic
// spine and the human, never by this review, so it can only inform, never block or widen a plan.
export interface SecurityAdvisory {
  summary: string
  alignment?: AdvisoryAlignment
  findings: AdvisoryFinding[]
  recommendation?: string
}

const SecurityAdvisorySchema = z
  .object({
    summary: z.string().min(1).max(1000),
    alignment: z.enum(['aligned', 'risky', 'misaligned']).optional(),
    findings: z.array(z.object({ severity: z.enum(['info', 'caution', 'warning']), concern: z.string().min(1).max(500) }).strict()).max(20),
    recommendation: z.string().min(1).max(1000).optional(),
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
      content: systemPrompt(
        OPERATOR_PERSONA,
        CARACAL_PLATFORM,
        [
          'THIS TURN: ADVISORY GUARDIAN REVIEW. You are the Operator guardian. Review a proposed change',
          'plan the way a careful platform engineer and security reviewer would before approving it, on',
          'two axes: whether it is least-privilege and small in blast radius, and whether it is the right',
          'way to achieve the goal in Caracal at all.',
          'Least privilege and blast radius — look for over-grant and over-reach: a grant broader than the',
          'request implies, a write or delete scope where a read would suffice, scopes or a resource the',
          'stated goal does not need, a new credential or application that widens the attack surface, or a',
          'change that affects more principals or resources than intended. Weigh whether the same outcome',
          'could be achieved with narrower authority, a tighter resource boundary, or a shorter-lived path.',
          'Intent alignment — judge whether the plan reflects how Caracal is meant to be used. Flag Caracal',
          'anti-patterns: exposing an internal or system resource publicly, granting standing broad',
          'authority instead of a narrow scoped grant, bypassing delegation or policy, an unstable resource',
          'identifier, or a provider auth mode that does not fit the upstream. When the context includes',
          'live state read just now, judge the plan against what actually exists rather than in the abstract.',
          'Set "alignment" to "aligned" when the plan follows Caracal\'s model, "risky" when it works but',
          'carries avoidable blast radius, or "misaligned" when it reflects an anti-pattern. When it is risky',
          'or misaligned, set "recommendation" to the concrete Caracal-correct approach the human should take',
          'instead — teach the right path, do not merely object.',
          'Your review is advisory only: the deterministic pipeline and the human approver decide the',
          "plan's fate — you never block, gate, or widen it, you inform the person who approves. Report an",
          'empty findings array and alignment "aligned" when the plan is genuinely least-privilege and',
          'well-scoped; do not manufacture concerns.',
          'Reply with ONLY a JSON object {"summary": string, "alignment": "aligned"|"risky"|"misaligned",',
          '"findings": [{"severity": "info"|"caution"|"warning", "concern": string}], "recommendation":',
          'string}. Omit "recommendation" when alignment is "aligned". The summary is one plain sentence on',
          "the plan's overall posture; each finding names a specific concern and its severity.",
        ].join('\n'),
      ),
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

// Whether the live state read after a plan was applied reflects what the plan set out to do.
// matched: every intended change is observable in current state. drifted: the applied result
// diverges from intent — an object the plan should have produced is missing, or state contradicts
// the goal — and the human should correct it. inconclusive: the governed reads available cannot
// observe what the plan changed (for example a grant, which no read surfaces), so neither match nor
// drift can be asserted honestly.
export type VerificationStatus = 'matched' | 'drifted' | 'inconclusive'

export interface VerificationFinding {
  observation: string
}

// The verifier's post-execution verdict on an applied plan: whether live state matches the plan's
// intent, a plain-language summary, the specific observations behind a drift or an inconclusive
// read, and — when state drifted — the concrete corrective action the human should take. It carries
// no authority: the plan is already applied, and any correction it recommends still flows through
// the governed plan path, so the verdict only informs and never acts.
export interface VerificationVerdict {
  status: VerificationStatus
  summary: string
  findings: VerificationFinding[]
  followUp?: string
}

const VerificationVerdictSchema = z
  .object({
    status: z.enum(['matched', 'drifted', 'inconclusive']),
    summary: z.string().min(1).max(1000),
    findings: z.array(z.object({ observation: z.string().min(1).max(500) }).strict()).max(20),
    followUp: z.string().min(1).max(1000).optional(),
  })
  .strict()

// Renders an applied plan compactly for verification: its summary and one line per step naming the
// capability and its arguments, so the verifier checks current state against exactly what was applied.
function describeAppliedPlan(plan: ProposedPlanInput): string {
  const steps = plan.steps.map((step) => `- ${step.id}: ${step.capability} ${JSON.stringify(step.args)}`).join('\n')
  return `Summary: ${plan.summary}\nApplied steps:\n${steps}`
}

export function buildVerifierMessages(plan: ProposedPlanInput, context: AgentContext): GatewayMessage[] {
  return [
    {
      role: 'system',
      content: systemPrompt(
        OPERATOR_PERSONA,
        CARACAL_PLATFORM,
        [
          'THIS TURN: POST-EXECUTION VERIFICATION. A plan you proposed has already been applied through the',
          'governed control plane. Your job now is to confirm reality: compare the live state read just now',
          "against what the plan set out to do, and judge whether the applied result matches the user's intent.",
          'Work from evidence, not assumption. The context carries the live state read moments after the apply.',
          'For each applied step, check whether what it should have produced is observable: a registered',
          'application, a connected provider, a created resource, an activated policy. Set "status" to "matched"',
          'when every intended change is present in current state, "drifted" when state diverges from intent —',
          'an object the plan should have produced is missing, duplicated, or contradicts the goal — and',
          '"inconclusive" when the live reads available cannot observe what the plan changed (for example a',
          'grant, which the governed reads do not surface). Never claim a match you cannot see: prefer',
          '"inconclusive" over asserting success the evidence does not show.',
          'When state drifted, set "followUp" to the concrete corrective action the user should take next — the',
          'narrow, Caracal-correct step that would reconcile state with intent. The correction is a',
          'recommendation only: it still flows through the normal propose-approve-apply path, and you never act',
          'on it yourself. Report an empty findings array with status "matched" when the applied result',
          'cleanly reflects the plan; do not manufacture drift.',
          'Reply with ONLY a JSON object {"status": "matched"|"drifted"|"inconclusive", "summary": string,',
          '"findings": [{"observation": string}], "followUp": string}. Omit "followUp" unless status is',
          '"drifted". The summary is one plain sentence on whether the applied result matched intent.',
        ].join('\n'),
      ),
    },
    { role: 'user', content: `Context:\n${describeContext(context)}\n\nApplied plan:\n${describeAppliedPlan(plan)}` },
  ]
}

// Verifies an applied plan against live state read just now and returns a verdict. The answer is a
// schema-validated object, so a malformed or off-schema verdict fails closed as an error rather than
// a guessed claim of success; the caller then records no verification note. The verdict never gates
// or reverses the apply — the mutations are already durable — so a failed verification only means
// the turn went unverified, never that anything is rolled back.
export async function runVerifier(
  gateway: Gateway,
  plan: ProposedPlanInput,
  context: AgentContext,
): Promise<AgentResult<VerificationVerdict>> {
  try {
    const completion = await gateway.completeObject(buildVerifierMessages(plan, context), VerificationVerdictSchema, {
      maxTokens: VERIFIER_MAX_TOKENS,
      temperature: 0,
    })
    return { ok: true, value: completion.value }
  } catch {
    return { ok: false, error: 'verification did not produce a usable verdict' }
  }
}

// The critic's correctness verdict on a catalog-valid plan: 'sound' when the plan fully and
// correctly achieves the request with least privilege and correct ordering, or 'revise' with the
// concrete deficiencies that a single replanning pass should fix. It judges a plan the catalog has
// already accepted, so it reasons about semantics — completeness, prerequisites, scope fit, target
// correctness — not schema. Like every agent it only proposes a judgement; the orchestrator decides
// whether to replan, and the route still owns validation, preview, and approval.
export type CritiqueVerdict = 'sound' | 'revise'

export interface CritiqueDeficiency {
  issue: string
}

export interface PlanCritique {
  verdict: CritiqueVerdict
  summary: string
  deficiencies: CritiqueDeficiency[]
}

const PlanCritiqueSchema = z
  .object({
    verdict: z.enum(['sound', 'revise']),
    summary: z.string().min(1).max(600),
    deficiencies: z.array(z.object({ issue: z.string().min(1).max(300) }).strict()).max(8),
  })
  .strict()

export function buildCriticMessages(plan: ProposedPlanInput, message: string, context: AgentContext): GatewayMessage[] {
  return [
    {
      role: 'system',
      content: systemPrompt(
        OPERATOR_PERSONA,
        CARACAL_PLATFORM,
        [
          'THIS TURN: PLAN CORRECTNESS REVIEW. You review a proposed change plan that has already passed',
          "capability-catalog validation, and judge one thing: would it actually achieve the user's stated",
          'goal, correctly and completely, using only Caracal capabilities. You are the correctness critic,',
          'distinct from the security guardian — you do not judge blast radius or policy posture, you judge',
          'whether the plan is right.',
          'Look for material defects a single replanning pass could fix: a missing prerequisite step (a',
          'grant whose application or resource is never created first), a step targeting the wrong object',
          'or a name the context does not show exists, an argument that does not match the goal, scopes',
          'narrower or wider than the request actually needs, steps out of dependency order, or a goal the',
          'plan only partially covers. Ground every judgement in the live state and recent activity in the',
          'context; do not invent objects the context does not show.',
          'Be decisive and economical. Set "verdict" to "revise" only when there is a concrete, fixable',
          'defect that would make the plan fail or do the wrong thing, and list each defect as a specific',
          '"issue" the planner can act on. Set "verdict" to "sound" — with an empty deficiencies array —',
          'when the plan correctly and completely achieves the goal; do not nitpick a working plan into a',
          'rewrite. You only advise a revision; you never edit the plan, approve it, or apply it.',
          'Reply with ONLY a JSON object {"verdict": "sound"|"revise", "summary": string, "deficiencies":',
          '[{"issue": string}]}. The summary is one plain sentence on whether the plan achieves the goal.',
        ].join('\n'),
      ),
    },
    {
      role: 'user',
      content: `Context:\n${describeContext(context)}\n\nRequest: ${message}\n\nProposed plan:\n${describePlanForReview(plan)}`,
    },
  ]
}

// Reviews a catalog-valid plan for correctness and completeness and returns a verdict. The answer
// is a schema-validated object, so a malformed or off-schema critique fails closed as an error and
// the orchestrator simply keeps the plan unchanged. A per-turn budget refusal is a governance stop,
// not a critique failure, so it propagates rather than being reported as "sound". The critique never
// gates a plan — it only decides whether one more replanning pass is worth running.
export async function runCritic(
  gateway: Gateway,
  plan: ProposedPlanInput,
  message: string,
  context: AgentContext,
): Promise<AgentResult<PlanCritique>> {
  try {
    const completion = await gateway.completeObject(buildCriticMessages(plan, message, context), PlanCritiqueSchema, {
      maxTokens: CRITIC_MAX_TOKENS,
      temperature: 0,
    })
    return {
      ok: true,
      value: {
        verdict: completion.value.verdict,
        summary: completion.value.summary,
        deficiencies: completion.value.deficiencies ?? [],
      },
    }
  } catch (err) {
    if (err instanceof GatewayBudgetError) throw err
    return { ok: false, error: 'plan critique did not produce a usable verdict' }
  }
}

// The answer-grounding check's verdict on a read answer: whether every claim it makes about the
// zone's state is supported by the live evidence read this turn, and — when it is not — the concrete
// correction the answer got wrong. It judges a read answer the same way the guardian judges a plan:
// against what actually exists, never in the abstract. It carries no authority and gates nothing —
// the answer is a read-only note — so a flagged answer is corrected with a caveat, never suppressed.
export interface AnswerGrounding {
  grounded: boolean
  correction?: string
}

const AnswerGroundingSchema = z
  .object({
    grounded: z.boolean(),
    correction: z.string().min(1).max(600).optional(),
  })
  .strict()

export function buildAnswerCheckMessages(message: string, answer: string, context: AgentContext): GatewayMessage[] {
  return [
    {
      role: 'system',
      content: systemPrompt(
        OPERATOR_PERSONA,
        CARACAL_PLATFORM,
        [
          'THIS TURN: ANSWER GROUNDING CHECK. Another Operator agent has drafted a read-only answer to the',
          "user. Your one job is to confirm it is grounded in reality: every claim it makes about this zone's",
          'state — which applications, providers, resources, or policies exist, their counts, their auth modes',
          'or scopes — must be supported by the live state read just now in the context. You judge grounding',
          'only; you do not rewrite the answer, change its advice, or second-guess a correct judgement call.',
          'Set "grounded" to true when every factual claim about current state matches the evidence, or when',
          'the answer makes no state claim at all (a general explanation, a how-to, a recommendation). Set it',
          'to false only when the answer asserts a concrete state fact the evidence contradicts or does not',
          'show — it names an application, provider, resource, or policy that is not present, misstates a count',
          'or a scope, or claims something exists that the live reads do not show. When the live state could',
          'not be read, do not treat an ungrounded claim as contradicted — there is nothing to contradict it —',
          'so set "grounded" true and let the answer stand.',
          'When "grounded" is false, set "correction" to one plain sentence stating what the evidence actually',
          'shows, so the user is not misled. Do not manufacture a discrepancy: prefer "grounded" true whenever',
          'the answer is consistent with — or simply unaddressed by — the evidence.',
          'Reply with ONLY a JSON object {"grounded": boolean, "correction": string}. Omit "correction" when',
          'grounded is true.',
        ].join('\n'),
      ),
    },
    { role: 'user', content: `Context:\n${describeContext(context)}\n\nUser request: ${message}\n\nDrafted answer:\n${answer}` },
  ]
}

// Checks a read answer against the live evidence and returns a grounding verdict. The answer is a
// schema-validated object, so a malformed or off-schema verdict fails closed as an error and the
// orchestrator simply lets the original answer stand. A per-turn budget refusal is a governance
// stop, so it propagates rather than being reported as a grounding failure. The check never gates
// or suppresses an answer — a read answer holds no authority — it only lets Caracal append a
// grounding caveat when the draft claimed something the evidence does not support.
export async function runAnswerCheck(
  gateway: Gateway,
  message: string,
  answer: string,
  context: AgentContext,
): Promise<AgentResult<AnswerGrounding>> {
  try {
    const completion = await gateway.completeObject(buildAnswerCheckMessages(message, answer, context), AnswerGroundingSchema, {
      maxTokens: ANSWER_CHECK_MAX_TOKENS,
      temperature: 0,
    })
    return { ok: true, value: completion.value }
  } catch (err) {
    if (err instanceof GatewayBudgetError) throw err
    return { ok: false, error: 'answer grounding check did not produce a usable verdict' }
  }
}
