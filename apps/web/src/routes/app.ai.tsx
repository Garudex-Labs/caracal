/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Caracal Operator route, the Community Edition workspace for operating the control plane in natural language.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";

import { ModulePage } from "@/components/console/ModulePage";
import { Badge, Button } from "@/components/ui";
import { cx } from "@/lib/cx";
import {
  useActiveZone,
  useCreateOperatorConversation,
  useDecideOperatorPlan,
  useExecuteOperatorPlan,
  useOperatorAiStatus,
  useOperatorCapabilities,
  useOperatorContext,
  useOperatorConversations,
  useOperatorStatus,
  useOperatorTurns,
  useSendOperatorMessage,
} from "@/platform/api/hooks";
import { buildTimeline, type PlanItem, type TimelineItem } from "@/platform/operator/timeline";
import type {
  OperatorCapability,
  OperatorCapabilityDomain,
  OperatorConversation,
} from "@/platform/api/types";

export const Route = createFileRoute("/app/ai")({
  component: CaracalOperatorPage,
});

const EXAMPLE_INTENTS = [
  "Connect GitHub",
  "Give the finance agent read-only access",
  "Create a provider for our internal API",
  "Why was that request denied?",
];

function CaracalOperatorPage() {
  const { data: enabled, isLoading } = useOperatorStatus();

  return (
    <ModulePage
      title="Caracal Operator"
      description="Operate your entire Caracal control plane in natural language. Describe what you want; the Operator resolves it into concrete changes, shows the plan, previews the effect against live state, and applies it through the same guarded APIs you use by hand — within your operator scope and recorded in the audit log."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Caracal Operator" }]}
      actions={<Badge tone="neutral">Community Edition</Badge>}
    >
      {isLoading ? <LoadingState /> : enabled === true ? <OperatorWorkspace /> : <DisabledState />}
    </ModulePage>
  );
}

/* -------------------------------- shell -------------------------------- */

// Full-height, full-width surface every Operator state spans edge to edge, so the
// panes read as one workspace rather than sitting inside a nested card. The negative
// margins cancel the Console main padding so the workspace is full-bleed on every side.
const SHELL = "h-[calc(100dvh-8.5rem)] min-h-[34rem] border-y border-border -mx-5 -mb-6 md:-mx-8";
const SHELL_COLUMNS =
  "grid overflow-hidden lg:grid-cols-[15rem_minmax(0,1fr)] xl:grid-cols-[15rem_minmax(0,1fr)_21rem]";

/* ------------------------------ workspace ------------------------------ */

function OperatorWorkspace() {
  const { activeZone } = useActiveZone();
  const zoneId = activeZone?.id ?? null;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const conversations = useOperatorConversations(zoneId, search);
  const create = useCreateOperatorConversation(zoneId);

  function startSession(title: string) {
    const name = title.trim();
    if (!name || create.isPending) return;
    create.mutate(name, { onSuccess: (conversation) => setSelectedId(conversation.id) });
  }

  if (!activeZone) {
    return <NoZoneState />;
  }

  return (
    <div className={cx(SHELL, SHELL_COLUMNS)}>
      <SessionsRail
        conversations={conversations.data ?? []}
        loading={conversations.isLoading}
        search={search}
        onSearch={setSearch}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onCreate={startSession}
        creating={create.isPending}
      />
      <section className="flex min-h-0 min-w-0 flex-col bg-background">
        <SessionStrip
          conversations={conversations.data ?? []}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onCreate={() => startSession("New session")}
          creating={create.isPending}
        />
        {selectedId ? (
          <ActivityStream key={selectedId} zoneId={zoneId} conversationId={selectedId} />
        ) : (
          <SessionEmptyState onExample={startSession} creating={create.isPending} />
        )}
      </section>
      <FocusRail zoneId={zoneId} conversationId={selectedId} />
    </div>
  );
}

/* ------------------------------- sessions ------------------------------ */

function SessionsRail({
  conversations,
  loading,
  search,
  onSearch,
  selectedId,
  onSelect,
  onCreate,
  creating,
}: {
  conversations: OperatorConversation[];
  loading: boolean;
  search: string;
  onSearch: (value: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: (title: string) => void;
  creating: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  function commit() {
    if (draft === null) return;
    const name = draft.trim();
    if (name) onCreate(name);
    setDraft(null);
  }

  return (
    <div className="hidden min-h-0 flex-col border-r border-border bg-card lg:flex">
      <div className="flex flex-shrink-0 items-center justify-between gap-2 px-3 py-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Sessions
        </span>
        <button
          onClick={() => setDraft("")}
          disabled={creating}
          className="inline-flex items-center gap-1 text-xs font-medium text-foreground transition-colors hover:text-foreground/80 disabled:opacity-50"
        >
          <PlusGlyph className="h-3.5 w-3.5" /> New
        </button>
      </div>

      <div className="flex-shrink-0 px-3 pb-2">
        <input
          type="search"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Search"
          aria-label="Search operator sessions"
          className="h-8 w-full border border-input bg-background px-2.5 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        />
      </div>

      {draft !== null ? (
        <div className="flex-shrink-0 px-3 pb-2">
          <input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit();
              if (event.key === "Escape") setDraft(null);
            }}
            onBlur={commit}
            placeholder="Name this session"
            aria-label="New session name"
            className="h-8 w-full border border-input bg-background px-2.5 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          />
        </div>
      ) : null}

      <div className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
        {loading ? (
          <SessionSkeleton />
        ) : conversations.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            {search.trim() ? "No sessions match." : "No sessions yet."}
          </p>
        ) : (
          conversations.map((conversation) => {
            const selected = conversation.id === selectedId;
            return (
              <button
                key={conversation.id}
                onClick={() => onSelect(conversation.id)}
                aria-pressed={selected}
                className={cx(
                  "flex flex-col items-start gap-0.5 border-l-2 px-2.5 py-2 text-left transition-colors",
                  selected
                    ? "border-foreground bg-accent"
                    : "border-transparent hover:bg-accent/50",
                )}
              >
                <span
                  className={cx(
                    "w-full truncate text-xs font-medium",
                    selected ? "text-foreground" : "text-foreground/90",
                  )}
                >
                  {conversation.title}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {formatRelative(conversation.last_activity_at)}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

// Horizontal session switcher shown only below the sessions rail breakpoint.
function SessionStrip({
  conversations,
  selectedId,
  onSelect,
  onCreate,
  creating,
}: {
  conversations: OperatorConversation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  creating: boolean;
}) {
  return (
    <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-border bg-card px-2 py-1.5 lg:hidden">
      <button
        onClick={onCreate}
        disabled={creating}
        className="inline-flex flex-shrink-0 items-center gap-1 border border-border bg-background px-2 py-1 text-xs font-medium text-foreground disabled:opacity-50"
      >
        <PlusGlyph className="h-3.5 w-3.5" /> New
      </button>
      <div className="scrollbar-thin flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {conversations.map((conversation) => {
          const selected = conversation.id === selectedId;
          return (
            <button
              key={conversation.id}
              onClick={() => onSelect(conversation.id)}
              aria-pressed={selected}
              className={cx(
                "max-w-[10rem] flex-shrink-0 truncate border px-2 py-1 text-xs",
                selected
                  ? "border-foreground bg-accent text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {conversation.title}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* --------------------------- activity stream --------------------------- */

function ActivityStream({
  zoneId,
  conversationId,
}: {
  zoneId: string | null;
  conversationId: string;
}) {
  const { data: turns, isLoading } = useOperatorTurns(zoneId, conversationId);
  const send = useSendOperatorMessage(zoneId, conversationId);
  const [message, setMessage] = useState("");

  const { items, latestPlan } = useMemo(() => buildTimeline(turns ?? []), [turns]);

  function submit(text: string) {
    const value = text.trim();
    if (!value || send.isPending) return;
    send.mutate(value, { onSuccess: () => setMessage("") });
  }

  const empty = !isLoading && items.length === 0;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <MemoryStrip zoneId={zoneId} conversationId={conversationId} />

      <div className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-4">
        {isLoading ? (
          <StreamSkeleton />
        ) : empty ? (
          <ComposerEmptyHint onPick={(text) => setMessage(text)} />
        ) : (
          items.map((item) => (
            <StreamEntry
              key={item.id}
              item={item}
              zoneId={zoneId}
              conversationId={conversationId}
              actionable={latestPlan?.id === item.id}
            />
          ))
        )}

        {send.isPending ? (
          <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-purple" />
            The Operator is working…
          </div>
        ) : null}
        {send.isError ? (
          <div className="border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            That request could not be processed. Confirm an AI provider is reachable and try again.
          </div>
        ) : null}
      </div>

      <div className="flex-shrink-0 border-t border-border bg-card px-3 py-3">
        <div className="flex items-end gap-2">
          <input
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit(message);
            }}
            placeholder="Describe what you want, or ask a question"
            aria-label="Message the Operator"
            className="h-9 min-w-0 flex-1 border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          />
          <Button
            size="md"
            onClick={() => submit(message)}
            disabled={send.isPending || message.trim().length === 0}
          >
            Send
          </Button>
        </div>
        <p className="mt-1.5 px-0.5 text-[10px] text-muted-foreground">
          The Operator proposes a plan and previews its effect — nothing changes until you approve.
        </p>
      </div>
    </div>
  );
}

function ComposerEmptyHint({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="m-auto flex max-w-md flex-col items-center gap-4 px-4 py-8 text-center">
      <span className="grid h-11 w-11 place-items-center border border-border bg-muted text-foreground">
        <OperatorGlyph className="h-5 w-5" />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-foreground">Tell the Operator what you want</p>
        <p className="text-sm text-muted-foreground">
          It resolves your intent into a reviewable plan, previews the effect against live state,
          and applies it only after you approve.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-1.5">
        {EXAMPLE_INTENTS.map((intent) => (
          <button
            key={intent}
            onClick={() => onPick(intent)}
            className="border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
          >
            {intent}
          </button>
        ))}
      </div>
    </div>
  );
}

// Compact memory recap shown inside the stream when the focus rail is hidden, so
// long-session continuity (applied changes, rejected operations) is never lost.
function MemoryStrip({
  zoneId,
  conversationId,
}: {
  zoneId: string | null;
  conversationId: string;
}) {
  const { data } = useOperatorContext(zoneId, conversationId);
  const facts = data?.facts;
  if (!facts || (facts.applied_change_count === 0 && facts.rejected_capabilities.length === 0)) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-muted/30 px-4 py-2 text-[11px] text-muted-foreground xl:hidden">
      {facts.applied_change_count > 0 ? (
        <span>
          <span className="font-medium text-foreground">{facts.applied_change_count}</span> change
          {facts.applied_change_count === 1 ? "" : "s"} applied
        </span>
      ) : null}
      {facts.rejected_capabilities.length > 0 ? (
        <span>
          Avoiding{" "}
          <span className="font-mono text-foreground">
            {facts.rejected_capabilities.join(", ")}
          </span>
        </span>
      ) : null}
    </div>
  );
}

function StreamEntry({
  item,
  zoneId,
  conversationId,
  actionable,
}: {
  item: TimelineItem;
  zoneId: string | null;
  conversationId: string;
  actionable: boolean;
}) {
  if (item.kind === "plan") {
    return actionable ? (
      <PlanArtifact plan={item} zoneId={zoneId} conversationId={conversationId} />
    ) : (
      <PlanHistoryRow plan={item} />
    );
  }

  if (item.kind === "error") {
    return (
      <div className="border-l-2 border-destructive bg-destructive/5 px-3 py-2 text-sm text-destructive">
        {item.message}
      </div>
    );
  }

  if (item.role === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[82%] whitespace-pre-wrap border border-border bg-muted px-3 py-2 text-sm text-foreground">
          {item.text}
        </p>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 grid h-6 w-6 flex-shrink-0 place-items-center border border-border bg-muted text-foreground">
        <OperatorGlyph className="h-3.5 w-3.5" />
      </span>
      <p className="min-w-0 max-w-[82%] whitespace-pre-wrap text-sm text-foreground">{item.text}</p>
    </div>
  );
}

/* -------------------------------- plans -------------------------------- */

function planDecision(plan: PlanItem): { tone: BadgeTone; label: string } {
  if (plan.decision === "approved") {
    return plan.executed
      ? { tone: "success", label: "Applied" }
      : { tone: "success", label: "Approved" };
  }
  if (plan.decision === "rejected") return { tone: "danger", label: "Rejected" };
  return { tone: "warning", label: "Awaiting approval" };
}

// The active execution plan rendered as a first-class operational artifact: steps,
// per-step effect, live progress, and the approve / reject / apply controls.
function PlanArtifact({
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

      <ol className="flex flex-col">
        {plan.steps.map((step, index) => (
          <li
            key={step.id}
            className="flex items-start gap-2.5 border-b border-border px-3.5 py-2.5 last:border-b-0"
          >
            <StepStatusDot status={step.status} />
            <span className="grid h-4 w-4 flex-shrink-0 place-items-center border border-border font-mono text-[10px] text-muted-foreground">
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="min-w-0 truncate text-sm text-foreground">{step.summary}</span>
                {step.mutating ? (
                  <span className="flex-shrink-0 text-[10px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
                    changes
                  </span>
                ) : (
                  <span className="flex-shrink-0 text-[10px] font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                    read-only
                  </span>
                )}
              </div>
              <div className="truncate font-mono text-[11px] text-muted-foreground">
                {step.capability}
              </div>
              {step.detail ? (
                <div className="mt-0.5 text-[11px] text-muted-foreground">{step.detail}</div>
              ) : null}
            </div>
          </li>
        ))}
      </ol>

      {plan.rejectionReason ? (
        <p className="border-t border-border px-3.5 py-2 text-[11px] text-muted-foreground">
          Rejected: {plan.rejectionReason}
        </p>
      ) : null}

      {plan.canDecide || plan.canExecute ? (
        <div className="flex items-center gap-2 border-t border-border bg-surface px-3.5 py-2.5">
          {plan.canDecide ? (
            <>
              <Button
                size="sm"
                onClick={() => decide.mutate({ plan_seq: plan.seq, decision: "approved" })}
                disabled={busy}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => decide.mutate({ plan_seq: plan.seq, decision: "rejected" })}
                disabled={busy}
              >
                Reject
              </Button>
            </>
          ) : null}
          {plan.canExecute ? (
            <Button size="sm" onClick={() => execute.mutate(plan.seq)} disabled={busy}>
              Apply changes
            </Button>
          ) : null}
          {busy ? (
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-purple" /> Working…
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// Earlier, already-decided plans collapse to a single outcome row so the stream
// reads as an execution history without re-rendering full plan controls.
function PlanHistoryRow({ plan }: { plan: PlanItem }) {
  const decision = planDecision(plan);
  return (
    <div className="flex items-center gap-2.5 border border-border bg-card/60 px-3 py-2">
      <PlanGlyph className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{plan.summary}</span>
      <div className="flex flex-shrink-0 items-center gap-1">
        {plan.steps.map((step) => (
          <StepStatusDot key={step.id} status={step.status} />
        ))}
      </div>
      <Badge tone={decision.tone}>{decision.label}</Badge>
    </div>
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

/* ------------------------------ focus rail ----------------------------- */

function FocusRail({
  zoneId,
  conversationId,
}: {
  zoneId: string | null;
  conversationId: string | null;
}) {
  return (
    <aside className="scrollbar-thin hidden min-h-0 flex-col gap-px overflow-y-auto border-l border-border bg-border xl:flex">
      <ContextPanel zoneId={zoneId} conversationId={conversationId} />
      <AiPanel />
      <CapabilitiesPanel />
    </aside>
  );
}

function RailSection({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="bg-card">
      <div className="flex items-center justify-between gap-2 px-3.5 py-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {title}
        </span>
        {aside}
      </div>
      <div className="px-3.5 pb-3.5">{children}</div>
    </section>
  );
}

function ContextPanel({
  zoneId,
  conversationId,
}: {
  zoneId: string | null;
  conversationId: string | null;
}) {
  const { data } = useOperatorContext(zoneId, conversationId);

  if (!conversationId) {
    return (
      <RailSection title="Session context">
        <p className="text-xs text-muted-foreground">
          Select a session to see what the Operator has done and is avoiding.
        </p>
      </RailSection>
    );
  }

  const facts = data?.facts;
  const applied = facts?.applied_change_count ?? 0;
  const rejected = facts?.rejected_capabilities ?? [];
  const turns = data?.turn_count ?? 0;

  return (
    <RailSection title="Session context">
      <dl className="flex flex-col gap-2 text-xs">
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">Activity</dt>
          <dd className="font-medium text-foreground">
            {turns} turn{turns === 1 ? "" : "s"}
          </dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">Changes applied</dt>
          <dd className="font-medium text-foreground">{applied}</dd>
        </div>
      </dl>
      {rejected.length > 0 ? (
        <div className="mt-3 border-t border-border pt-2.5">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Avoiding
          </div>
          <div className="flex flex-wrap gap-1">
            {rejected.map((capability) => (
              <span
                key={capability}
                className="border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
              >
                {capability}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {data?.last_error ? (
        <p className="mt-3 border-t border-border pt-2.5 text-[11px] text-destructive">
          Last error: {data.last_error.message}
        </p>
      ) : null}
    </RailSection>
  );
}

function AiPanel() {
  const { data, isLoading, isError } = useOperatorAiStatus(true);
  const ready = data?.enabled === true;

  return (
    <RailSection
      title="AI providers"
      aside={<Badge tone={ready ? "success" : "muted"}>{ready ? "Configured" : "Off"}</Badge>}
    >
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Checking…</p>
      ) : isError ? (
        <p className="text-xs text-muted-foreground">Provider status unavailable.</p>
      ) : !data || data.providers.length === 0 ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          No provider configured, so the Operator uses no AI resources. An administrator connects
          one through <code className="bg-muted px-1 py-0.5 text-[10px]">API_OPERATOR_AI_*</code>.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {data.providers.map((provider) => (
            <li key={provider.id} className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-xs text-foreground">{provider.id}</div>
                <div className="truncate font-mono text-[10px] text-muted-foreground">
                  {provider.model}
                </div>
              </div>
              <span
                className={cx(
                  "h-1.5 w-1.5 flex-shrink-0 rounded-full",
                  provider.available ? "bg-emerald-500" : "bg-amber-500",
                )}
                title={provider.available ? "Ready" : "Incomplete"}
              />
            </li>
          ))}
        </ul>
      )}
    </RailSection>
  );
}

const DOMAIN_LABELS: Record<OperatorCapabilityDomain, string> = {
  zone: "Zones",
  application: "Applications",
  provider: "Providers",
  resource: "Resources",
  grant: "Access",
  policy: "Policy",
  audit: "Understand",
};

const DOMAIN_ORDER: OperatorCapabilityDomain[] = [
  "zone",
  "application",
  "provider",
  "resource",
  "grant",
  "policy",
  "audit",
];

function groupByDomain(
  capabilities: OperatorCapability[],
): { domain: OperatorCapabilityDomain; items: OperatorCapability[] }[] {
  const buckets = new Map<OperatorCapabilityDomain, OperatorCapability[]>();
  for (const capability of capabilities) {
    const list = buckets.get(capability.domain) ?? [];
    list.push(capability);
    buckets.set(capability.domain, list);
  }
  return DOMAIN_ORDER.filter((domain) => buckets.has(domain)).map((domain) => ({
    domain,
    items: (buckets.get(domain) ?? []).sort((a, b) => a.title.localeCompare(b.title)),
  }));
}

function CapabilitiesPanel() {
  const { data, isLoading, isError } = useOperatorCapabilities();

  return (
    <RailSection
      title="Capabilities"
      aside={<span className="text-[10px] text-muted-foreground">live catalog</span>}
    >
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : isError ? (
        <p className="text-xs text-muted-foreground">Catalog unavailable.</p>
      ) : !data || data.length === 0 ? (
        <p className="text-xs text-muted-foreground">No capabilities available.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {groupByDomain(data).map((group) => (
            <div key={group.domain}>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {DOMAIN_LABELS[group.domain]}
              </div>
              <ul className="flex flex-col gap-1">
                {group.items.map((capability) => (
                  <li key={capability.id} className="flex items-center gap-2">
                    <span
                      className={cx(
                        "h-1.5 w-1.5 flex-shrink-0 rounded-full",
                        capability.mutating ? "bg-amber-500" : "bg-emerald-500",
                      )}
                      title={capability.mutating ? "Changes state" : "Read-only"}
                    />
                    <span className="min-w-0 truncate text-xs text-foreground">
                      {capability.title}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div className="flex items-center gap-4 border-t border-border pt-2.5 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Read-only
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> Changes state
            </span>
          </div>
        </div>
      )}
    </RailSection>
  );
}

/* ------------------------------- states -------------------------------- */

function LoadingState() {
  return (
    <div className={cx(SHELL, SHELL_COLUMNS)}>
      <div className="hidden flex-col gap-2 border-r border-border bg-card p-3 lg:flex">
        <SessionSkeleton />
      </div>
      <div className="flex flex-col gap-3 bg-background p-4">
        <span className="skeleton h-8 w-2/3" />
        <span className="skeleton h-20 w-full" />
        <span className="skeleton h-8 w-1/2 self-end" />
      </div>
      <div className="hidden flex-col gap-3 border-l border-border bg-card p-4 xl:flex">
        <span className="skeleton h-4 w-24" />
        <span className="skeleton h-16 w-full" />
        <span className="skeleton h-4 w-20" />
        <span className="skeleton h-16 w-full" />
      </div>
    </div>
  );
}

function SessionSkeleton() {
  return (
    <div className="flex flex-col gap-2 px-1 py-1">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="flex flex-col gap-1">
          <span className="skeleton h-3.5 w-3/4" />
          <span className="skeleton h-2.5 w-1/3" />
        </div>
      ))}
    </div>
  );
}

function StreamSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <span className="skeleton h-9 w-1/2 self-end" />
      <span className="skeleton h-16 w-2/3" />
      <span className="skeleton h-24 w-full" />
    </div>
  );
}

function SessionEmptyState({
  onExample,
  creating,
}: {
  onExample: (title: string) => void;
  creating: boolean;
}) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center px-6 py-8 text-center">
      <div className="flex max-w-md flex-col items-center gap-4">
        <span className="grid h-12 w-12 place-items-center border border-border bg-muted text-foreground">
          <OperatorGlyph className="h-6 w-6" />
        </span>
        <div className="flex flex-col gap-1">
          <p className="text-base font-semibold tracking-tight text-foreground">
            Start operating in plain language
          </p>
          <p className="text-sm text-muted-foreground">
            Open a session and describe what you want. The Operator plans, previews the effect, and
            applies it only after you approve — every change recorded in the audit log.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-1.5">
          {EXAMPLE_INTENTS.map((intent) => (
            <button
              key={intent}
              onClick={() => onExample(intent)}
              disabled={creating}
              className="border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-50"
            >
              {intent}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function NoZoneState() {
  return (
    <div className={cx(SHELL, "grid place-items-center bg-card px-6 text-center")}>
      <div className="flex max-w-sm flex-col items-center gap-3">
        <span className="grid h-11 w-11 place-items-center border border-border bg-muted text-foreground">
          <ZoneGlyph className="h-5 w-5" />
        </span>
        <p className="text-sm font-medium text-foreground">Select a zone to operate</p>
        <p className="text-sm text-muted-foreground">
          Choose a zone from the console header. The Operator works within that zone and never
          reaches beyond it.
        </p>
      </div>
    </div>
  );
}

function DisabledState() {
  const steps = [
    {
      title: "Describe it",
      body: "Tell the Operator what you want in plain language — connect a provider, grant access, or ask why a request was denied.",
    },
    {
      title: "Review the plan",
      body: "It resolves your intent into concrete steps, validates them, and previews the effect against your live state — nothing changes yet.",
    },
    {
      title: "Approve and apply",
      body: "You approve, and it applies the change through the same guarded APIs you use by hand, within your scope and recorded in the audit log.",
    },
  ];

  return (
    <div className={cx(SHELL, "grid place-items-center bg-card px-6 py-10")}>
      <div className="flex w-full max-w-3xl flex-col items-center gap-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="grid h-12 w-12 place-items-center border border-border bg-muted text-foreground">
            <OperatorGlyph className="h-6 w-6" />
          </span>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold tracking-tight text-foreground">
              The Operator is turned off
            </h3>
            <Badge tone="muted">Disabled</Badge>
          </div>
          <p className="max-w-xl text-sm text-muted-foreground">
            Caracal Operator is optional and currently disabled, so it consumes no compute or AI
            resources. An administrator enables it with{" "}
            <code className="bg-muted px-1 py-0.5 text-xs">API_OPERATOR_ENABLED=true</code> on the
            API service. Your workspace, sessions, and the live capability catalog appear here the
            moment it is on.
          </p>
        </div>
        <div className="grid w-full gap-px border border-border bg-border sm:grid-cols-3 [&>*]:bg-card">
          {steps.map((step, index) => (
            <div key={step.title} className="flex flex-col gap-1.5 p-4">
              <span className="grid h-6 w-6 place-items-center border border-border font-mono text-[11px] text-foreground">
                {index + 1}
              </span>
              <div className="text-sm font-medium text-foreground">{step.title}</div>
              <p className="text-xs leading-relaxed text-muted-foreground">{step.body}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- helpers ------------------------------- */

type BadgeTone = "neutral" | "success" | "warning" | "danger" | "muted";

function formatRelative(value: string): string {
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

/* -------------------------------- glyphs ------------------------------- */

function OperatorGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 3l1.7 4.7L18 9l-4.3 1.6L12 15l-1.7-4.4L6 9z" />
      <path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17z" />
    </svg>
  );
}

function PlanGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M9 6h11" />
      <path d="M9 12h11" />
      <path d="M9 18h11" />
      <path d="M4 6h.01M4 12h.01M4 18h.01" />
    </svg>
  );
}

function ZoneGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 2 2 7l10 5 10-5z" />
      <path d="M2 17l10 5 10-5" />
      <path d="M2 12l10 5 10-5" />
    </svg>
  );
}

function PlusGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
