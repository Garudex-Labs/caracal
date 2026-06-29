// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// The Operator orchestrator: a skill registry and a per-turn dispatcher that triages a request to its tier and runs the one skill that handles it.

import {
  runTriage,
  tierPlans,
  tierReadsState,
  tierComposes,
  runPlanner,
  runExplainer,
  runTroubleshooter,
  runTranslator,
  runSecurityAnalyst,
  type AgentContext,
  type AgentResult,
  type OperatorMode,
  type OperatorTier,
  type OperatorTriage,
  type SecurityAdvisory,
} from './operator-agents.js'
import type { ProposedPlanInput } from './operator-capabilities.js'
import type { Researcher } from './operator-research.js'
import type { Gateway } from './operator-gateway.js'

// A skill is a capability the orchestrator can invoke, not a pipeline stage. answer skills
// reply as text; plan skills produce a proposed plan the deterministic spine then governs. A
// skill holds no authority — it returns a typed artifact the route validates, previews, and
// (for plans) gates behind human approval. Later phases register more skills (researcher,
// validator, policy author, …) without changing the orchestrator.
export type SkillKind = 'answer' | 'plan'

export interface AnswerSkill {
  id: string
  kind: 'answer'
  run(gateway: Gateway, message: string, context: AgentContext): Promise<AgentResult<{ text: string; reasoning?: string }>>
}

export interface PlanSkill {
  id: string
  kind: 'plan'
  run(gateway: Gateway, message: string, context: AgentContext): Promise<AgentResult<ProposedPlanInput>>
}

export type Skill = AnswerSkill | PlanSkill

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
// gating — that the route surfaces to the human alongside the plan.
export type OrchestrationOutcome =
  | { kind: 'plan'; result: AgentResult<ProposedPlanInput>; advisory?: SecurityAdvisory }
  | { kind: 'answer'; result: AgentResult<{ text: string; reasoning?: string }> }

export interface OrchestrationResult {
  tier: OperatorTier
  outcome: OrchestrationOutcome
}

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
async function withEvidence(context: AgentContext, researcher: Researcher | null | undefined): Promise<AgentContext> {
  if (!researcher) return { ...context, liveStateUnavailable: true }
  try {
    const blackboard = await researcher.gather()
    return blackboard.evidence.length > 0 ? { ...context, evidence: blackboard.evidence } : context
  } catch {
    return context
  }
}

// Builds the orchestrator over a skill registry. Per turn it triages the request to its tier and,
// for a read, its topic, then runs the one skill the registry selects. A triage that fails the
// schema defaults to a general read, which answers as text and never acts — the safe direction on
// ambiguity. In ask mode a request that would require a change is never planned: the orchestrator
// returns a deterministic switch-to-agent answer before any planning skill runs, so an ask
// conversation is provably write-incapable at the skill layer (the route refuses writes
// independently as defense in depth). A read tier grounds its answer in live state gathered
// through governed reads. A compound tier composes specialists: it gathers live state, plans
// against it, and runs an advisory security review over the proposed plan. Every plan — single or
// composed — still flows through the deterministic spine the route owns; the orchestrator selects
// and runs skills and gathers read-only evidence, and never validates, previews, persists, or
// applies, and the advisory it attaches only informs the human and never gates the plan.
export function createOrchestrator(registry: SkillRegistry = createSkillRegistry()): Orchestrator {
  return {
    async handle(gateway, message, context, options = {}): Promise<OrchestrationResult> {
      const mode: OperatorMode = options.mode ?? 'agent'
      const triage = await runTriage(gateway, message)
      const classification: OperatorTriage = triage.ok ? triage.value : { tier: 'read', topic: 'general' }
      const tier = classification.tier

      // Ask mode is read-only: a change or compound request is answered with a deterministic
      // switch-to-agent message and no planning skill is ever selected or run, so the conversation
      // cannot produce a plan. Conversational and read requests proceed normally below.
      if (mode === 'ask' && tierPlans(tier)) {
        return { tier, outcome: { kind: 'answer', result: { ok: true, value: { text: ASK_MODE_CHANGE_MESSAGE } } } }
      }

      const skill = registry.select(classification)

      if (skill.kind === 'plan') {
        // A compound request plans against freshly read live state; a single change does not, so
        // the common single-domain case stays the cheap single-skill path.
        const planContext = tierComposes(tier) ? await withEvidence(context, options.researcher) : context
        const result = await skill.run(gateway, message, planContext)
        // The advisory review runs only for a composed plan that actually proposes steps. It is
        // informational and never gates: a failed or absent review simply attaches nothing.
        if (tierComposes(tier) && result.ok && result.value.steps.length > 0) {
          const review = await runSecurityAnalyst(gateway, result.value, planContext)
          return { tier, outcome: { kind: 'plan', result, advisory: review.ok ? review.value : undefined } }
        }
        return { tier, outcome: { kind: 'plan', result } }
      }

      // A read tier inspects current state, so it answers grounded in freshly read evidence; a
      // conversational tier needs no state read and pays nothing.
      const answerContext = tierReadsState(tier) ? await withEvidence(context, options.researcher) : context
      return { tier, outcome: { kind: 'answer', result: await skill.run(gateway, message, answerContext) } }
    },
  }
}
