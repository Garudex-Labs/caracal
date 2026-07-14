/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Approvals route for deciding human-approval holds.
*/
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";

import {
  BriefRow,
  CopyValue,
  DetailField,
  EventTimeline,
  ResourceWorkspace,
  type TimelineEvent,
} from "@/components/console/ResourceWorkspace";
import { CreatedBy } from "@/components/console/CreatedBy";
import { FeedToolbar } from "@/components/console/FeedToolbar";
import { ZoneScopedPage } from "@/components/console/ZoneScope";
import { Badge, Button, Select, Textarea, useToast, type Column } from "@/components/ui";
import { appLink } from "@/platform/nav/appLink";
import { relativeTime } from "@/lib/time";
import { requestedAuthority, sessionLineage } from "@/lib/approvalMetadata";
import { ConsoleApiError, consoleApi } from "@/platform/api/client";
import { errorMessage } from "@/platform/api/errors";
import {
  useApplications,
  useApprovalCounts,
  useApprovalsFeed,
  useDecideApproval,
  useResources,
} from "@/platform/api/hooks";
import type { Approval, ApprovalCounts, ApprovalState } from "@/platform/api/types";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/approvals")({
  component: ApprovalsRoute,
});

function ApprovalsRoute() {
  return (
    <ZoneScopedPage
      title="Approvals"
      description="Requests held until someone with authority approves or rejects them."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Approvals" }]}
    >
      {(zone) => <ApprovalsPage zoneId={zone.id} />}
    </ZoneScopedPage>
  );
}

function stateTone(state: ApprovalState): "warning" | "success" | "danger" | "muted" | "neutral" {
  if (state === "pending") return "warning";
  if (state === "approved") return "success";
  if (state === "consumed") return "neutral";
  if (state === "rejected") return "danger";
  return "muted";
}

const APPROVER_CLASS_LABELS: Record<Approval["approver_class"], string> = {
  operator: "Zone operator",
  subject: "End user only",
  any: "Operator or end user",
};

const PRIVACY_MODE_LABELS: Record<Approval["privacy_mode"], string> = {
  identified: "Identified: approvers see who is asking",
  pseudonymous: "Pseudonymous: approvers see a stable alias",
  anonymous: "Anonymous: approvers see only what is requested",
};

// A hold is decidable in the console while it is pending and the policy that raised it
// admits operator-plane approval. Subject-only holds are the application's promise that
// only its own end user decides; the console shows them but never offers a verdict.
function isDecidable(challenge: Approval): boolean {
  return challenge.state === "pending" && challenge.approver_class !== "subject";
}

// The instant a hold reached its recorded state, used to order settled holds in the list.
function decidedAt(challenge: Approval): string | null {
  return challenge.consumed_at ?? challenge.rejected_at ?? challenge.satisfied_at;
}

function ApprovalsPage({ zoneId }: { zoneId: string }) {
  const [state, setState] = useState<string>("all");
  const feed = useApprovalsFeed(zoneId, state === "all" ? {} : { state: state as ApprovalState });
  const counts = useApprovalCounts(zoneId);
  const apps = useApplications(zoneId);
  const resources = useResources(zoneId);
  const appNames = useMemo(
    () => new Map((apps.data ?? []).map((app) => [app.id, app.name])),
    [apps.data],
  );
  const resourceNames = useMemo(
    () => new Map((resources.data ?? []).map((r) => [r.identifier, r.name])),
    [resources.data],
  );
  const appName = (c: Approval) => (c.application_id && appNames.get(c.application_id)) || null;
  const rows = useMemo(() => (feed.data?.pages ?? []).flatMap((page) => page.rows), [feed.data]);
  const now = Date.now();

  const columns: Column<Approval>[] = [
    {
      id: "principal",
      header: "Requested by",
      sortable: true,
      cell: (c) => {
        const name = appName(c);
        const sub =
          c.session_id || (name && c.principal_id !== c.application_id ? c.principal_id : "");
        return (
          <div>
            <div
              className={
                name ? "text-xs font-medium text-foreground" : "font-mono text-xs text-foreground"
              }
            >
              {name ?? c.principal_id}
            </div>
            {sub ? <div className="font-mono text-[10px] text-muted-foreground">{sub}</div> : null}
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
      description="Requests held until someone with authority approves or rejects them."
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
          : "Holds appear here when a policy declares an approval tier and an session requests matching authority.",
      }}
      detail={{
        title: (c) => appName(c) ?? c.principal_id,
        description: (c) => `Raised ${relativeTime(c.created_at)}`,
        render: (c) => (
          <ApprovalDetail
            challenge={c}
            zoneId={zoneId}
            applicationName={appName(c)}
            resourceNames={resourceNames}
          />
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

// One labeled row inside the briefing card, aligned so the card scans as a grid of
// facts instead of prose.

// What the requesting session says about itself, read live from the coordinator: the
// task its developer annotated at session start, its role labels, and how recently it started.
// The context a policy cannot evaluate but an approver can. A missing task annotation
// is stated outright - not knowing why an session wants authority is itself a signal.
// Renders nothing only when the session record is gone.
function SessionContext({ zoneId, sessionId }: { zoneId: string; sessionId: string }) {
  const session = useQuery({
    queryKey: ["approvalSession", zoneId, sessionId],
    queryFn: () => consoleApi.sessions.get(zoneId, sessionId),
    staleTime: 30_000,
    retry: false,
  });
  if (!session.data) return null;
  const task = typeof session.data.metadata?.task === "string" ? session.data.metadata.task : null;
  const labels = session.data.labels ?? [];
  return (
    <BriefRow label="Task">
      <span className={task ? "text-sm text-foreground" : "text-sm text-muted-foreground"}>
        {task ?? "None recorded"}
      </span>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        {labels.length > 0 ? (
          <>
            {labels.join(", ")}
            {" \u00b7 "}
          </>
        ) : null}
        {relativeTime(session.data.startedAt)}
        {" \u00b7 "}
        <Link
          to={appLink("/sessions")}
          search={{ focus: sessionId }}
          className="text-muted-foreground underline decoration-muted-foreground/40 underline-offset-2 hover:text-foreground"
        >
          View session
        </Link>
      </p>
    </BriefRow>
  );
}

// The recent history of this exact authority (same binding hash, last day - the
// challenge store's retention window). One sentence, strongest signal first: a
// recent rejection is a warning; a pile of identical approvals is policy debt.
function PatternLine({ challenge }: { challenge: Approval }) {
  if (challenge.prior_rejected > 0) {
    return (
      <BriefRow label="History">
        <span className="text-xs font-medium text-destructive">
          Rejected in the last day
          {challenge.prior_approved > 0 ? ` (${challenge.prior_approved} approved earlier)` : ""}.
          Check why before approving.
        </span>
      </BriefRow>
    );
  }
  if (challenge.prior_approved >= 5) {
    return (
      <BriefRow label="History">
        <span className="text-xs text-amber-700 dark:text-amber-400">
          Approved {challenge.prior_approved} times in the last day. If routine, encode it as
          policy.
        </span>
      </BriefRow>
    );
  }
  return (
    <BriefRow label="History">
      <span className="text-xs text-muted-foreground">
        {challenge.prior_approved > 0
          ? `Approved ${challenge.prior_approved === 1 ? "once" : `${challenge.prior_approved} times`} in the last day.`
          : "First request in the last day."}
      </span>
    </BriefRow>
  );
}

// The hold's recorded history as ordered events. Decision events carry the deciding
// identity and rationale inline, and the terminal event states what the outcome means,
// so the story reads top to bottom without a separate explanation box.
function holdEvents(challenge: Approval, now: number): TimelineEvent[] {
  const windowLive = Date.parse(challenge.expires_at) > now;
  const decidedBy = challenge.approver_subject_id ? (
    <>
      by <CreatedBy id={challenge.approver_subject_id} />
      {challenge.decision_reason ? (
        <>
          {" \u00b7 \u201c"}
          {challenge.decision_reason}
          {"\u201d"}
        </>
      ) : null}
    </>
  ) : challenge.decision_reason ? (
    <>
      {"\u201c"}
      {challenge.decision_reason}
      {"\u201d"}
    </>
  ) : undefined;

  const events: TimelineEvent[] = [{ label: "Raised", at: challenge.created_at, tone: "neutral" }];
  if (challenge.satisfied_at) {
    events.push({
      label: "Approved",
      at: challenge.satisfied_at,
      tone: "success",
      detail: decidedBy,
    });
  }
  if (challenge.rejected_at) {
    events.push({
      label: "Rejected",
      at: challenge.rejected_at,
      tone: "danger",
      detail: (
        <>
          {decidedBy}
          {windowLive ? (
            <span className="block">
              Identical re-asks are refused until the window closes{" "}
              {relativeTime(challenge.expires_at, now)}.
            </span>
          ) : null}
        </>
      ),
    });
  }
  if (challenge.consumed_at) {
    events.push({
      label: "Consumed",
      at: challenge.consumed_at,
      tone: "neutral",
      detail: "Released exactly one token; the approval cannot be reused.",
    });
  }
  if (challenge.state === "expired") {
    events.push({
      label: "Expired",
      at: challenge.expires_at,
      tone: "muted",
      detail: challenge.satisfied_at
        ? "The approval lapsed unused; the exchange fails closed."
        : "No decision arrived; the exchange fails closed.",
    });
  }
  if (challenge.state === "pending") {
    events.push({ label: "Expires", at: challenge.expires_at, tone: "muted", future: true });
  }
  if (challenge.state === "approved") {
    events.push({
      label: "Lapses",
      at: challenge.expires_at,
      tone: "muted",
      future: true,
      detail: "The session's next exchange mints the held token until then.",
    });
  }
  return events;
}

function ApprovalDetail({
  challenge,
  zoneId,
  applicationName,
  resourceNames,
}: {
  challenge: Approval;
  zoneId: string;
  applicationName: string | null;
  resourceNames: Map<string, string>;
}) {
  const now = Date.now();
  const authority = requestedAuthority(challenge);
  const lineage = sessionLineage(challenge);
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

      <div className="rounded-md border border-border bg-card px-3 py-2.5">
        <dl className="flex flex-col gap-2">
          <BriefRow label="Requests">
            <span className="flex flex-wrap items-center gap-1">
              {authority.scopes.length > 0 ? (
                authority.scopes.map((scope) => (
                  <Badge key={scope} tone="neutral">
                    {scope}
                  </Badge>
                ))
              ) : (
                <span className="text-sm text-muted-foreground">
                  the authority fingerprinted below
                </span>
              )}
              {authority.resources.length > 0 ? (
                <>
                  <span className="text-xs text-muted-foreground">on</span>
                  {authority.resources.map((resource) => (
                    <Badge key={resource} tone="neutral" title={resource}>
                      {resourceNames.get(resource) ?? resource}
                    </Badge>
                  ))}
                </>
              ) : null}
            </span>
          </BriefRow>
          {lineage.session ? <SessionContext zoneId={zoneId} sessionId={lineage.session} /> : null}
          {challenge.state === "pending" ? <PatternLine challenge={challenge} /> : null}
        </dl>
      </div>

      {isDecidable(challenge) ? (
        <DecisionPanel challenge={challenge} zoneId={zoneId} />
      ) : challenge.state === "pending" ? (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <div className="font-medium text-foreground">
            Waiting on the application&apos;s end user
          </div>
          <p className="mt-0.5">
            {challenge.subject_anchor
              ? "The requesting agent acts for a specific end user, and the policy reserves this decision for exactly that person. "
              : "The policy that raised this hold reserves the decision for the application's own end user. "}
            No zone credential can decide it; it settles through the application or expires{" "}
            {relativeTime(challenge.expires_at, now)}.
          </p>
        </div>
      ) : null}

      {challenge.state !== "pending" ? (
        <EventTimeline events={holdEvents(challenge, now)} now={now} />
      ) : null}

      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground [&::-webkit-details-marker]:hidden">
          <span aria-hidden="true" className="transition-transform group-open:rotate-90">
            {"\u25b8"}
          </span>
          Technical details
        </summary>
        <dl className="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          <DetailField
            label="Hold"
            hint="The challenge id the session received; decisions land on this id"
          >
            <CopyValue value={challenge.id} />
          </DetailField>
          {challenge.application_id ? (
            <DetailField
              label="Application"
              hint="The application whose credential requested this authority"
            >
              {applicationName ? (
                <div className="mb-0.5 text-sm text-foreground">{applicationName}</div>
              ) : null}
              <CopyValue value={challenge.application_id} />
            </DetailField>
          ) : null}
          {subjectPrincipal ? (
            <DetailField label="Principal" hint="The subject principal the token is minted for">
              <CopyValue value={challenge.principal_id} />
            </DetailField>
          ) : null}
          {challenge.subject_anchor ? (
            <DetailField
              label="Reserved approver"
              hint="The federated Subject the agent acts for; only this person can decide the hold on the subject plane"
            >
              <CopyValue value={challenge.subject_anchor} />
            </DetailField>
          ) : null}
          {challenge.session_id ? (
            <DetailField
              label="Authority record ID"
              hint="The STS exchange record that carried the Subject's authority"
            >
              <CopyValue value={challenge.session_id} />
            </DetailField>
          ) : null}
          {lineage.session ? (
            <DetailField label="Session ID" hint="The governed Session asking for this token">
              <CopyValue value={lineage.session} />
            </DetailField>
          ) : null}
          {lineage.edge ? (
            <DetailField
              label="Delegation"
              hint="The narrowed authority the session holds; the token cannot exceed it"
            >
              <CopyValue value={lineage.edge} />
            </DetailField>
          ) : null}
          <DetailField
            label="Binding"
            hint="Fingerprint of the exact resources and scopes held. The requester prints the same value beside the challenge id."
          >
            <CopyValue value={challenge.binding} />
          </DetailField>
          {challenge.privacy_mode !== "identified" ? (
            <DetailField label="Privacy">
              <span className="text-xs text-muted-foreground">
                {PRIVACY_MODE_LABELS[challenge.privacy_mode]}
              </span>
            </DetailField>
          ) : null}
        </dl>
      </details>

      {challenge.session_id ? (
        <div className="border-t border-border pt-3">
          <Link
            to={appLink("/audit")}
            search={{ authorityRecordId: challenge.session_id }}
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
function DecisionPanel({ challenge, zoneId }: { challenge: Approval; zoneId: string }) {
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
            ? "The session's next exchange attempt mints the held token."
            : "The hold is settled; the session's exchange fails closed.",
      });
    } catch (err) {
      if (err instanceof ConsoleApiError && err.code === "approval_not_decidable") {
        toast({
          tone: "error",
          title: "Hold already settled",
          description: "Someone else decided this hold, or its window closed.",
        });
      } else if (err instanceof ConsoleApiError && err.code === "subject_approval_required") {
        toast({
          tone: "error",
          title: "Reserved for the end user",
          description:
            "Only the application's own federated end user can decide this hold, through the STS subject plane.",
        });
      } else {
        toast({ tone: "error", title: "Decision failed", description: errorMessage(err) });
      }
    }
  };

  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-3">
      <div className="flex flex-col gap-1 text-xs leading-5 text-amber-700/90 dark:text-amber-400/90">
        <div>
          <span className="font-medium">Approve:</span> releases one single-use token for the
          authority above. Unused, it lapses {relativeTime(challenge.expires_at, now)}.
        </div>
        <div>
          <span className="font-medium">Reject:</span> fails closed. Identical re-asks are refused
          for the rest of the window.
        </div>
      </div>
      <div className="mt-3">
        <Textarea
          label="Reason (optional)"
          placeholder="Recorded in the audit trail"
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
