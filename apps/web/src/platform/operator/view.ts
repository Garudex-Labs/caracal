/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Pure presenter helpers for the Operator console: badge tones, relative time, session bucketing, suggestion selection, and plan decision-state mapping.
*/
import type { ConfirmationApproval } from "@/components/ai-elements/confirmation";
import type { ToolState } from "@/components/ai-elements/tool";
import { PLAN_STATUS } from "@/platform/operator/status";
import type { PlanAdvisoryView, PlanItem, PlanStepView } from "@/platform/operator/timeline";
import type { OperatorConversation } from "@/platform/api/types";

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "muted";

export type SuggestionId =
  "registerApp" | "connectProvider" | "defineResource" | "grant" | "rotate" | "explainDeny";

// Picks the most useful first suggestion for where this zone's setup actually stands. The Operator
// governs one already-provisioned zone, so the opening move is registering the first application
// when the zone has none, and granting scoped access once applications exist. The chosen pill leads
// the strip so the empty state reflects live state instead of a fixed script.
export function leadSuggestion(hasApps: boolean): SuggestionId {
  if (!hasApps) return "registerApp";
  return "grant";
}

// A concise session title derived from the opening intent.
export function deriveTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 48 ? `${clean.slice(0, 47).trimEnd()}…` : clean;
}

// The tail of the transcript to actually mount. A long session keeps every earlier turn in memory
// but renders only the most recent window so scrolling stays smooth; revealing earlier turns just
// widens the window. The window is taken from the end, so the newest turns - including any
// actionable plan - are always rendered.
export function streamWindow<T>(items: T[], count: number): T[] {
  if (count >= items.length) return items;
  return items.slice(items.length - count);
}

export function formatRelative(value: string): string {
  const date = new Date(value);
  const time = date.getTime();
  if (Number.isNaN(time)) return value;
  const diff = Date.now() - time;
  if (diff < 60_000) return "just now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

export interface SessionGroup {
  label: string;
  items: OperatorConversation[];
}

// Bucket sessions by last activity into the familiar Today / Yesterday / recent
// windows so a long history stays scannable. Empty buckets are dropped and the API
// order is preserved within each bucket.
export function groupConversations(conversations: OperatorConversation[]): SessionGroup[] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86_400_000;
  const buckets = [
    { label: "Today", min: startOfToday },
    { label: "Yesterday", min: startOfToday - day },
    { label: "Previous 7 days", min: startOfToday - 7 * day },
    { label: "Previous 30 days", min: startOfToday - 30 * day },
    { label: "Older", min: -Infinity },
  ].map((bucket) => ({ ...bucket, items: [] as OperatorConversation[] }));
  for (const conversation of conversations) {
    const time = new Date(conversation.last_activity_at).getTime();
    const bucket = buckets.find((entry) => time >= entry.min) ?? buckets[buckets.length - 1];
    bucket.items.push(conversation);
  }
  return buckets
    .filter((bucket) => bucket.items.length > 0)
    .map(({ label, items }) => ({ label, items }));
}

export function planDecision(plan: PlanItem): { tone: BadgeTone; label: string } {
  if (plan.decision === "approved") {
    if (plan.executed) return { tone: "success", label: PLAN_STATUS.applied };
    return plan.approvedByAutopilot
      ? { tone: "success", label: PLAN_STATUS.approvedByAutopilot }
      : { tone: "success", label: PLAN_STATUS.approved };
  }
  if (plan.decision === "rejected") return { tone: "danger", label: PLAN_STATUS.rejected };
  return { tone: "warning", label: PLAN_STATUS.awaitingApproval };
}

// Maps a step's ledger status to the tool lifecycle state: a rejected plan denies
// every step, an executed step reports its success or failure, and a step that has not
// run yet reads as pending. Execution is server-atomic, so a step is only ever awaiting,
// done, or failed - it never sits in a live running state on the client.
export function stepToolState(step: PlanStepView, plan: PlanItem): ToolState {
  if (plan.decision === "rejected") return "output-denied";
  if (step.status === "succeeded") return "output-available";
  if (step.status === "failed") return "output-error";
  return "input-streaming";
}

export function planApproval(plan: PlanItem): ConfirmationApproval {
  if (plan.decision === "approved") return { id: plan.id, approved: true };
  if (plan.decision === "rejected") {
    return {
      id: plan.id,
      approved: false,
      ...(plan.rejectionReason ? { reason: plan.rejectionReason } : {}),
    };
  }
  return { id: plan.id };
}

export function planConfirmationState(plan: PlanItem): ToolState {
  if (plan.decision === "pending") return "approval-requested";
  if (plan.decision === "rejected") return "output-denied";
  return plan.executed ? "output-available" : "approval-responded";
}

// Maps an advisory severity to a badge tone. The review is informational, so even a warning is a
// caution to weigh, not a block - the human still decides.
export function advisoryTone(
  severity: PlanAdvisoryView["findings"][number]["severity"],
): BadgeTone {
  if (severity === "warning") return "danger";
  if (severity === "caution") return "warning";
  return "muted";
}

// Maps the guardian's intent-alignment verdict to a label and badge tone. The verdict is the
// headline of the review: it names whether the plan matches how Caracal is meant to be used,
// without ever gating the human's decision.
export function alignmentVerdict(alignment: NonNullable<PlanAdvisoryView["alignment"]>): {
  label: string;
  tone: BadgeTone;
} {
  if (alignment === "aligned") return { label: "Aligned", tone: "success" };
  if (alignment === "risky") return { label: "Needs care", tone: "warning" };
  return { label: "Misaligned", tone: "danger" };
}

// An honest, human message for why applying a plan failed, so a refused execution never fails
// silently. Governed execution is bound to one zone, so a conversation in any other zone cannot
// apply changes; that case is named plainly rather than shown as a generic error.
export function executeErrorMessage(err: unknown): string {
  const code = (err as { code?: string } | null)?.code;
  switch (code) {
    case "governed_execution_unconfigured":
      return "Caracal can't apply changes in this zone - governed execution isn't configured here.";
    case "zone_forbidden":
      return "This zone is internal to Caracal, so the Operator can't apply changes here.";
    case "mode_forbidden":
      return "This conversation is in ask mode, so it can explain but not apply changes.";
    case "plan_already_executed":
      return "This plan was already applied.";
    case "plan_not_approved":
      return "Approve the plan before applying it.";
    case "plan_rejected":
      return "This plan was rejected, so it can't be applied.";
    case "plan_blocked":
      return "This plan can't be applied - a step depends on something an earlier step hasn't created yet.";
    case "conversation_archived":
      return "This conversation is archived, so it can't apply changes.";
    default:
      return "Couldn't apply the changes. Please try again.";
  }
}

// An honest, human message for why a decision could not be recorded, so approving or rejecting a
// plan never fails silently. Most of these mean the plan already moved on; the message names that
// plainly and the timeline re-reads to settle the card on its true state.
export function decideErrorMessage(err: unknown): string {
  const code = (err as { code?: string } | null)?.code;
  switch (code) {
    case "plan_already_decided":
      return "This plan was already decided. The latest state is shown above.";
    case "plan_not_found":
      return "This plan is no longer available.";
    case "mode_forbidden":
      return "This conversation is in ask mode, so plans can't be approved here.";
    case "conversation_archived":
      return "This conversation is archived, so it can't be decided.";
    case "conversation_not_found":
      return "This conversation is no longer available.";
    case "invalid_decision":
      return "That decision wasn't accepted. Please try again.";
    default:
      return "Couldn't record the decision. Please try again.";
  }
}
