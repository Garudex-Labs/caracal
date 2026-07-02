// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// The Operator orchestrator: a skill registry and a per-turn dispatcher that triages a request to its tier and runs the one skill that handles it.

import {
  runTriage,
  tierPlans,
  tierReadsState,
  tierAuthorsPolicy,
  runPlanner,
  runExplainer,
  runTroubleshooter,
  runTranslator,
  runSecurityAnalyst,
  runCritic,
  runAnswerCheck,
  runPolicyAuthor,
  type AgentContext,
  type AgentResult,
  type OperatorMode,
  type OperatorTier,
  type OperatorTriage,
  type PlannerProposal,
  type PolicyDraft,
  type RepairFeedback,
  type SecurityAdvisory,
} from './operator-agents.js'
import { validateProposedPlan, type ProposedPlanInput } from './operator-capabilities.js'
import type { Researcher } from './operator-research.js'
import type { Evidence } from './operator-research.js'
import type { DocSnippet } from './operator-docs.js'
import { streamingAnswers, type Gateway } from './operator-gateway.js'

// A skill is a capability the orchestrator can invoke, not a pipeline stage. answer skills
// reply as text; plan skills produce a proposed plan the deterministic spine then governs. A
// skill holds no authority — it returns a typed artifact the route validates, previews, and
// (for plans) gates behind human approval. Later phases register more skills (researcher,
// validator, policy author, …) without changing the orchestrator.
export type SkillKind = 'answer' | 'plan' | 'policy'

export interface AnswerSkill {
  id: string
  kind: 'answer'
  run(gateway: Gateway, message: string, context: AgentContext): Promise<AgentResult<{ text: string; reasoning?: string }>>
}

export interface PlanSkill {
  id: string
  kind: 'plan'
  run(gateway: Gateway, message: string, context: AgentContext): Promise<AgentResult<PlannerProposal>>
}

// The policy-authoring skill: turns intent into a validated authorization-policy draft. Like every
// skill it holds no authority — the draft's data documents were validated by Caracal's own contract
// before it returns, and creating, versioning, or activating any of them still flows through the
// governed, human-approved path the route owns.
export interface PolicySkill {
  id: string
  kind: 'policy'
  run(gateway: Gateway, message: string, context: AgentContext): Promise<AgentResult<PolicyDraft>>
}

export type Skill = AnswerSkill | PlanSkill | PolicySkill

// The registry the orchestrator selects from. It maps a triage classification to exactly one
// handling skill, so the dispatch is deterministic: the LLM triages into a tier and topic, and
// Caracal — not the model — decides which skill runs. A new specialist is added by registering it
// here against a tier and topic; the orchestrator's contract does not change.
export interface SkillRegistry {
  select(triage: OperatorTriage): Skill
}

// The typed artifact a turn produced, tagged so the route runs the matching deterministic path:
// a plan is validated, previewed, and stored for approval; an answer is recorded as a note. A
// plan from a composing tier may carry an advisory security review — informational only, never
// gating — that the route surfaces to the human alongside the plan. When the guardian judges the
// plan misaligned with how Caracal is meant to be used, the outcome also carries guidance: the
// Caracal-correct path the human should take instead, surfaced first so the turn teaches the right
// approach rather than silently complying. The plan itself is still persisted and remains
// approvable behind the unchanged human gate — guidance leads, the plan is the secondary option,
// and a misaligned plan is never auto-approved.
export type OrchestrationOutcome =
  | { kind: 'plan'; result: AgentResult<ProposedPlanInput>; advisory?: SecurityAdvisory; guidance?: string }
  | { kind: 'answer'; result: AgentResult<{ text: string; reasoning?: string }> }
  | { kind: 'policy'; result: AgentResult<PolicyDraft> }

export interface OrchestrationResult {
  tier: OperatorTier
  outcome: OrchestrationOutcome
}

// The deliberation stages a turn can pass through, emitted purely so a streaming caller can show
// live progress. A stage signal carries no authority and changes nothing: it never gates, never
// alters the outcome, and is fire-and-forget — the same turn produces the same governed result
// whether or not anyone is listening. Read stages gather state and answer; plan stages propose,
// repair, critique, revise, and guard.
export type ProgressStage = 'triaging' | 'gathering' | 'planning' | 'repairing' | 'critiquing' | 'revising' | 'guarding' | 'authoring' | 'answering'

export interface ProgressEvent {
  stage: ProgressStage
}

export type OnProgress = (event: ProgressEvent) => void

// The planning skill: the deterministic spine's proposer. It returns a proposed plan grounded
// in the capability catalog; the route validates and previews it before it is ever actionable.
const plannerSkill: PlanSkill = {
  id: 'planner',
  kind: 'plan',
  run: (gateway, message, context) => runPlanner(gateway, message, context),
}

// The read-only answering skill: explains state and decisions in plain language and never acts.
const explainerSkill: AnswerSkill = {
  id: 'explainer',
  kind: 'answer',
  run: (gateway, message, context) => runExplainer(gateway, message, context),
}

// The read-only diagnostic skill: diagnoses why an access was denied or a change failed, grounded
// in the live evidence and the conversation's error and decision history. It never acts.
const troubleshooterSkill: AnswerSkill = {
  id: 'troubleshooter',
  kind: 'answer',
  run: (gateway, message, context) => runTroubleshooter(gateway, message, context),
}

// The read-only integration skill: translates a real-world provider or resource into the Caracal
// connection kind, resource, and scopes that express it, grounded in the catalog and live state.
// It guides only; the connection itself still flows through the governed plan path.
const translatorSkill: AnswerSkill = {
  id: 'translator',
  kind: 'answer',
  run: (gateway, message, context) => runTranslator(gateway, message, context),
}

// The policy-authoring skill: turns intent into a validated authorization-policy draft grounded in
// live state. It authors only; every document is validated by Caracal before it returns, and
// creating, versioning, or activating the policy still flows through the governed, approval-gated
// path the route owns.
const policyAuthorSkill: PolicySkill = {
  id: 'policy-author',
  kind: 'policy',
  run: (gateway, message, context) => runPolicyAuthor(gateway, message, context),
}

// Picks the read-only answer specialist for a read request's topic: diagnostic questions go to the
// troubleshooter, integration questions to the provider-resource translator, and everything else
// to the general explainer. A misclassified topic only changes which read-only answer replies — it
// never widens authority — so it degrades safely to the explainer.
function answerSkillForTopic(topic: OperatorTriage['topic']): AnswerSkill {
  if (topic === 'diagnostic') return troubleshooterSkill
  if (topic === 'integration') return translatorSkill
  return explainerSkill
}

// The default registry: change and compound tiers plan; a read tier picks its answer specialist by
// topic; a conversational tier always uses the general explainer. Each entry is a skill keyed on a
// tier and topic, so a new specialist is added here without touching the orchestrator.
export function createSkillRegistry(): SkillRegistry {
  return {
    select({ tier, topic }: OperatorTriage): Skill {
      if (tierPlans(tier)) return plannerSkill
      if (tierAuthorsPolicy(tier)) return policyAuthorSkill
      if (tier === 'read') return answerSkillForTopic(topic)
      return explainerSkill
    },
  }
}

export interface Orchestrator {
  handle(gateway: Gateway, message: string, context: AgentContext, options?: HandleOptions): Promise<OrchestrationResult>
}

// Per-turn collaborators and settings the orchestrator runs under. researcher is an ephemeral,
// read-only worker bound to the Operator's scoped identity; when present and the tier inspects
// state, the orchestrator gathers live evidence before answering. It is null when governed reads
// are not configured, in which case the answer falls back to conversation context alone. mode is
// the conversation's Caracal-side operation mode; in ask mode the orchestrator never selects a
// plan skill, so an ask conversation cannot produce a plan. It defaults to agent.
export interface HandleOptions {
  researcher?: Researcher | null
  mode?: OperatorMode
  // Retrieves the documentation passages most relevant to the request from the Operator's bundled
  // corpus. When present, the answer skills are grounded in the real docs so they quote exact
  // package names, endpoints, and fields rather than inventing them. Omitted when documentation
  // grounding is not wired, in which case answers fall back to the model's own knowledge.
  docs?: (query: string) => DocSnippet[]
  // Receives a stage signal each time the turn advances to a new deliberation step. It is purely
  // informational — a streaming caller renders live progress from it — and holds no authority: it
  // never alters the outcome and is never awaited, so a turn produces the same governed result with
  // or without a listener. Omitted when the caller does not stream.
  onProgress?: OnProgress
  // Receives each text delta of a read or conversational answer as the model produces it, so a
  // streaming caller renders the answer token by token rather than all at once. Like onProgress it
  // is a fire-and-forget live preview: the turn's authoritative result is unchanged whether or not
  // anyone listens, and a plan turn never streams since it produces a structured plan, not prose.
  // Omitted when the caller does not stream.
  onAnswerDelta?: (chunk: string) => void
  // Receives each reasoning delta of a read or conversational answer as a reasoning model exposes
  // its chain of thought, so a streaming caller renders the thinking live rather than a blank wait
  // before the answer begins. Like onAnswerDelta it is a fire-and-forget live preview: the turn's
  // authoritative result is unchanged whether or not anyone listens, and it is absent for models
  // that expose no reasoning. Omitted when the caller does not stream.
  onReasoningDelta?: (chunk: string) => void
}

// The deterministic answer an ask-mode conversation returns for a request that would require a
// change. Ask mode is read-only, so the request is never planned; the operator is told to switch
// to agent mode to plan it. This is a fixed string, not a model call, so ask mode never invokes a
// planning skill.
export const ASK_MODE_CHANGE_MESSAGE =
  'This conversation is in ask mode, which is read-only — I can explain and investigate but cannot make changes. ' +
  'Switch this conversation to agent mode to plan and apply this change.'

// Gathers live state evidence and merges it into the context, without ever failing the turn. The
// researcher already isolates a single read's failure into a typed evidence entry; this also
// guards against an unexpected throw, degrading to the original context so the turn still
// produces a result. When no researcher is available — no governed read mandate is active for the
// conversation's zone — the context is marked so the read agents say so plainly rather than
// inventing state. Returns the context unchanged when a researcher gathered no evidence at all.
async function withEvidence(context: AgentContext, researcher: Researcher | null | undefined, domains?: string[]): Promise<AgentContext> {
  if (!researcher) return { ...context, liveStateUnavailable: true }
  try {
    const blackboard = await researcher.gather(domains)
    return blackboard.evidence.length > 0 ? { ...context, evidence: blackboard.evidence } : context
  } catch {
    return context
  }
}

// Grounds an answer in the real documentation: retrieves the passages most relevant to the request
// and attaches them to the context so the answering agent quotes exact names, endpoints, and fields
// rather than inventing them. Retrieval is pure in-memory work over the bundled corpus and never
// fails the turn — a retriever error or no match simply leaves the context ungrounded. Returns the
// context unchanged when no retriever is wired.
function withDocs(context: AgentContext, message: string, docs: HandleOptions['docs']): AgentContext {
  if (!docs) return context
  try {
    const snippets = docs(message)
    return snippets.length > 0 ? { ...context, docs: snippets } : context
  } catch {
    return context
  }
}

// Honors the planner's request to see more state before it commits to a plan: it runs one more
// targeted governed read over exactly the domains the planner named, merges the fresh evidence into
// the context (a re-read of a domain replaces its stale entry), and returns the expanded context so
// a single replan can ground on it. The planner only requests evidence — Caracal decides what is
// read and still owns validate, preview, and approval. Like the first gather it never fails the
// turn: with no researcher, no named domains, an empty read, or any error, the context is returned
// unchanged so the loop simply ends.
async function expandEvidence(context: AgentContext, researcher: Researcher | null | undefined, domains: string[]): Promise<AgentContext> {
  if (!researcher || domains.length === 0) return context
  try {
    const blackboard = await researcher.gather(domains)
    if (blackboard.evidence.length === 0) return context
    const merged = new Map<string, Evidence>()
    for (const entry of context.evidence ?? []) merged.set(entry.capability, entry)
    for (const entry of blackboard.evidence) merged.set(entry.capability, entry)
    return { ...context, evidence: [...merged.values()] }
  } catch {
    return context
  }
}

// Proposes a plan, repairs it once when it fails catalog validation, then critiques the catalog-
// valid plan for correctness and completeness and revises it once when the critic finds a material
// defect. It returns the strongest plan it reached: a critic-revised plan when the revision still
// validates and proposes steps, otherwise the repaired-or-original plan. A plan with no steps, or
// one that cannot be repaired, is returned as-is so the route still reports its diagnostics. Both
// the repair and the critique only decide whether another planning pass is worth running; neither
// approves or applies — the route owns the authoritative validate, preview, and approval of every
// plan, and the critic edits nothing itself.
async function deliberatePlan(
  gateway: Gateway,
  message: string,
  context: AgentContext,
  skill: PlanSkill,
  emit: OnProgress,
): Promise<AgentResult<PlannerProposal>> {
  emit({ stage: 'planning' })
  const proposal = await skill.run(gateway, message, context)
  if (!proposal.ok || proposal.value.steps.length === 0) return proposal

  let candidate = proposal
  const validation = validateProposedPlan(candidate.value)
  if (!validation.ok) {
    const feedback: RepairFeedback = {
      priorSummary: candidate.value.summary,
      diagnostics: validation.diagnostics.map((d) => `${d.step_id}: ${d.message}`),
    }
    emit({ stage: 'repairing' })
    const repaired = await runPlanner(gateway, message, context, feedback)
    if (repaired.ok && validateProposedPlan(repaired.value).ok) candidate = repaired
    else return candidate
  }

  // The catalog-valid plan is reviewed for correctness, not security: a 'revise' verdict with
  // concrete deficiencies drives one replanning pass, and the revision is adopted only when it
  // still proposes steps and still validates against the catalog. A 'sound' verdict, an empty
  // deficiency list, or a failed critique leaves the plan unchanged, so the critic only ever
  // sharpens a proposal and never blocks or empties one.
  emit({ stage: 'critiquing' })
  const critique = await runCritic(gateway, candidate.value, message, context)
  if (critique.ok && critique.value.verdict === 'revise' && critique.value.deficiencies.length > 0) {
    const feedback: RepairFeedback = {
      priorSummary: candidate.value.summary,
      diagnostics: critique.value.deficiencies.map((d) => d.issue),
    }
    emit({ stage: 'revising' })
    const revised = await runPlanner(gateway, message, context, feedback)
    if (revised.ok && revised.value.steps.length > 0 && validateProposedPlan(revised.value).ok) return revised
  }
  return candidate
}

// Grounds a read answer in the live evidence the same way the guardian grounds a plan: when the
// turn gathered real state, it checks the drafted answer against that evidence and, if the answer
// claimed a state fact the evidence does not support, appends a single Caracal correction so the
// user is not misled. It only refines — it never suppresses or rewrites the answer, which holds no
// authority as a read-only note — and it fails open: with no evidence to check against, an
// unsuccessful draft, a failed check, or any error, the original answer stands unchanged.
async function groundAnswer(
  gateway: Gateway,
  message: string,
  answer: AgentResult<{ text: string; reasoning?: string }>,
  context: AgentContext,
): Promise<AgentResult<{ text: string; reasoning?: string }>> {
  if (!answer.ok || !context.evidence || context.evidence.length === 0) return answer
  try {
    const check = await runAnswerCheck(gateway, message, answer.value.text, context)
    if (check.ok && !check.value.grounded && check.value.correction) {
      return { ok: true, value: { ...answer.value, text: `${answer.value.text}\n\nCorrection: ${check.value.correction}` } }
    }
    return answer
  } catch {
    return answer
  }
}

// Builds the orchestrator over a skill registry. Per turn it triages the request to its tier and,
// for a read, its topic, then runs the one skill the registry selects. A triage that fails the
// schema defaults to a general read, which answers as text and never acts — the safe direction on
// ambiguity. In ask mode a request that would require a change is never planned: the orchestrator
// returns a deterministic switch-to-agent answer before any planning skill runs, so an ask
// conversation is provably write-incapable at the skill layer (the route refuses writes
// independently as defense in depth). A read tier grounds its answer in live state gathered
// through governed reads. A plan request runs a deliberation loop: it gathers live state, proposes
// against it, repairs the proposal once if it fails catalog validation, critiques the valid plan
// for correctness and revises it once when a material defect is found, and runs an independent
// advisory guardian review over the resulting plan. Every plan still flows through the
// deterministic spine the route owns; the orchestrator selects and runs skills and gathers
// read-only evidence, and never validates for approval, previews, persists, or applies, and the
// advisory it attaches only informs the human and never gates the plan.
export function createOrchestrator(registry: SkillRegistry = createSkillRegistry()): Orchestrator {
  return {
    async handle(gateway, message, context, options = {}): Promise<OrchestrationResult> {
      const mode: OperatorMode = options.mode ?? 'agent'
      const emit: OnProgress = options.onProgress ?? (() => {})
      emit({ stage: 'triaging' })
      const triage = await runTriage(gateway, message, context)
      const classification: OperatorTriage = triage.ok ? triage.value : { tier: 'read', topic: 'general' }
      const tier = classification.tier

      // Ask mode is read-only: a change, compound, or policy-authoring request is answered with a
      // deterministic switch-to-agent message and no planning or authoring skill is ever selected or
      // run, so the conversation proposes nothing. Authoring is refused alongside planning because a
      // policy draft's whole purpose is a governed create the ask-mode write path would reject, so an
      // ask conversation must not surface that action at all. Conversational and read requests proceed.
      if (mode === 'ask' && (tierPlans(tier) || tierAuthorsPolicy(tier))) {
        return { tier, outcome: { kind: 'answer', result: { ok: true, value: { text: ASK_MODE_CHANGE_MESSAGE } } } }
      }

      const skill = registry.select(classification)

      if (skill.kind === 'policy') {
        // Policy authoring is grounded in freshly read live state so the specialist references the
        // applications, resources, and policies that actually exist rather than inventing them. The
        // specialist authors and validates a draft; it applies nothing, and creating, versioning, or
        // activating any document still flows through the governed, approval-gated path the route
        // owns. The draft is returned as its own outcome the route persists and surfaces.
        emit({ stage: 'gathering' })
        const policyContext = withDocs(await withEvidence(context, options.researcher, classification.domains), message, options.docs)
        emit({ stage: 'authoring' })
        const result = await skill.run(gateway, message, policyContext)
        return { tier, outcome: { kind: 'policy', result } }
      }

      if (skill.kind === 'plan') {
        // Every plan is grounded in freshly read live state, so the planner proposes against reality
        // and the guardian judges against it. The deliberation loop proposes, validates against the
        // catalog, repairs once when the first proposal is invalid, critiques the valid plan for
        // correctness and revises it once when a material defect is found, then runs an independent
        // guardian review over any plan that proposes steps. The route still owns validate, preview,
        // approve, and apply; the guardian, the critic, and the repair pass only improve and inform
        // the proposal.
        emit({ stage: 'gathering' })
        let planContext = withDocs(await withEvidence(context, options.researcher, classification.domains), message, options.docs)
        let result = await deliberatePlan(gateway, message, planContext, skill, emit)
        // The planner may decline to plan and instead name the object domains it must read before it
        // can propose responsibly. Caracal honors that exactly once: it reads those domains, merges
        // the fresh evidence into the context, and replans. The loop is bounded to a single expansion
        // so a turn can never fan out unboundedly, and the planner only directs what to read — Caracal
        // decides and still owns validate, preview, and approval of whatever plan results.
        if (result.ok && result.value.steps.length === 0 && result.value.needs && options.researcher) {
          emit({ stage: 'gathering' })
          planContext = await expandEvidence(planContext, options.researcher, result.value.needs.domains)
          result = await deliberatePlan(gateway, message, planContext, skill, emit)
        }
        // When the planner could not plan responsibly it proposes no steps and asks one clarifying
        // question instead of guessing. Caracal relays that question to the operator as an answer
        // — it is recorded as a note, never as an actionable plan — so an underspecified request is
        // answered with a precise question rather than a fabricated change.
        if (result.ok && result.value.steps.length === 0 && result.value.clarification) {
          return { tier, outcome: { kind: 'answer', result: { ok: true, value: { text: result.value.clarification } } } }
        }
        if (result.ok && result.value.steps.length > 0) {
          emit({ stage: 'guarding' })
          const review = await runSecurityAnalyst(gateway, result.value, planContext)
          const advisory = review.ok ? review.value : undefined
          // When the guardian judges the plan misaligned with how Caracal is meant to be used, the
          // outcome leads with the Caracal-correct path instead of silently surfacing the plan: the
          // guidance is the guardian's concrete recommendation (its summary when it gave none). The
          // plan stays attached and approvable behind the human gate, so the human can still proceed
          // deliberately — but the turn teaches the right approach first and the route never
          // auto-approves a misaligned plan.
          const guidance = advisory && advisory.alignment === 'misaligned' ? (advisory.recommendation ?? advisory.summary) : undefined
          return { tier, outcome: { kind: 'plan', result, advisory, guidance } }
        }
        return { tier, outcome: { kind: 'plan', result } }
      }

      // A read tier inspects current state, so it answers grounded in freshly read evidence; a
      // conversational tier needs no state read and pays nothing. Both ground their answer in the
      // real documentation so exact names, endpoints, and fields come from the docs, not the model.
      const reads = tierReadsState(tier)
      if (reads) emit({ stage: 'gathering' })
      const stateContext = reads ? await withEvidence(context, options.researcher, classification.domains) : context
      const answerContext = withDocs(stateContext, message, options.docs)
      emit({ stage: 'answering' })
      // Stream the answer's tokens and the model's reasoning to the caller when it is listening, so
      // the console renders the answer as it is produced and shows the thinking while it works.
      // Only the answer skill streams; grounding below still uses the unwrapped gateway, so its
      // structured check is unaffected.
      const answerGateway = options.onAnswerDelta
        ? streamingAnswers(gateway, options.onAnswerDelta, options.onReasoningDelta)
        : gateway
      const answer = await skill.run(answerGateway, message, answerContext)
      return { tier, outcome: { kind: 'answer', result: await groundAnswer(gateway, message, answer, answerContext) } }
    },
  }
}
