/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Pure presenter that turns the Operator turn ledger into a display timeline and the latest plan's reviewable state.
*/
import type { OperatorProgressStage, OperatorTurn } from "@/platform/api/types";

export type TimelineRole = "user" | "operator" | "system";

export interface MessageItem {
  kind: "message" | "note";
  id: string;
  seq: number;
  role: TimelineRole;
  text: string;
  // The model's chain of thought, present when a reasoning model exposed it on an
  // operator note. Absent for user messages and answers with no reasoning.
  reasoning?: string;
  // The ordered deliberation stages the answer passed through, recorded on the turn so the
  // reasoning can be replayed after the live stream ends. Absent on user messages.
  deliberation?: OperatorProgressStage[];
  // The structured policy draft the authoring specialist produced, present only on the operator
  // note that carried one. It renders as the dedicated policy artifact rather than plain prose.
  policy?: PolicyDraftView;
}

// The advisory severity the authoring specialist assigns each risk it found in a draft, ordered by
// how much it should slow an approver down.
export type PolicyRiskSeverity = "info" | "caution" | "warning";

export interface PolicyRiskView {
  severity: PolicyRiskSeverity;
  note: string;
}

// A ready-to-run authorization case the specialist proposes so the draft can be exercised before it
// is created: the named scenario, the input it feeds the decision contract, and the decision the
// draft is expected to yield.
export interface PolicySimulationView {
  name: string;
  description: string;
  input: Record<string, unknown>;
  expectedDecision: "allow" | "deny";
}

// Caracal's own deterministic reading of a validated data document: the package it declares, the
// data rules it defines, whether it sets a default result, the decisions it names, and the input and
// data paths it reads. Computed from the content itself, never claimed by the model.
export interface PolicyDocumentPreview {
  package: string;
  rules: string[];
  defaultResult: boolean;
  decisions: string[];
  inputsReferenced: string[];
  dataReferenced: string[];
}

// One validated data document in a draft: the concern it serves, its suggested file name, the
// authored Rego, the plain-English explanation, and Caracal's deterministic preview of it. A document
// only reaches a draft after the platform validated it, so its content is always valid Rego.
export interface PolicyDocumentView {
  concern: string;
  filename: string;
  content: string;
  explanation: string;
  preview: PolicyDocumentPreview | null;
}

// The provenance stamped on an AI-assisted draft so every downstream artifact stays auditable: that
// a model assisted, which model served, when it was generated, and the operator request it answered.
export interface PolicyProvenanceView {
  aiAssisted: true;
  model: string;
  generatedAt: string;
  sourceMessage: string;
}

export interface PolicyActivationView {
  ready: boolean;
  blockers: string[];
  guidance: string;
}

// The policy specialist's structured artifact as the console reads it: the understood intent, one or
// more validated documents, the risks and least-privilege recommendations found, ready-to-run
// simulation cases, activation readiness, provenance, and the schema version the documents target.
// When intent was too ambiguous to author safely the documents are empty and the clarifying
// questions carry instead.
export interface PolicyDraftView {
  summary: string;
  intent: string;
  documents: PolicyDocumentView[];
  clarifications: string[];
  assumptions: string[];
  risks: PolicyRiskView[];
  recommendations: string[];
  simulations: PolicySimulationView[];
  activation: PolicyActivationView | null;
  schemaVersion: string;
  provenance: PolicyProvenanceView | null;
}

// The planner's own honest assessment of how consequential a step is, ordered low to high. It is
// advisory: the guardian and the human approver still decide.
export type StepRisk = "low" | "medium" | "high";

// What applying a step would do against live state at the moment the plan was previewed: bring a
// new thing into being, change an existing one, remove one, find it already in the desired state,
// or find it blocked. Informational only - execution re-previews before applying.
export type StepEffect = "create" | "update" | "delete" | "exists" | "blocked" | "read_only";

export interface PlanStepView {
  id: string;
  capability: string;
  summary: string;
  mutating: boolean;
  args: Record<string, unknown>;
  status: "pending" | "succeeded" | "failed";
  detail?: string;
  // The ids of the steps that must complete before this one, in plan order.
  dependsOn: string[];
  // The planner's declared risk for this step, present when it tagged one.
  risk?: StepRisk;
  // The effect this step was previewed to have against live state, present when the plan carried a
  // preview. Informational: it shows the consequence reviewed, not a guarantee at apply time.
  effect?: StepEffect;
}

export type AdvisorySeverity = "info" | "caution" | "warning";

// The guardian's verdict on whether the plan matches how Caracal is meant to be used.
export type AdvisoryAlignment = "aligned" | "risky" | "misaligned";

export interface AdvisoryFindingView {
  severity: AdvisorySeverity;
  concern: string;
}

// The advisory security review a composed plan may carry. Informational only - it is surfaced to
// the reviewer and never changes whether the plan can be approved or applied. When the plan is
// risky or misaligned the guardian also names the Caracal-correct approach so the review teaches
// rather than only warns.
export interface PlanAdvisoryView {
  summary: string;
  alignment?: AdvisoryAlignment;
  findings: AdvisoryFindingView[];
  recommendation?: string;
}

export interface PlanItem {
  kind: "plan";
  id: string;
  seq: number;
  summary: string;
  steps: PlanStepView[];
  decision: "pending" | "approved" | "rejected";
  rejectionReason: string | null;
  executed: boolean;
  // Whether the plan can still be acted on: a pending plan can be approved or
  // rejected; an approved, not-yet-executed plan can be applied.
  canDecide: boolean;
  canExecute: boolean;
  // The advisory security review, present only for a composed plan that carried one.
  advisory?: PlanAdvisoryView;
  // The ordered deliberation stages the plan was reasoned through, recorded on the turn so the
  // path from triage to guard can be replayed after the live stream ends.
  deliberation?: OperatorProgressStage[];
  // Whether the approval was auto-satisfied by Caracal-governed autopilot rather than a human.
  approvedByAutopilot: boolean;
}

export interface ErrorItem {
  kind: "error";
  id: string;
  seq: number;
  message: string;
}

export type TimelineItem = MessageItem | PlanItem | ErrorItem;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

interface RawPlanStep {
  id: string;
  capability: string;
  summary: string;
  mutating: boolean;
  args: Record<string, unknown>;
  dependsOn: string[];
  risk?: StepRisk;
  effect?: StepEffect;
}

function readStepRisk(value: unknown): StepRisk | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function readStepEffect(value: unknown): StepEffect | undefined {
  return value === "create" ||
    value === "update" ||
    value === "delete" ||
    value === "exists" ||
    value === "blocked" ||
    value === "read_only"
    ? value
    : undefined;
}

function readDependsOn(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(asString).filter((id) => id.length > 0);
}

const DELIBERATION_STAGES: readonly OperatorProgressStage[] = [
  "triaging",
  "gathering",
  "planning",
  "repairing",
  "critiquing",
  "revising",
  "guarding",
  "answering",
];

// Reads the recorded deliberation trail from a turn's content, keeping only recognized stages so a
// malformed or future value degrades to nothing rather than rendering an unknown step.
function readDeliberation(value: unknown): OperatorProgressStage[] {
  if (!Array.isArray(value)) return [];
  return value.filter((stage): stage is OperatorProgressStage =>
    DELIBERATION_STAGES.includes(stage as OperatorProgressStage),
  );
}

function readPlanSteps(content: Record<string, unknown>): RawPlanStep[] {
  const steps = Array.isArray(content.steps) ? content.steps : [];
  return steps.map((raw) => {
    const step = asRecord(raw);
    const risk = readStepRisk(step.risk);
    const effect = readStepEffect(step.effect);
    return {
      id: asString(step.id),
      capability: asString(step.capability),
      summary: asString(step.summary),
      mutating: step.mutating === true,
      args: asRecord(step.args),
      dependsOn: readDependsOn(step.depends_on),
      ...(risk ? { risk } : {}),
      ...(effect ? { effect } : {}),
    };
  });
}

// Reads the advisory security review from a plan turn's content, when present. Only the recognized
// severities are kept and a finding must carry a concern, so a malformed advisory degrades to
// nothing rather than rendering noise. Returns undefined when the plan carried no advisory.
function readAdvisoryAlignment(value: unknown): AdvisoryAlignment | undefined {
  return value === "aligned" || value === "risky" || value === "misaligned" ? value : undefined;
}

function readPlanAdvisory(content: Record<string, unknown>): PlanAdvisoryView | undefined {
  const advisory = asRecord(content.advisory);
  const summary = asString(advisory.summary);
  if (summary.length === 0) return undefined;
  const rawFindings = Array.isArray(advisory.findings) ? advisory.findings : [];
  const findings: AdvisoryFindingView[] = [];
  for (const raw of rawFindings) {
    const finding = asRecord(raw);
    const severity = finding.severity;
    const concern = asString(finding.concern);
    if (
      (severity === "info" || severity === "caution" || severity === "warning") &&
      concern.length > 0
    ) {
      findings.push({ severity, concern });
    }
  }
  const alignment = readAdvisoryAlignment(advisory.alignment);
  const recommendation = asString(advisory.recommendation);
  return {
    summary,
    findings,
    ...(alignment ? { alignment } : {}),
    ...(recommendation.length > 0 ? { recommendation } : {}),
  };
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(asString).filter((entry) => entry.length > 0);
}

function readPolicyRiskSeverity(value: unknown): PolicyRiskSeverity {
  return value === "caution" || value === "warning" ? value : "info";
}

function readPolicyRisks(value: unknown): PolicyRiskView[] {
  if (!Array.isArray(value)) return [];
  const risks: PolicyRiskView[] = [];
  for (const raw of value) {
    const risk = asRecord(raw);
    const note = asString(risk.note);
    if (note.length === 0) continue;
    risks.push({ severity: readPolicyRiskSeverity(risk.severity), note });
  }
  return risks;
}

function readPolicySimulations(value: unknown): PolicySimulationView[] {
  if (!Array.isArray(value)) return [];
  const cases: PolicySimulationView[] = [];
  for (const raw of value) {
    const sim = asRecord(raw);
    const name = asString(sim.name);
    if (name.length === 0) continue;
    cases.push({
      name,
      description: asString(sim.description),
      input: asRecord(sim.input),
      expectedDecision: sim.expectedDecision === "deny" ? "deny" : "allow",
    });
  }
  return cases;
}

function readPolicyDocumentPreview(value: unknown): PolicyDocumentPreview | null {
  if (value == null || typeof value !== "object") return null;
  const preview = asRecord(value);
  const pkg = asString(preview.package);
  if (pkg.length === 0) return null;
  return {
    package: pkg,
    rules: asStringList(preview.rules),
    defaultResult: preview.default_result === true,
    decisions: asStringList(preview.decisions),
    inputsReferenced: asStringList(preview.inputs_referenced),
    dataReferenced: asStringList(preview.data_referenced),
  };
}

function readPolicyDocuments(value: unknown): PolicyDocumentView[] {
  if (!Array.isArray(value)) return [];
  const documents: PolicyDocumentView[] = [];
  for (const raw of value) {
    const doc = asRecord(raw);
    const content = asString(doc.content);
    if (content.length === 0) continue;
    documents.push({
      concern: asString(doc.concern),
      filename: asString(doc.filename),
      content,
      explanation: asString(doc.explanation),
      preview: readPolicyDocumentPreview(doc.preview),
    });
  }
  return documents;
}

function readPolicyActivation(value: unknown): PolicyActivationView | null {
  if (value == null || typeof value !== "object") return null;
  const activation = asRecord(value);
  return {
    ready: activation.ready === true,
    blockers: asStringList(activation.blockers),
    guidance: asString(activation.guidance),
  };
}

function readPolicyProvenance(value: unknown): PolicyProvenanceView | null {
  const provenance = asRecord(value);
  const model = asString(provenance.model);
  if (model.length === 0) return null;
  return {
    aiAssisted: true,
    model,
    generatedAt: asString(provenance.generatedAt),
    sourceMessage: asString(provenance.sourceMessage),
  };
}

// Reads the structured policy draft from an operator note's content, when present. A draft is only
// recognized when it carries a summary, so a note without one degrades to plain prose rather than
// rendering an empty artifact. Every field is read defensively so a malformed or partial draft still
// renders the parts that are sound instead of failing the whole timeline.
function readPolicyDraft(value: unknown): PolicyDraftView | undefined {
  if (value == null || typeof value !== "object") return undefined;
  const draft = asRecord(value);
  const summary = asString(draft.summary);
  if (summary.length === 0) return undefined;
  return {
    summary,
    intent: asString(draft.intent),
    documents: readPolicyDocuments(draft.documents),
    clarifications: asStringList(draft.clarifications),
    assumptions: asStringList(draft.assumptions),
    risks: readPolicyRisks(draft.risks),
    recommendations: asStringList(draft.recommendations),
    simulations: readPolicySimulations(draft.simulations),
    activation: readPolicyActivation(draft.activation),
    schemaVersion: asString(draft.schemaVersion),
    provenance: readPolicyProvenance(draft.provenance),
  };
}

// plan's reviewable state by folding the approval, rejection, and execution turns
// that reference it. The presenter is the single place the UI learns whether a plan
// can be approved or applied, so those controls cannot drift from the ledger.
export function buildTimeline(turns: OperatorTurn[]): {
  items: TimelineItem[];
  latestPlan: PlanItem | null;
} {
  const ordered = [...turns].sort((a, b) => a.seq - b.seq);

  let latestPlanSeq: number | null = null;
  for (const turn of ordered) {
    if (turn.kind === "plan") latestPlanSeq = turn.seq;
  }

  const items: TimelineItem[] = [];
  let latestPlan: PlanItem | null = null;

  for (const turn of ordered) {
    if (turn.kind === "message" || turn.kind === "note") {
      const content = asRecord(turn.content);
      const reasoning = asString(content.reasoning);
      const deliberation = readDeliberation(content.deliberation);
      const policy = readPolicyDraft(content.policy);
      items.push({
        kind: turn.kind,
        id: turn.id,
        seq: turn.seq,
        role: turn.role,
        text: asString(content.text),
        reasoning: reasoning.length > 0 ? reasoning : undefined,
        ...(deliberation.length > 0 ? { deliberation } : {}),
        ...(policy ? { policy } : {}),
      });
    } else if (turn.kind === "error") {
      items.push({
        kind: "error",
        id: turn.id,
        seq: turn.seq,
        message: asString(asRecord(turn.content).message),
      });
    } else if (turn.kind === "plan") {
      const content = asRecord(turn.content);
      const plan = resolvePlan(
        turn,
        readPlanSteps(content),
        asString(content.summary),
        readPlanAdvisory(content),
        readDeliberation(content.deliberation),
        ordered,
      );
      items.push(plan);
      if (turn.seq === latestPlanSeq) latestPlan = plan;
    }
  }

  return { items, latestPlan };
}

function resolvePlan(
  planTurn: OperatorTurn,
  steps: RawPlanStep[],
  summary: string,
  advisory: PlanAdvisoryView | undefined,
  deliberation: OperatorProgressStage[],
  ordered: OperatorTurn[],
): PlanItem {
  let decision: PlanItem["decision"] = "pending";
  let rejectionReason: string | null = null;
  let executed = false;
  let approvedByAutopilot = false;
  const stepStatus = new Map<string, { status: "succeeded" | "failed"; detail?: string }>();

  for (const turn of ordered) {
    if (turn.seq <= planTurn.seq) continue;
    const content = asRecord(turn.content);
    if (content.plan_seq !== planTurn.seq) continue;
    if (turn.kind === "approval") {
      decision = "approved";
      rejectionReason = null;
      approvedByAutopilot = content.autopilot === true;
    } else if (turn.kind === "rejection") {
      decision = "rejected";
      rejectionReason = asString(content.reason) || null;
    } else if (turn.kind === "execution") {
      executed = true;
      const status = content.status === "failed" ? "failed" : "succeeded";
      stepStatus.set(asString(content.step_id), {
        status,
        detail: asString(content.detail) || undefined,
      });
    }
  }

  const stepViews: PlanStepView[] = steps.map((step) => {
    const exec = stepStatus.get(step.id);
    return {
      id: step.id,
      capability: step.capability,
      summary: step.summary,
      mutating: step.mutating,
      args: step.args,
      status: exec?.status ?? "pending",
      dependsOn: step.dependsOn,
      ...(step.risk ? { risk: step.risk } : {}),
      ...(step.effect ? { effect: step.effect } : {}),
      ...(exec?.detail ? { detail: exec.detail } : {}),
    };
  });

  return {
    kind: "plan",
    id: planTurn.id,
    seq: planTurn.seq,
    summary,
    steps: stepViews,
    decision,
    rejectionReason,
    executed,
    canDecide: decision === "pending",
    canExecute: decision === "approved" && !executed,
    approvedByAutopilot,
    ...(advisory ? { advisory } : {}),
    ...(deliberation.length > 0 ? { deliberation } : {}),
  };
}
