/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Approvals route for deciding human-approval holds.
*/
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import {
  CopyValue,
  DetailField,
  DetailGroup,
  ResourceWorkspace,
} from "@/components/console/ResourceWorkspace";
import { CreatedBy } from "@/components/console/CreatedBy";
import { FeedToolbar } from "@/components/console/FeedToolbar";
import { ZoneScopedPage } from "@/components/console/ZoneScope";
import { Badge, Button, Select, Textarea, useToast, type Column } from "@/components/ui";
import { appLink } from "@/platform/nav/appLink";
import { ConsoleApiError, consoleApi } from "@/platform/api/client";
import {
  useApplications,
  useApprovalCounts,
  useApprovalsFeed,
  useDecideApproval,
} from "@/platform/api/hooks";
import type { ApprovalCounts, StepUpChallenge, StepUpState } from "@/platform/api/types";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/approvals")({
  component: ApprovalsRoute,
});

function ApprovalsRoute() {
  return (
    <ZoneScopedPage
      title="Approvals"
      description="Holds that park an agent's token exchange until someone with authority decides."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Approvals" }]}
    >
      {(zone) => <ApprovalsPage zoneId={zone.id} />}
    </ZoneScopedPage>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ConsoleApiError) {
    if (error.notConfigured) return "Control plane not connected.";
    if (error.unreachable) return "Control plane unreachable.";
    return error.code;
  }
  return "Unexpected error.";
}

function stateTone(state: StepUpState): "warning" | "success" | "danger" | "muted" | "neutral" {
  if (state === "pending") return "warning";
  if (state === "approved") return "success";
  if (state === "consumed") return "neutral";
  if (state === "rejected") return "danger";
  return "muted";
}

const APPROVER_CLASS_LABELS: Record<StepUpChallenge["approver_class"], string> = {
  operator: "Zone operator",
  subject: "End user only",
  any: "Operator or end user",
};

const PRIVACY_MODE_LABELS: Record<StepUpChallenge["privacy_mode"], string> = {
  identified: "Identified — approvers see who is asking",
  pseudonymous: "Pseudonymous — approvers see a stable alias",
  anonymous: "Anonymous — approvers see only what is requested",
};

// A hold is decidable in the console while it is pending and the policy that raised it
// admits operator-plane approval. Subject-only holds are the application's promise that
// only its own end user decides; the console shows them but never offers a verdict.
function isDecidable(challenge: StepUpChallenge): boolean {
  return challenge.state === "pending" && challenge.approver_class !== "subject";
}

function relativeTime(iso: string, now = Date.now()): string {
  const diff = Date.parse(iso) - now;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? "from now" : "ago";
  const mins = Math.floor(abs / 60000);
  if (mins < 1) return diff >= 0 ? "in <1m" : "<1m ago";
  if (mins < 60) return `${mins}m ${suffix}`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${suffix}`;
  const days = Math.floor(hours / 24);
  return `${days}d ${suffix}`;
}

// The instant a hold reached its recorded state, used to order settled holds in the list.
function decidedAt(challenge: StepUpChallenge): string | null {
  return challenge.consumed_at ?? challenge.rejected_at ?? challenge.satisfied_at;
}

// Requested scopes and resources travel in the challenge metadata as authorization facts.
// Anything else in the metadata stays visible through the raw record, not the summary.
function requestedAuthority(challenge: StepUpChallenge): { scopes: string[]; resources: string[] } {
  const meta = challenge.metadata_json;
  const pick = (key: string): string[] => {
    const value = meta?.[key];
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
    return typeof value === "string" && value ? [value] : [];
  };
  return { scopes: pick("requested_scopes"), resources: pick("resources") };
}

// The requesting agent run, when the exchange carried lineage. Lets an approver jump from
// the hold to the exact run asking for authority before deciding.
function agentLineage(challenge: StepUpChallenge): { agentSession?: string; edge?: string } {
  const meta = challenge.metadata_json;
  if (!meta) return {};
  return {
    agentSession: typeof meta.agent_session_id === "string" ? meta.agent_session_id : undefined,
    edge: typeof meta.delegation_edge_id === "string" ? meta.delegation_edge_id : undefined,
  };
}

function ApprovalsPage({ zoneId }: { zoneId: string }) {
  const [state, setState] = useState<string>("all");
  const feed = useApprovalsFeed(zoneId, state === "all" ? {} : { state: state as StepUpState });
  const counts = useApprovalCounts(zoneId);
  const apps = useApplications(zoneId);
  const appNames = useMemo(
    () => new Map((apps.data ?? []).map((app) => [app.id, app.name])),
    [apps.data],
  );
  const appName = (c: StepUpChallenge) =>
    (c.application_id && appNames.get(c.application_id)) || null;
  const rows = useMemo(() => (feed.data?.pages ?? []).flatMap((page) => page.rows), [feed.data]);
  const now = Date.now();

  const columns: Column<StepUpChallenge>[] = [
    {
      id: "principal",
      header: "Requested by",
      sortable: true,
      cell: (c) => {
        const name = appName(c);
        return (
          <div>
            <div
              className={
                name ? "text-xs font-medium text-foreground" : "font-mono text-xs text-foreground"
              }
            >
              {name ?? c.principal_id}
            </div>
            <div className="font-mono text-[10px] text-muted-foreground">
              {c.session_id || c.principal_id}
            </div>
          </div>
        );
      },
    },
    {
      id: "tier",
      header: "Tier",
      cell: (c) => (c.tier ? <Badge tone="neutral">{c.tier}</Badge> : null),
    },
    {
      id: "approver",
      header: "Approver",
      cell: (c) => (
        <span className="text-xs text-muted-foreground">
          {APPROVER_CLASS_LABELS[c.approver_class]}
        </span>
      ),
    },
    {
      id: "state",
      header: "State",
      sortable: true,
      cell: (c) => <Badge tone={stateTone(c.state)}>{c.state}</Badge>,
    },
    {
      id: "expires",
      header: "Window",
      align: "right",
      sortable: true,
      cell: (c) => {
        const settled = decidedAt(c);
        return (
          <span
            className="text-xs text-muted-foreground"
            title={new Date(c.expires_at).toLocaleString()}
          >
            {c.state === "pending"
              ? `expires ${relativeTime(c.expires_at, now)}`
              : settled
                ? relativeTime(settled, now)
                : relativeTime(c.expires_at, now)}
          </span>
        );
      },
    },
  ];

  return (
    <ResourceWorkspace
      title="Approvals"
      description="Holds that park an agent's token exchange until someone with authority decides."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Approvals" }]}
      rows={rows}
      loading={feed.isLoading}
      columns={columns}
      rowKey={(c) => c.id}
      feed={{
        hasMore: Boolean(feed.hasNextPage),
        fetching: feed.isFetchingNextPage,
        loadMore: () => feed.fetchNextPage(),
      }}
      toolbarExtra={
        <ApprovalFilterBar
          state={state}
          loaded={rows.length}
          counts={counts.data}
          onState={setState}
        />
      }
      search={{
        placeholder: "Search loaded holds by application, principal, session, or binding…",
        match: (c, q) =>
          c.id.toLowerCase().includes(q) ||
          (appName(c) ?? "").toLowerCase().includes(q) ||
          c.principal_id.toLowerCase().includes(q) ||
          c.session_id.toLowerCase().includes(q) ||
          c.binding.toLowerCase().includes(q) ||
          (c.application_id ?? "").toLowerCase().includes(q),
      }}
      initialSort={{ column: "state", direction: "asc" }}
      sortValues={{
        principal: (c) => c.principal_id.toLowerCase(),
        // Pending holds sort first because they are the only rows waiting on a human;
        // within each band, newer holds lead.
        state: (c) => (c.state === "pending" ? 0 : 1e15) - Date.parse(c.created_at),
        expires: (c) => Date.parse(c.expires_at),
      }}
      empty={{
        title: feed.isError ? "Could not load approvals" : "No approval holds",
        description: feed.isError
          ? errorMessage(feed.error)
          : "Holds appear here when a policy declares an approval tier and an agent requests matching authority.",
      }}
      detail={{
        title: (c) => appName(c) ?? c.principal_id,
        description: (c) => `Raised ${relativeTime(c.created_at)}`,
        render: (c) => (
          <ApprovalDetail challenge={c} zoneId={zoneId} applicationName={appName(c)} />
        ),
      }}
    />
  );
}

function ApprovalFilterBar({
  state,
  loaded,
  counts,
  onState,
}: {
  state: string;
  loaded: number;
  counts: ApprovalCounts | undefined;
  onState: (v: string) => void;
}) {
  const withCount = (label: string, count: number | undefined) =>
    count === undefined ? label : `${label} (${count})`;
  return (
    <FeedToolbar activeFilters={state !== "all" ? 1 : 0} loaded={loaded} noun="hold">
      <Select label="State" value={state} onChange={(e) => onState(e.target.value)}>
        <option value="all">All states</option>
        <option value="pending">{withCount("Pending", counts?.pending)}</option>
        <option value="approved">{withCount("Approved", counts?.approved)}</option>
        <option value="consumed">{withCount("Consumed", counts?.consumed)}</option>
        <option value="rejected">{withCount("Rejected", counts?.rejected)}</option>
        <option value="expired">{withCount("Expired", counts?.expired)}</option>
      </Select>
      <p className="text-[11px] text-muted-foreground sm:col-span-2">
        Settled holds age out of this list after a day; the zone audit stream keeps the permanent
        record of every decision.
      </p>
    </FeedToolbar>
  );
}

// What the requesting agent says about itself, read live from the coordinator: the
// task its developer annotated at spawn, its role labels, and how recently it started.
// The context a policy cannot evaluate but an approver can. Renders nothing when the
// agent is gone or carries no annotations - absence over empty ritual.
function AgentContext({ zoneId, agentSessionId }: { zoneId: string; agentSessionId: string }) {
  const agent = useQuery({
    queryKey: ["approvalAgent", zoneId, agentSessionId],
    queryFn: () => consoleApi.agents.get(zoneId, agentSessionId),
    staleTime: 30_000,
    retry: false,
  });
  if (!agent.data) return null;
  const task = typeof agent.data.metadata?.task === "string" ? agent.data.metadata.task : null;
  const labels = agent.data.labels ?? [];
  if (!task && labels.length === 0) return null;
  return (
    <p className="mt-1.5 text-xs text-muted-foreground">
      {task ? (
        <>
          Task: <span className="text-foreground">{task}</span>
          {" \u00b7 "}
        </>
      ) : null}
      {labels.length > 0 ? (
        <>
          acting as {labels.join(", ")}
          {" \u00b7 "}
        </>
      ) : null}
      spawned {relativeTime(agent.data.spawned_at)}
    </p>
  );
}

// The recent history of this exact authority (same binding hash, last day - the
// challenge store's retention window). One sentence, strongest signal first: a
// recent rejection is a warning; a pile of identical approvals is policy debt.
function PatternLine({ challenge }: { challenge: StepUpChallenge }) {
  if (challenge.prior_rejected > 0) {
    return (
      <p className="mt-1.5 text-xs font-medium text-destructive">
        An identical hold was rejected in the last day
        {challenge.prior_approved > 0 ? ` (${challenge.prior_approved} approved)` : ""} — check why
        before approving.
      </p>
    );
  }
  if (challenge.prior_approved >= 5) {
    return (
      <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-400">
        Approved {challenge.prior_approved} times in the last day for identical authority. If this
        is routine, encode it as policy instead of approving it by hand.
      </p>
    );
  }
  if (challenge.prior_approved > 0) {
    return (
      <p className="mt-1.5 text-xs text-muted-foreground">
        {challenge.prior_approved === 1
          ? "1 identical hold approved"
          : `${challenge.prior_approved} identical holds approved`}{" "}
        in the last day.
      </p>
    );
  }
  return null;
}

function ApprovalDetail({
  challenge,
  zoneId,
  applicationName,
}: {
  challenge: StepUpChallenge;
  zoneId: string;
  applicationName: string | null;
}) {
  const now = Date.now();
  const authority = requestedAuthority(challenge);
  const lineage = agentLineage(challenge);
  const subjectPrincipal =
    challenge.principal_id && challenge.principal_id !== challenge.application_id;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <Badge tone={stateTone(challenge.state)}>{challenge.state}</Badge>
        {challenge.tier ? (
          <Badge tone="neutral" title="The policy risk tier that raised this hold">
            {challenge.tier}
          </Badge>
        ) : null}
        <Badge tone="neutral">{APPROVER_CLASS_LABELS[challenge.approver_class]}</Badge>
      </div>

      <div className="rounded-md border border-border bg-card px-3 py-2.5 text-sm leading-6">
        <span className="font-medium text-foreground">{applicationName ?? "An application"}</span>{" "}
        {lineage.agentSession ? "is running an agent that wants" : "wants"}{" "}
        {authority.scopes.length > 0 ? (
          <span className="inline-flex flex-wrap gap-1 align-middle">
            {authority.scopes.map((scope) => (
              <Badge key={scope} tone="neutral">
                {scope}
              </Badge>
            ))}
          </span>
        ) : (
          "the authority fingerprinted below"
        )}
        {authority.resources.length > 0 ? (
          <>
            {" on "}
            <span className="inline-flex flex-wrap gap-1 align-middle">
              {authority.resources.map((resource) => (
                <Badge key={resource} tone="neutral">
                  {resource}
                </Badge>
              ))}
            </span>
          </>
        ) : null}
        . Policy parked the token for a human decision.
        {lineage.agentSession ? (
          <AgentContext zoneId={zoneId} agentSessionId={lineage.agentSession} />
        ) : null}
        {challenge.state === "pending" ? <PatternLine challenge={challenge} /> : null}
      </div>

      {isDecidable(challenge) ? (
        <DecisionPanel challenge={challenge} zoneId={zoneId} />
      ) : challenge.state === "pending" ? (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <div className="font-medium text-foreground">
            Waiting on the application&apos;s end user
          </div>
          <p className="mt-0.5">
            The policy that raised this hold reserves the decision for the application&apos;s own
            end user. No zone credential can decide it; it settles through the application or
            expires {relativeTime(challenge.expires_at, now)}.
          </p>
        </div>
      ) : (
        <SettledSummary challenge={challenge} now={now} />
      )}

      <DetailGroup title="Request">
        {challenge.application_id ? (
          <DetailField label="Application">
            <CopyValue value={challenge.application_id} />
          </DetailField>
        ) : null}
        {subjectPrincipal ? (
          <DetailField label="Principal">
            <CopyValue value={challenge.principal_id} />
          </DetailField>
        ) : null}
        {challenge.session_id ? (
          <DetailField label="Session">
            <CopyValue value={challenge.session_id} />
          </DetailField>
        ) : null}
        <DetailField label="Binding">
          <CopyValue value={challenge.binding} />
          <p className="mt-1 text-[11px] text-muted-foreground">
            Fingerprint of the exact resources and scopes held. The agent prints the same value
            beside the challenge id.
          </p>
        </DetailField>
        {challenge.privacy_mode !== "identified" ? (
          <DetailField label="Privacy">
            <span className="text-xs text-muted-foreground">
              {PRIVACY_MODE_LABELS[challenge.privacy_mode]}
            </span>
          </DetailField>
        ) : null}
      </DetailGroup>

      {lineage.agentSession || lineage.edge ? (
        <DetailGroup title="Provenance">
          {lineage.agentSession ? (
            <DetailField label="Agent session">
              <CopyValue value={lineage.agentSession} />
              <p className="mt-1 text-[11px] text-muted-foreground">
                The spawned agent run asking for this token.
              </p>
            </DetailField>
          ) : null}
          {lineage.edge ? (
            <DetailField label="Delegation edge">
              <CopyValue value={lineage.edge} />
              <p className="mt-1 text-[11px] text-muted-foreground">
                The narrowed grant the agent holds; the token can never exceed it.
              </p>
            </DetailField>
          ) : null}
        </DetailGroup>
      ) : null}

      <DetailGroup title="Lifecycle">
        <DetailField label="Raised">{new Date(challenge.created_at).toLocaleString()}</DetailField>
        <DetailField label="Expires">
          {new Date(challenge.expires_at).toLocaleString()}
          <span className="ml-2 text-xs text-muted-foreground">
            ({relativeTime(challenge.expires_at, now)})
          </span>
        </DetailField>
        {challenge.satisfied_at ? (
          <DetailField label="Approved">
            {new Date(challenge.satisfied_at).toLocaleString()}
          </DetailField>
        ) : null}
        {challenge.rejected_at ? (
          <DetailField label="Rejected">
            {new Date(challenge.rejected_at).toLocaleString()}
          </DetailField>
        ) : null}
        {challenge.consumed_at ? (
          <DetailField label="Consumed">
            {new Date(challenge.consumed_at).toLocaleString()}
          </DetailField>
        ) : null}
        {challenge.approver_subject_id ? (
          <DetailField label="Decided by">
            <CreatedBy id={challenge.approver_subject_id} />
          </DetailField>
        ) : null}
        {challenge.decision_reason ? (
          <DetailField label="Reason">{challenge.decision_reason}</DetailField>
        ) : null}
      </DetailGroup>

      {challenge.session_id ? (
        <div className="border-t border-border pt-3">
          <Link
            to={appLink("/audit")}
            search={{ session: challenge.session_id }}
            className="text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            Open session activity in Audit
          </Link>
        </div>
      ) : null}
    </div>
  );
}

// Verdict controls for a live operator-decidable hold. Approving releases exactly one token
// for the bound resources and scopes; rejecting settles the hold terminally. Both verdicts
// land in the zone audit stream with the deciding identity and the optional rationale.
function DecisionPanel({ challenge, zoneId }: { challenge: StepUpChallenge; zoneId: string }) {
  const toast = useToast();
  const decide = useDecideApproval(zoneId);
  const [reason, setReason] = useState("");
  const now = Date.now();

  const submit = async (decision: "approve" | "reject") => {
    try {
      await decide.mutateAsync({
        id: challenge.id,
        decision,
        reason: reason.trim() || undefined,
      });
      toast({
        tone: "success",
        title: decision === "approve" ? "Hold approved" : "Hold rejected",
        description:
          decision === "approve"
            ? "The agent's next exchange attempt mints the held token."
            : "The hold is settled; the agent's exchange fails closed.",
      });
    } catch (err) {
      if (err instanceof ConsoleApiError && err.code === "challenge_not_decidable") {
        toast({
          tone: "error",
          title: "Hold already settled",
          description: "Someone else decided this hold, or its window closed.",
        });
      } else if (err instanceof ConsoleApiError && err.code === "subject_approval_required") {
        toast({
          tone: "error",
          title: "Reserved for the end user",
          description: "Only the application's own end user can decide this hold.",
        });
      } else {
        toast({ tone: "error", title: "Decision failed", description: errorMessage(err) });
      }
    }
  };

  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-3">
      <div className="text-xs font-medium text-amber-700 dark:text-amber-400">
        Awaiting a decision
      </div>
      <div className="mt-1.5 flex flex-col gap-1 text-xs text-amber-700/90 dark:text-amber-400/90">
        <div>
          <span className="font-medium">If you approve:</span> one short-lived token is released for
          exactly the authority above, once; unused, it lapses with the hold{" "}
          {relativeTime(challenge.expires_at, now)}.
        </div>
        <div>
          <span className="font-medium">If you reject:</span> the exchange fails closed for the rest
          of the window.
        </div>
      </div>
      <div className="mt-3">
        <Textarea
          label="Reason (optional)"
          placeholder="Why this authority is or is not warranted"
          value={reason}
          maxLength={500}
          rows={2}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          mutating
          loading={decide.isPending}
          onClick={() => void submit("approve")}
        >
          Approve
        </Button>
        <Button
          size="sm"
          variant="danger"
          mutating
          loading={decide.isPending}
          onClick={() => void submit("reject")}
        >
          Reject
        </Button>
      </div>
    </div>
  );
}

// States the terminal outcome of a settled hold in the same terms the runtime enforced it.
function SettledSummary({ challenge, now }: { challenge: StepUpChallenge; now: number }) {
  if (challenge.state === "consumed") {
    return (
      <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <div className="font-medium text-foreground">Approval consumed</div>
        <p className="mt-0.5">
          The approval released exactly one token and cannot be reused. New authority requires a
          fresh hold.
        </p>
      </div>
    );
  }
  if (challenge.state === "approved") {
    return (
      <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
        <div className="font-medium">Approved, not yet consumed</div>
        <p className="mt-0.5 text-emerald-700/80 dark:text-emerald-400/80">
          The agent&apos;s next exchange attempt mints the held token. The approval expires with the
          hold {relativeTime(challenge.expires_at, now)}.
        </p>
      </div>
    );
  }
  if (challenge.state === "rejected") {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        <div className="font-medium">Rejected</div>
        <p className="mt-0.5 text-destructive/80">
          The runtime refuses this authority for the rest of the hold&apos;s window (
          {relativeTime(challenge.expires_at, now)}) — repeat requests fail without raising a new
          hold. A fresh request is possible after the window closes.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <div className="font-medium text-foreground">Expired undecided</div>
      <p className="mt-0.5">
        The approval window closed {relativeTime(challenge.expires_at, now)} without a decision, so
        the exchange failed closed.
      </p>
    </div>
  );
}
