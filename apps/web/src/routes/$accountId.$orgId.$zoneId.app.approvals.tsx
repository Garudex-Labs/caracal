/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Approvals route for deciding human-approval holds.
*/
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import {
  CopyValue,
  DetailField,
  DetailGroup,
  ResourceWorkspace,
} from "@/components/console/ResourceWorkspace";
import { FeedToolbar } from "@/components/console/FeedToolbar";
import { ZoneScopedPage } from "@/components/console/ZoneScope";
import { Badge, Button, Select, Textarea, useToast, type Column } from "@/components/ui";
import { appLink } from "@/platform/nav/appLink";
import { ConsoleApiError } from "@/platform/api/client";
import { useApprovalCounts, useApprovalsFeed, useDecideApproval } from "@/platform/api/hooks";
import type { ApprovalCounts, StepUpChallenge, StepUpState } from "@/platform/api/types";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/approvals")({
  component: ApprovalsRoute,
});

function ApprovalsRoute() {
  return (
    <ZoneScopedPage
      title="Approvals"
      description="Human-approval holds raised by policy before a token is released."
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
function requestedAuthority(challenge: StepUpChallenge): string[] {
  const meta = challenge.metadata_json;
  if (!meta) return [];
  const parts: string[] = [];
  for (const key of ["requested_scopes", "resources"]) {
    const value = meta[key];
    if (Array.isArray(value)) parts.push(...value.filter((v) => typeof v === "string"));
    else if (typeof value === "string" && value) parts.push(value);
  }
  return parts;
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
  const feed = useApprovalsFeed(
    zoneId,
    state === "all" ? {} : { state: state as StepUpState },
  );
  const counts = useApprovalCounts(zoneId);
  const rows = useMemo(() => (feed.data?.pages ?? []).flatMap((page) => page.rows), [feed.data]);
  const now = Date.now();

  const columns: Column<StepUpChallenge>[] = [
    {
      id: "principal",
      header: "Requested by",
      sortable: true,
      cell: (c) => (
        <div>
          <div className="font-mono text-xs text-foreground">{c.principal_id}</div>
          <div className="font-mono text-[10px] text-muted-foreground">{c.session_id}</div>
        </div>
      ),
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
      description="Holds raised by approval-tier policies. A pending hold parks the agent's token exchange until someone with authority decides it."
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
        placeholder: "Search loaded holds by principal, session, or binding…",
        match: (c, q) =>
          c.id.toLowerCase().includes(q) ||
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
        title: (c) => c.principal_id,
        description: (c) => (c.tier ? `Approval tier: ${c.tier}` : "Approval hold"),
        render: (c) => <ApprovalDetail challenge={c} zoneId={zoneId} />,
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
        States derive from the same rule the token service enforces: an approved hold past its
        window reads as <span className="font-medium">expired</span>, and a consumed hold already
        released its token. Settled holds age out of this list after a day; the zone audit
        stream keeps the permanent record of every decision.
      </p>
    </FeedToolbar>
  );
}

function ApprovalDetail({ challenge, zoneId }: { challenge: StepUpChallenge; zoneId: string }) {
  const now = Date.now();
  const authority = requestedAuthority(challenge);
  const lineage = agentLineage(challenge);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <Badge tone={stateTone(challenge.state)}>{challenge.state}</Badge>
        {challenge.tier ? <Badge tone="neutral">{challenge.tier}</Badge> : null}
        <Badge tone="neutral">{APPROVER_CLASS_LABELS[challenge.approver_class]}</Badge>
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
        <DetailField label="Principal">
          <CopyValue value={challenge.principal_id} />
        </DetailField>
        {challenge.application_id ? (
          <DetailField label="Application">
            <CopyValue value={challenge.application_id} />
          </DetailField>
        ) : null}
        <DetailField label="Session">
          <CopyValue value={challenge.session_id} />
        </DetailField>
        {lineage.agentSession ? (
          <DetailField label="Agent run">
            <CopyValue value={lineage.agentSession} />
          </DetailField>
        ) : null}
        {lineage.edge ? (
          <DetailField label="Delegation edge">
            <CopyValue value={lineage.edge} />
          </DetailField>
        ) : null}
        {authority.length > 0 ? (
          <DetailField label="Requested authority">
            <div className="flex flex-wrap gap-1">
              {authority.map((item) => (
                <Badge key={item} tone="neutral">
                  {item}
                </Badge>
              ))}
            </div>
          </DetailField>
        ) : null}
        <DetailField label="Binding">
          <CopyValue value={challenge.binding} />
          <p className="mt-1 text-[11px] text-muted-foreground">
            Fingerprint of the exact resources and scopes held. The agent prints the same value
            beside the challenge id, so compare them before approving.
          </p>
        </DetailField>
        <DetailField label="Privacy">
          <span className="text-xs text-muted-foreground">
            {PRIVACY_MODE_LABELS[challenge.privacy_mode]}
          </span>
        </DetailField>
      </DetailGroup>

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
            <CopyValue value={challenge.approver_subject_id} />
          </DetailField>
        ) : null}
        {challenge.decision_reason ? (
          <DetailField label="Reason">{challenge.decision_reason}</DetailField>
        ) : null}
      </DetailGroup>

      <div className="border-t border-border pt-3">
        <Link
          to={appLink("/audit")}
          search={{ session: challenge.session_id }}
          className="text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          Open session activity in Audit
        </Link>
      </div>
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
      <p className="mt-0.5 text-xs text-amber-700/80 dark:text-amber-400/80">
        The agent&apos;s token exchange is parked on this hold. Approving releases one token for
        exactly the bound resources and scopes; rejecting fails it closed.
      </p>
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
          The hold is settled terminally; the runtime refuses the exchange. The agent must raise a
          new request for this authority.
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
