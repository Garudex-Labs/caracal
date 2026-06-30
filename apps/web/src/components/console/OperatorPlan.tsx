// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Operator plan surfaces: the execution-plan artifact, its per-step badges, the security review, the collapsed history row, and the pinned decision dock.

import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import {
  InlineCitation,
  InlineCitationCard,
  InlineCitationCardBody,
  InlineCitationCardTrigger,
  InlineCitationCarousel,
  InlineCitationCarouselContent,
  InlineCitationCarouselHeader,
  InlineCitationCarouselIndex,
  InlineCitationCarouselItem,
  InlineCitationCarouselNext,
  InlineCitationCarouselPrev,
  InlineCitationSource,
  InlineCitationText,
} from "@/components/ai-elements/inline-citation";
import {
  Task,
  TaskContent,
  TaskItem,
  TaskItemFile,
  TaskTrigger,
} from "@/components/ai-elements/task";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { Badge, Button } from "@/components/ui";
import { AlertGlyph, PlanGlyph } from "@/components/console/OperatorGlyphs";
import { cx } from "@/lib/cx";
import {
  useDecideOperatorPlan,
  useExecuteOperatorPlan,
  useOperatorCapabilities,
} from "@/platform/api/hooks";
import { planCitations } from "@/platform/operator/citations";
import { applyingLine, PLAN_STATUS } from "@/platform/operator/status";
import type {
  PlanAdvisoryView,
  PlanItem,
  StepEffect,
  StepRisk,
} from "@/platform/operator/timeline";
import {
  advisoryTone,
  alignmentVerdict,
  decideErrorMessage,
  executeErrorMessage,
  planApproval,
  planConfirmationState,
  planDecision,
  stepToolState,
} from "@/platform/operator/view";

// A compact per-step risk signal shown in the step header. Low risk is the common case and is left
// unmarked so the signal stays an exception the eye can find; only the planner's medium and high
// tags surface, colored by consequence.
function StepRiskBadge({ risk }: { risk?: StepRisk }) {
  if (!risk || risk === "low") return null;
  const tone =
    risk === "high"
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400";
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        tone,
      )}
    >
      {risk} risk
    </span>
  );
}

// A compact per-step effect signal: what this step was previewed to do against live state. The
// unremarkable read-only case is left unmarked so the badge stays a consequence the eye can find;
// only a create, an in-place change, a no-op on an already-satisfied step, or a blocked step
// surface, with color reserved for the kind of state change at hand.
function StepEffectBadge({ effect }: { effect?: StepEffect }) {
  if (!effect || effect === "read_only") return null;
  const label =
    effect === "create"
      ? "creates"
      : effect === "update"
        ? "updates"
        : effect === "exists"
          ? "no change"
          : "blocked";
  const tone =
    effect === "create"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      : effect === "update"
        ? "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400"
        : effect === "blocked"
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-border bg-muted text-muted-foreground";
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        tone,
      )}
    >
      {label}
    </span>
  );
}

// The advisory security review surfaced above the approval controls, so the reviewer weighs intent
// alignment, over-grant, and blast-radius before approving. It never gates the decision - the
// approve and reject controls are unchanged whether or not findings are present. When the guardian
// judged the plan risky or misaligned it also names the Caracal-correct approach, surfaced as the
// recommendation so the review teaches the right path rather than only flagging the wrong one.
function PlanAdvisory({ advisory }: { advisory: PlanAdvisoryView }) {
  const verdict = advisory.alignment ? alignmentVerdict(advisory.alignment) : null;
  return (
    <div className="border-t border-border bg-surface px-3.5 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <AlertGlyph className="h-3 w-3 text-muted-foreground" />
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Security review
          </span>
        </div>
        {verdict ? <Badge tone={verdict.tone}>{verdict.label}</Badge> : null}
      </div>
      <p className="mt-1.5 text-xs text-foreground">{advisory.summary}</p>
      {advisory.findings.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1.5">
          {advisory.findings.map((finding, index) => (
            <li key={index} className="flex items-start gap-2">
              <Badge tone={advisoryTone(finding.severity)}>{finding.severity}</Badge>
              <span className="text-xs text-muted-foreground">{finding.concern}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {advisory.recommendation ? (
        <div className="mt-2.5 border-l-2 border-border pl-2.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Recommended approach
          </span>
          <p className="mt-0.5 text-xs text-foreground">{advisory.recommendation}</p>
        </div>
      ) : null}
    </div>
  );
}

// The active execution plan rendered as a first-class operational artifact: steps,
// per-step effect, live progress, and the approve / reject / apply controls.
export function PlanArtifact({
  plan,
  zoneId,
  conversationId,
}: {
  plan: PlanItem;
  zoneId: string | null;
  conversationId: string;
}) {
  const decide = useDecideOperatorPlan(zoneId, conversationId);
  const execute = useExecuteOperatorPlan(zoneId, conversationId);
  const busy = decide.isPending || execute.isPending;
  const decision = planDecision(plan);
  const mutatingCount = plan.steps.filter((step) => step.mutating).length;
  const catalog = useOperatorCapabilities().data ?? [];
  const sources = planCitations(plan, catalog);
  // Resolves a step's dependency ids to their human summaries so an ordering hint reads as
  // "runs after Connect provider" rather than the opaque step id the planner assigned.
  const stepLabels = new Map(plan.steps.map((step) => [step.id, step.summary]));

  return (
    <div className="border border-border bg-card shadow-sm">
      <div className="flex items-start justify-between gap-3 border-b border-border px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid h-5 w-5 flex-shrink-0 place-items-center border border-border bg-muted">
            <PlanGlyph className="h-3 w-3 text-foreground" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">{plan.summary}</div>
            <div className="text-[11px] text-muted-foreground">
              {plan.steps.length} step{plan.steps.length === 1 ? "" : "s"}
              {mutatingCount > 0 ? ` · ${mutatingCount} change state` : " · read-only"}
            </div>
          </div>
        </div>
        <Badge tone={decision.tone}>{decision.label}</Badge>
      </div>

      <div className="flex flex-col">
        {plan.steps.map((step) => {
          const dependencyLabels = step.dependsOn.map((id) => stepLabels.get(id) ?? id);
          return (
            <Tool key={step.id} className="border-b border-border last:border-b-0">
              <ToolHeader
                type={`tool-${step.capability}`}
                title={step.summary}
                state={stepToolState(step, plan)}
                accessory={
                  <span className="flex shrink-0 items-center gap-1.5">
                    <StepEffectBadge effect={step.effect} />
                    <StepRiskBadge risk={step.risk} />
                  </span>
                }
              />
              <ToolContent>
                {dependencyLabels.length > 0 ? (
                  <p className="text-[11px] text-muted-foreground">
                    Runs after {dependencyLabels.join(", ")}
                  </p>
                ) : null}
                <ToolInput input={step.args} />
                {step.detail ? (
                  <ToolOutput
                    output={step.status === "failed" ? undefined : step.detail}
                    errorText={step.status === "failed" ? step.detail : undefined}
                  />
                ) : null}
              </ToolContent>
            </Tool>
          );
        })}
      </div>

      {plan.advisory ? <PlanAdvisory advisory={plan.advisory} /> : null}

      {plan.canDecide || plan.decision !== "pending" ? (
        <Confirmation approval={planApproval(plan)} state={planConfirmationState(plan)}>
          <ConfirmationTitle>
            <ConfirmationRequest>
              {mutatingCount > 0
                ? `Approve to apply ${mutatingCount} change${mutatingCount === 1 ? "" : "s"} in this zone - nothing runs until you do.`
                : "Approve to run these read-only steps in this zone."}
            </ConfirmationRequest>
            <ConfirmationAccepted>
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              <span>
                {plan.executed
                  ? PLAN_STATUS.applied
                  : plan.approvedByAutopilot
                    ? PLAN_STATUS.approvedByAutopilot
                    : PLAN_STATUS.approved}
              </span>
            </ConfirmationAccepted>
            <ConfirmationRejected>
              <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
              <span>
                {plan.rejectionReason
                  ? `${PLAN_STATUS.rejected}: ${plan.rejectionReason}`
                  : PLAN_STATUS.rejected}
              </span>
            </ConfirmationRejected>
          </ConfirmationTitle>
          <ConfirmationActions>
            <ConfirmationAction
              variant="outline"
              disabled={busy}
              onClick={() => decide.mutate({ plan_seq: plan.seq, decision: "rejected" })}
            >
              Reject
            </ConfirmationAction>
            <ConfirmationAction
              variant="default"
              disabled={busy}
              onClick={() => decide.mutate({ plan_seq: plan.seq, decision: "approved" })}
            >
              Approve
            </ConfirmationAction>
          </ConfirmationActions>
          {decide.isError ? (
            <p className="mt-2 text-[11px] text-destructive" role="alert">
              {decideErrorMessage(decide.error)}
            </p>
          ) : null}
        </Confirmation>
      ) : null}

      {plan.canExecute ? (
        <div className="flex flex-col gap-1.5 border-t border-border bg-surface px-3.5 py-2.5">
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => execute.mutate(plan.seq)} disabled={busy}>
              Apply changes
            </Button>
            {busy ? (
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-purple" />{" "}
                {applyingLine(plan.seq)}
              </span>
            ) : null}
          </div>
          {execute.isError ? (
            <span className="text-[11px] text-destructive">
              {executeErrorMessage(execute.error)}
            </span>
          ) : null}
        </div>
      ) : null}

      {sources.length > 0 ? (
        <div className="border-t border-border px-3.5 py-2.5 text-[11px] text-muted-foreground">
          <InlineCitation>
            <InlineCitationText>
              This plan touches {sources.length} Console item{sources.length === 1 ? "" : "s"}.
            </InlineCitationText>
            <InlineCitationCard>
              <InlineCitationCardTrigger sources={sources.map((source) => source.title)} />
              <InlineCitationCardBody>
                <InlineCitationCarousel>
                  <InlineCitationCarouselHeader>
                    <InlineCitationCarouselPrev />
                    <InlineCitationCarouselNext />
                    <InlineCitationCarouselIndex />
                  </InlineCitationCarouselHeader>
                  <InlineCitationCarouselContent>
                    {sources.map((source) => (
                      <InlineCitationCarouselItem key={source.key}>
                        <InlineCitationSource source={source} />
                      </InlineCitationCarouselItem>
                    ))}
                  </InlineCitationCarouselContent>
                </InlineCitationCarousel>
              </InlineCitationCardBody>
            </InlineCitationCard>
          </InlineCitation>
        </div>
      ) : null}
    </div>
  );
}

// Earlier, already-decided plans collapse to a single outcome row so the stream
// reads as an execution history. Expanding the row reveals the executed steps and
// their per-step capability and outcome straight from the turn ledger.
export function PlanHistoryRow({ plan }: { plan: PlanItem }) {
  const decision = planDecision(plan);
  return (
    <Task defaultOpen={false} className="border border-border bg-card/60">
      <div className="flex items-center gap-2.5 px-3 py-2">
        <TaskTrigger title={plan.summary} className="min-w-0 flex-1 text-xs" />
        <div className="flex shrink-0 items-center gap-1">
          {plan.steps.map((step) => (
            <StepStatusDot key={step.id} status={step.status} />
          ))}
        </div>
        <Badge tone={decision.tone}>{decision.label}</Badge>
      </div>
      <TaskContent className="mt-0 px-3 pb-2.5">
        {plan.steps.map((step) => (
          <TaskItem key={step.id} className="flex items-start gap-2">
            <StepStatusDot status={step.status} />
            <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="text-foreground">{step.summary}</span>
              <TaskItemFile>
                <span className="font-mono">{step.capability}</span>
              </TaskItemFile>
              {step.detail ? (
                <span className="text-[11px] text-muted-foreground">{step.detail}</span>
              ) : null}
            </span>
          </TaskItem>
        ))}
      </TaskContent>
    </Task>
  );
}

function StepStatusDot({ status }: { status: "pending" | "succeeded" | "failed" }) {
  const tone =
    status === "succeeded"
      ? "bg-emerald-500"
      : status === "failed"
        ? "bg-destructive"
        : "bg-muted-foreground/40";
  return (
    <span className={cx("mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full", tone)} title={status} />
  );
}

export function PlanDecisionDock({
  plan,
  zoneId,
  conversationId,
}: {
  plan: PlanItem | null;
  zoneId: string | null;
  conversationId: string;
}) {
  const decide = useDecideOperatorPlan(zoneId, conversationId);
  const execute = useExecuteOperatorPlan(zoneId, conversationId);
  const busy = decide.isPending || execute.isPending;

  if (!plan) return null;
  const awaitingDecision = plan.canDecide && plan.decision === "pending";
  const awaitingExecute = plan.canExecute;
  if (!awaitingDecision && !awaitingExecute) return null;

  const mutatingCount = plan.steps.filter((step) => step.mutating).length;
  const status = awaitingDecision
    ? mutatingCount > 0
      ? `${PLAN_STATUS.awaitingApproval} · ${mutatingCount} change${mutatingCount === 1 ? "" : "s"}`
      : `${PLAN_STATUS.awaitingApproval} · read-only`
    : `${PLAN_STATUS.approved} · ready to apply`;

  return (
    <div className="flex flex-shrink-0 flex-col gap-2 border-t border-border bg-card px-4 py-2.5">
      <div className="flex items-center gap-2.5">
        <span className="grid h-5 w-5 flex-shrink-0 place-items-center border border-border bg-muted">
          <PlanGlyph className="h-3 w-3 text-foreground" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-foreground">{plan.summary}</div>
          <div className="text-[11px] text-muted-foreground">{status}</div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1.5">
          {awaitingDecision ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => decide.mutate({ plan_seq: plan.seq, decision: "rejected" })}
              >
                Reject
              </Button>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => decide.mutate({ plan_seq: plan.seq, decision: "approved" })}
              >
                Approve
              </Button>
            </>
          ) : (
            <Button size="sm" mutating disabled={busy} onClick={() => execute.mutate(plan.seq)}>
              Apply changes
            </Button>
          )}
        </div>
      </div>
      {decide.isError ? (
        <p className="text-[11px] text-destructive" role="alert">
          {decideErrorMessage(decide.error)}
        </p>
      ) : null}
      {execute.isError ? (
        <p className="text-[11px] text-destructive" role="alert">
          {executeErrorMessage(execute.error)}
        </p>
      ) : null}
    </div>
  );
}
