// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Operator plan surfaces: the execution-plan artifact, its per-step badges, the security review, and the collapsed history row.

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
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
import { Badge, Button, useCopyToClipboard, useToast } from "@/components/ui";
import { AlertGlyph, KeyGlyph, PlanGlyph } from "@/components/console/OperatorGlyphs";
import { SecretCredentialDialog } from "@/components/console/SecretCredentialDialog";
import { cx } from "@/lib/cx";
import {
  useDecideOperatorPlan,
  useExecuteOperatorPlan,
  useOperatorCapabilities,
  useOperatorPlanSecrets,
  useProvidePlanSecrets,
} from "@/platform/api/hooks";
import { planCitations } from "@/platform/operator/citations";
import { applyingLine } from "@/platform/operator/status";
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
// only a create, an in-place change, a delete, a no-op on an already-satisfied step, or a blocked
// step surface, with color reserved for the kind of state change at hand.
function StepEffectBadge({ effect }: { effect?: StepEffect }) {
  if (!effect || effect === "read_only") return null;
  const label =
    effect === "create"
      ? "creates"
      : effect === "update"
        ? "updates"
        : effect === "delete"
          ? "deletes"
          : effect === "exists"
            ? "no change"
            : "blocked";
  const tone =
    effect === "create"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      : effect === "update"
        ? "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400"
        : effect === "delete"
          ? "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400"
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

// The identifying value a step acts on, pulled from its parameters so a change reads as
// "Register an application · GitMesh Lab" rather than naming only the capability. Human name-like
// fields win over ids, and a raw id is used only when nothing friendlier is present.
function primaryArg(args: Record<string, unknown>): string | null {
  const order = [
    "name",
    "title",
    "label",
    "resource_id",
    "application_id",
    "provider_id",
    "policy_id",
    "grant_id",
    "zone_id",
    "id",
  ];
  for (const key of order) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
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

// One-time client secret returned by an apply. Registering or rotating an application issues a
// secret that the control plane delivers only in the execute HTTP response and never writes to the
// ledger, so it is surfaced here for the operator to store. The value lives only in this component's
// in-memory mutation result - it is not persisted and is gone on reload, exactly as a one-time
// secret must be.
function issuedSecrets(
  outputs: Record<string, Record<string, unknown>> | undefined,
): { key: string; app: string | null; secret: string }[] {
  if (!outputs) return [];
  const issued: { key: string; app: string | null; secret: string }[] = [];
  for (const [stepId, output] of Object.entries(outputs)) {
    const secret = output.client_secret;
    if (typeof secret !== "string" || secret.length === 0) continue;
    const app = typeof output.application_id === "string" ? output.application_id : null;
    issued.push({ key: stepId, app, secret });
  }
  return issued;
}

// A single issued secret: masked by default with a reveal toggle and a copy control, so the operator
// can store it without it lingering on screen. The secret is only ever the in-memory value passed in.
function SecretRow({ app, secret }: { app: string | null; secret: string }) {
  const copy = useCopyToClipboard();
  const toast = useToast();
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      {app ? <span className="font-mono text-[11px] text-muted-foreground">{app}</span> : null}
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs">
          {revealed ? secret : "•".repeat(28)}
        </code>
        <Button size="sm" variant="secondary" onClick={() => setRevealed((value) => !value)}>
          {revealed ? "Hide" : "Reveal"}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            void copy(secret, {
              onSuccess: () => toast({ tone: "success", title: "Client secret copied" }),
            })
          }
        >
          Copy
        </Button>
      </div>
    </div>
  );
}

// The one-time credentials an apply issued, surfaced inside the plan card so a secret created through
// the chat is not lost. It states plainly that the secret is shown once and never stored, matching how
// the Console reveals a secret elsewhere, and holds the value only in memory for the operator to copy.
function IssuedCredentials({
  secrets,
}: {
  secrets: { key: string; app: string | null; secret: string }[];
}) {
  return (
    <div className="border-t border-border bg-surface px-3.5 py-2.5">
      <div className="flex items-center gap-2">
        <KeyGlyph className="h-3 w-3 text-muted-foreground" />
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Client secret
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Shown once and never stored - copy and keep it somewhere safe before leaving this chat.
      </p>
      <div className="mt-2 flex flex-col gap-2.5">
        {secrets.map((item) => (
          <SecretRow key={item.key} app={item.app} secret={item.secret} />
        ))}
      </div>
    </div>
  );
}

// The active execution plan rendered as a first-class operational artifact: steps,
// per-step effect, live progress, and the approve / reject controls. Approval is the only gate -
// an approved plan applies automatically, so there is no separate apply step.
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
  const changeCounts = plan.steps.reduce(
    (acc, step) => {
      if (step.effect === "create") acc.create += 1;
      else if (step.effect === "update") acc.update += 1;
      else if (step.effect === "delete") acc.delete += 1;
      return acc;
    },
    { create: 0, update: 0, delete: 0 },
  );
  const changeBits = [
    changeCounts.create > 0 ? `creates ${changeCounts.create}` : null,
    changeCounts.update > 0 ? `updates ${changeCounts.update}` : null,
    changeCounts.delete > 0 ? `deletes ${changeCounts.delete}` : null,
  ].filter((bit): bit is string => bit !== null);
  const stepLabel = `${plan.steps.length} step${plan.steps.length === 1 ? "" : "s"}`;
  const changeLabel =
    mutatingCount === 0
      ? "read-only"
      : changeBits.length > 0
        ? changeBits.join(" · ")
        : `${mutatingCount} change${mutatingCount === 1 ? "" : "s"}`;
  const catalog = useOperatorCapabilities().data ?? [];
  const sources = planCitations(plan, catalog);
  // Resolves a step's dependency ids to their human summaries so an ordering hint reads as
  // "runs after Connect provider" rather than the opaque step id the planner assigned.
  const stepLabels = new Map(plan.steps.map((step) => [step.id, step.summary]));

  // Approve is the only gate: once a plan is approved - by the operator here or by autopilot - it
  // is applied automatically, so there is no separate apply step. The request is armed once per
  // plan seq; the server's execute lock makes a duplicate a no-op, and the ref keeps a re-render or
  // the dev strict double-mount from firing it twice.
  const requestedSeq = useRef<number | null>(null);
  useEffect(() => {
    if (plan.canExecute && requestedSeq.current !== plan.seq) {
      requestedSeq.current = plan.seq;
      execute.mutate(plan.seq);
    }
  }, [plan.canExecute, plan.seq, execute.mutate]);

  // A step that connects a credential-bearing provider collects its values through the secure
  // prompt into the sealed vault. The plan cannot be approved - by the operator or by autopilot -
  // until every such step is satisfied, so the prompt opens itself once when the plan arrives and
  // stays reachable through the buttons below if it is dismissed or the values need changing.
  const credentialSteps = plan.steps.filter((step) => step.secretFields.length > 0);
  const needsCredentials = credentialSteps.length > 0 && plan.canDecide;
  const secretsStatus = useOperatorPlanSecrets(
    zoneId,
    conversationId,
    needsCredentials ? plan.seq : null,
  );
  const provide = useProvidePlanSecrets(zoneId, conversationId);
  const providedSteps = new Set(
    (secretsStatus.data?.steps ?? []).filter((step) => step.provided).map((step) => step.step_id),
  );
  const unsatisfied = credentialSteps.filter((step) => !providedSteps.has(step.id));
  const credentialsReady =
    needsCredentials && secretsStatus.data != null && unsatisfied.length === 0;
  const [promptStepId, setPromptStepId] = useState<string | null>(null);
  const promptedSeq = useRef<number | null>(null);
  const statusLoaded = secretsStatus.data != null;
  const firstUnsatisfiedId = unsatisfied[0]?.id ?? null;
  useEffect(() => {
    if (!needsCredentials || !statusLoaded) return;
    if (promptedSeq.current === plan.seq) return;
    promptedSeq.current = plan.seq;
    if (firstUnsatisfiedId) setPromptStepId(firstUnsatisfiedId);
  }, [needsCredentials, statusLoaded, plan.seq, firstUnsatisfiedId]);
  const promptStep = credentialSteps.find((step) => step.id === promptStepId) ?? null;
  const submitCredentials = (values: Record<string, string>) => {
    if (!promptStep) return;
    provide.mutate(
      { planSeq: plan.seq, stepId: promptStep.id, values },
      {
        onSuccess: (result) => {
          if (result.all_satisfied) {
            setPromptStepId(null);
            return;
          }
          const next = credentialSteps.find(
            (step) => step.id !== promptStep.id && !providedSteps.has(step.id),
          );
          setPromptStepId(next ? next.id : null);
        },
      },
    );
  };

  const secrets = issuedSecrets(execute.data?.outputs);

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className="flex items-start justify-between gap-3 border-b border-border px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid h-5 w-5 flex-shrink-0 place-items-center rounded-md border border-border bg-muted">
            <PlanGlyph className="h-3 w-3 text-foreground" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">{plan.summary}</div>
            <div className="text-[11px] text-muted-foreground">
              {stepLabel} · {changeLabel}
            </div>
          </div>
        </div>
        <Badge tone={decision.tone}>{decision.label}</Badge>
      </div>

      <div className="flex flex-col">
        {plan.steps.map((step) => {
          const dependencyLabels = step.dependsOn.map((id) => stepLabels.get(id) ?? id);
          const name = primaryArg(step.args);
          const title =
            name && !step.summary.includes(name) ? `${step.summary} · ${name}` : step.summary;
          return (
            <Tool key={step.id} className="border-b border-border last:border-b-0">
              <ToolHeader
                type={`tool-${step.capability}`}
                title={title}
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
      {plan.reviewFailure ? (
        <div className="border-t border-border bg-surface px-3.5 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <AlertGlyph className="h-3 w-3 text-muted-foreground" />
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Security review
              </span>
            </div>
            <Badge tone="warning">Not reviewed</Badge>
          </div>
          <p className="mt-1.5 text-xs text-foreground">
            The guardian review did not complete: {plan.reviewFailure}. Evaluate this plan yourself
            before deciding.
          </p>
        </div>
      ) : null}

      {plan.canDecide ? (
        <Confirmation approval={planApproval(plan)} state={planConfirmationState(plan)}>
          <ConfirmationTitle>
            <ConfirmationRequest>
              {mutatingCount > 0
                ? `Approve to apply ${mutatingCount} change${mutatingCount === 1 ? "" : "s"} in this zone - nothing runs until you do.`
                : "Approve to run these read-only steps in this zone."}
            </ConfirmationRequest>
          </ConfirmationTitle>
          {needsCredentials ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
              <KeyGlyph className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">
                {credentialsReady
                  ? "Provider credentials are sealed in the vault and will apply when this plan runs."
                  : "This plan connects a provider that needs credentials. They are collected in a secure prompt, never in the chat."}
              </span>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || provide.isPending}
                onClick={() => setPromptStepId((unsatisfied[0] ?? credentialSteps[0]).id)}
              >
                {credentialsReady ? "Change credentials" : "Provide credentials"}
              </Button>
            </div>
          ) : null}
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
              disabled={busy || (needsCredentials && !credentialsReady)}
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

      {promptStep ? (
        <SecretCredentialDialog
          open
          providerName={primaryArg(promptStep.args) ?? promptStep.summary}
          kind={typeof promptStep.args.kind === "string" ? promptStep.args.kind : ""}
          fields={promptStep.secretFields}
          pending={provide.isPending}
          error={
            provide.isError
              ? "The credentials could not be saved. Check the values and try again."
              : null
          }
          onSubmit={submitCredentials}
          onClose={() => setPromptStepId(null)}
        />
      ) : null}

      <PlanOutcome
        plan={plan}
        applying={execute.isPending && !plan.executed}
        execError={execute.isError ? executeErrorMessage(execute.error) : null}
        onRetry={() => execute.mutate(plan.seq)}
        retryDisabled={busy}
      />

      {secrets.length > 0 ? <IssuedCredentials secrets={secrets} /> : null}

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

// The single, honest outcome line beneath a decided plan. Exactly one truth shows at a time and it
// always reflects the settled ledger, never a hopeful placeholder: a refused apply request is an
// error with a retry, a completed run with a failed step names that failure plainly (the plan is
// spent, so there is no retry), a rejection names its reason, and an apply that is genuinely still
// in flight - approved but not yet executed - shows the working line. Once the plan is executed the
// working line is never shown, so a finished or failed run can never masquerade as still working.
function PlanOutcome({
  plan,
  applying,
  execError,
  onRetry,
  retryDisabled,
}: {
  plan: PlanItem;
  applying: boolean;
  execError: string | null;
  onRetry: () => void;
  retryDisabled: boolean;
}) {
  const failedStep = plan.steps.find((step) => step.status === "failed");

  let content: ReactNode = null;
  if (plan.executed && failedStep) {
    // A recorded step failure is the authoritative, audited outcome: name that specific failure -
    // the same detail the audit and the error notice carry - rather than the generic apply error.
    // The plan is spent, so it offers no retry.
    content = (
      <span className="text-[11px] text-destructive">
        {failedStep.detail?.trim() ? failedStep.detail : `${failedStep.summary} failed.`}
      </span>
    );
  } else if (execError) {
    content = (
      <>
        <span className="text-[11px] text-destructive">{execError}</span>
        <Button size="sm" variant="secondary" onClick={onRetry} disabled={retryDisabled}>
          Try again
        </Button>
      </>
    );
  } else if (plan.decision === "rejected" && plan.rejectionReason?.trim()) {
    content = <span className="text-[11px] text-muted-foreground">{plan.rejectionReason}</span>;
  } else if (applying) {
    content = (
      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-purple" />
        {applyingLine(plan.seq)}
      </span>
    );
  }

  if (!content) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border bg-surface px-3.5 py-2.5">
      {content}
    </div>
  );
}

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
