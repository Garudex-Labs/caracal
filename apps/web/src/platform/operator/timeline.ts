/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Pure presenter that turns the Operator turn ledger into a display timeline and the latest plan's reviewable state.
*/
import type { OperatorTurn } from "@/platform/api/types";

export type TimelineRole = "user" | "operator" | "system";

export interface MessageItem {
  kind: "message" | "note";
  id: string;
  seq: number;
  role: TimelineRole;
  text: string;
}

export interface PlanStepView {
  id: string;
  capability: string;
  summary: string;
  mutating: boolean;
  status: "pending" | "succeeded" | "failed";
  detail?: string;
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
}

function readPlanSteps(content: Record<string, unknown>): RawPlanStep[] {
  const steps = Array.isArray(content.steps) ? content.steps : [];
  return steps.map((raw) => {
    const step = asRecord(raw);
    return {
      id: asString(step.id),
      capability: asString(step.capability),
      summary: asString(step.summary),
      mutating: step.mutating === true,
    };
  });
}

// Builds the display timeline from the ordered turn ledger and resolves the latest
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
      items.push({
        kind: turn.kind,
        id: turn.id,
        seq: turn.seq,
        role: turn.role,
        text: asString(asRecord(turn.content).text),
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
      const plan = resolvePlan(turn, readPlanSteps(content), asString(content.summary), ordered);
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
  ordered: OperatorTurn[],
): PlanItem {
  let decision: PlanItem["decision"] = "pending";
  let rejectionReason: string | null = null;
  let executed = false;
  const stepStatus = new Map<string, { status: "succeeded" | "failed"; detail?: string }>();

  for (const turn of ordered) {
    if (turn.seq <= planTurn.seq) continue;
    const content = asRecord(turn.content);
    if (content.plan_seq !== planTurn.seq) continue;
    if (turn.kind === "approval") {
      decision = "approved";
      rejectionReason = null;
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
      status: exec?.status ?? "pending",
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
  };
}
