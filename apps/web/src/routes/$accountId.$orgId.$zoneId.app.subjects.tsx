/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Subjects route.
*/
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import {
  CopyValue,
  DetailField,
  DetailGroup,
  ResourceWorkspace,
} from "@/components/console/ResourceWorkspace";
import { FeedToolbar } from "@/components/console/FeedToolbar";
import { ZoneScopedPage } from "@/components/console/ZoneScope";
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  Field,
  FilterMenu,
  Modal,
  Pagination,
  SearchInput,
  Select,
  Skeleton,
  Tooltip,
  useCopyToClipboard,
  useToast,
  type Column,
  type SortState,
} from "@/components/ui";
import { CsvExportButton } from "@/components/console/CsvExportButton";
import { cx } from "@/lib/cx";
import { relativeTime } from "@/lib/time";
import { appLink } from "@/platform/nav/appLink";
import { ConsoleApiError } from "@/platform/api/client";
import {
  useAgent,
  useAgentInboundDelegations,
  useAgentLifecycle,
  useRevokeDelegation,
  useRevokeSubject,
  useSessionRecord,
  useSessionsFeed,
  useSubjectOverview,
  useSubjectsFeed,
} from "@/platform/api/hooks";
import type { Session, SubjectSummary } from "@/platform/api/types";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/subjects")({
  component: SubjectsRoute,
  validateSearch: (
    search: Record<string, unknown>,
  ): { subject?: string; focus?: string; record?: string } => ({
    subject: typeof search.subject === "string" ? search.subject : undefined,
    focus: typeof search.focus === "string" ? search.focus : undefined,
    record: typeof search.record === "string" ? search.record : undefined,
  }),
});

function SubjectsRoute() {
  const { subject, record } = Route.useSearch();
  return (
    <ZoneScopedPage
      title="Subjects"
      description="The identities your applications act for: federated end users and application identities, with the authority each one holds right now."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Subjects" }]}
    >
      {(zone) => <SubjectsPage zoneId={zone.id} initialSubject={subject} recordId={record} />}
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

type EffectiveStatus = "active" | "expired" | "revoked";

// The control plane stores a session's status as active/revoked/expired, but the
// reaper only flips orphaned (zone-deleted) sessions to expired, and a session whose
// expires_at has passed keeps status='active' in the database until then. The STS
// runtime, however, denies any exchange unless `status === 'active' && expires_at > now`
// (exchange.go: "session inactive or expired"). So a stored-active session past its
// expiry carries no usable authority. Derive the status the runtime actually enforces
// so the console never shows lapsed authority as live.
function effectiveStatus(session: Session, now: number): EffectiveStatus {
  if (session.status === "revoked") return "revoked";
  if (session.status === "expired") return "expired";
  return Date.parse(session.expires_at) > now ? "active" : "expired";
}

// True when the database still says active but the session has actually lapsed and is
// awaiting reaping, worth flagging so operators understand the record/runtime drift.
function isStaleActive(session: Session, now: number): boolean {
  return session.status === "active" && Date.parse(session.expires_at) <= now;
}

function statusTone(status: EffectiveStatus): "success" | "muted" | "danger" {
  if (status === "active") return "success";
  if (status === "revoked") return "danger";
  return "muted";
}

// Maps the reason recorded when a session is revoked to operator-facing wording. The
// backend stamps these at the originating action (grant delete, application archive) or
// falls back to a generic marker when a revocation arrives only through the stream.
const REVOCATION_REASON_LABELS: Record<string, string> = {
  grant_revoked: "Grant revoked",
  dcr_shutdown: "Application archived",
  application_archived: "Application archived",
  session_revoked: "Revoked",
};

function revocationReasonLabel(reason: string | null): string {
  if (!reason) return "Revoked";
  return REVOCATION_REASON_LABELS[reason] ?? reason.replace(/_/g, " ");
}

// One-line outcome for a session: why it ended, or that it is still live. Revoked
// sessions surface the recorded cause so operators see intent, not just a status.
function sessionOutcome(session: Session, effective: EffectiveStatus): string {
  if (effective === "active") return "Live";
  if (effective === "revoked") return revocationReasonLabel(session.revoked_reason);
  return "Expired";
}

// The subject-level state an analyst acts on, derived from the aggregate rather than
// any single token record: live when anything can still mint, revoked when the most
// recent thing that happened to the subject was a forced cutoff, dormant otherwise.
// Individual records expiring is normal operation and never surfaces at this level.
type Standing = "live" | "revoked" | "dormant";

function subjectStanding(s: SubjectSummary): Standing {
  if (s.active_sessions > 0) return "live";
  if (s.last_revoked_at && Date.parse(s.last_revoked_at) >= Date.parse(s.last_seen)) {
    return "revoked";
  }
  return "dormant";
}

const STANDING_LABELS: Record<Standing, string> = {
  live: "Live",
  revoked: "Revoked",
  dormant: "Dormant",
};

function standingTone(standing: Standing): "success" | "danger" | "muted" {
  if (standing === "live") return "success";
  if (standing === "revoked") return "danger";
  return "muted";
}

function standingCaption(s: SubjectSummary, standing: Standing, now: number): string {
  if (standing === "live") {
    return s.active_sessions === 1
      ? "1 session can mint"
      : `${s.active_sessions} sessions can mint`;
  }
  if (standing === "revoked" && s.last_revoked_at) {
    return `Cut off ${relativeTime(s.last_revoked_at, now)}`;
  }
  return `Last seen ${relativeTime(s.last_seen, now)}`;
}

// Who this subject is, in the words an analyst thinks in: a registered application
// acting as itself, or an end user federated from an external identity system.
function subjectKindLabel(s: SubjectSummary): string {
  if (s.application_name) return "Application identity";
  if (s.federated) {
    return s.issuer ? `Federated user · ${issuerHost(s.issuer)}` : "Federated user";
  }
  return "Application identity";
}

function issuerHost(issuer: string): string {
  try {
    return new URL(issuer).hostname;
  } catch {
    return issuer;
  }
}

function subjectDisplayName(s: SubjectSummary): string {
  return s.application_name ?? s.subject_id;
}

// A link that only knows an authority-record id (for example from a governed
// session's detail) resolves to the owning subject so the analyst lands on the
// identity, not on a raw token record.
function RecordResolver({
  zoneId,
  recordId,
  onResolved,
}: {
  zoneId: string;
  recordId: string;
  onResolved: (subjectId: string) => void;
}) {
  const record = useSessionRecord(zoneId, recordId);
  useEffect(() => {
    if (record.data?.subject_id) onResolved(record.data.subject_id);
  }, [record.data, onResolved]);
  return null;
}

function SubjectsPage({
  zoneId,
  initialSubject,
  recordId,
}: {
  zoneId: string;
  initialSubject?: string;
  recordId?: string;
}) {
  const [kind, setKind] = useState<string>("all");
  const [search, setSearch] = useState(initialSubject ?? "");

  const serverQuery = useMemo(
    () => ({
      ...(kind === "user" || kind === "application"
        ? { kind: kind as "user" | "application" }
        : {}),
      ...(search.trim() ? { search: search.trim() } : {}),
    }),
    [kind, search],
  );

  const feed = useSubjectsFeed(zoneId, serverQuery);
  const rows = useMemo(() => (feed.data?.pages ?? []).flatMap((page) => page.rows), [feed.data]);
  const now = Date.now();

  const columns: Column<SubjectSummary>[] = [
    {
      id: "subject",
      header: "Subject",
      sortable: true,
      cell: (s) => (
        <div className="min-w-0">
          <div
            className={cx(
              "truncate text-xs text-foreground",
              s.application_name ? "font-medium" : "font-mono",
            )}
          >
            {subjectDisplayName(s)}
          </div>
          <div className="text-xs text-muted-foreground">{subjectKindLabel(s)}</div>
        </div>
      ),
    },
    {
      id: "standing",
      header: "Standing",
      sortable: true,
      cell: (s) => {
        const standing = subjectStanding(s);
        return (
          <div>
            <Badge tone={standingTone(standing)}>{STANDING_LABELS[standing]}</Badge>
            <div className="mt-0.5 text-[10px] text-muted-foreground">
              {standingCaption(s, standing, now)}
            </div>
          </div>
        );
      },
    },
    {
      id: "history",
      header: "History",
      cell: (s) => (
        <div className="text-xs text-muted-foreground">
          {s.total_sessions === 1 ? "1 session" : `${s.total_sessions} sessions`}
          {s.revoked_sessions > 0 ? (
            <span className="text-destructive"> · {s.revoked_sessions} revoked</span>
          ) : null}
          <div className="text-[10px]" title={new Date(s.first_seen).toLocaleString()}>
            since {new Date(s.first_seen).toLocaleDateString()}
          </div>
        </div>
      ),
    },
    {
      id: "seen",
      header: "Last seen",
      align: "right",
      sortable: true,
      cell: (s) => (
        <span
          className="text-xs text-muted-foreground"
          title={new Date(s.last_seen).toLocaleString()}
        >
          {relativeTime(s.last_seen, now)}
        </span>
      ),
    },
  ];

  return (
    <>
      {recordId ? (
        <RecordResolver zoneId={zoneId} recordId={recordId} onResolved={setSearch} />
      ) : null}
      <ResourceWorkspace
        title="Subjects"
        description="Everything below a subject - sessions, delegations, approvals, connections, audit - keys to the identity shown here. Caracal never authenticates these identities; your application's own identity system does, then exchanges them with the STS."
        breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Subjects" }]}
        rows={rows}
        loading={feed.isLoading}
        columns={columns}
        rowKey={(s) => s.subject_id}
        feed={{
          hasMore: Boolean(feed.hasNextPage),
          fetching: feed.isFetchingNextPage,
          loadMore: () => feed.fetchNextPage(),
        }}
        toolbarExtra={
          <SubjectFilterBar
            kind={kind}
            search={search}
            loaded={rows.length}
            onKind={setKind}
            onSearch={setSearch}
            exportControl={
              <CsvExportButton
                zoneId={zoneId}
                path="sessions"
                query={search.trim() ? { subject_id: search.trim() } : {}}
                noun="authority records"
              />
            }
          />
        }
        search={{
          placeholder: "Search loaded subjects by name or identifier…",
          match: (s, q) =>
            s.subject_id.toLowerCase().includes(q) ||
            (s.application_name ?? "").toLowerCase().includes(q) ||
            (s.issuer ?? "").toLowerCase().includes(q),
        }}
        initialSort={{ column: "seen", direction: "desc" }}
        sortValues={{
          subject: (s) => subjectDisplayName(s).toLowerCase(),
          standing: (s) => subjectStanding(s),
          seen: (s) => Date.parse(s.last_seen) || 0,
        }}
        empty={{
          title: feed.isError ? "Could not load subjects" : "No subjects yet",
          description: feed.isError
            ? errorMessage(feed.error)
            : "Subjects appear automatically: application identities on their first exchange, and federated end users once an application exchanges their identity token with the STS.",
        }}
        detail={{
          title: (s) => subjectDisplayName(s),
          description: (s) => subjectKindLabel(s),
          width: "max-w-2xl",
          render: (s) => <SubjectStory subject={s} zoneId={zoneId} />,
        }}
      />
    </>
  );
}

// Server-side kind and search filters so an analyst can isolate federated users from
// application identities in enterprise-scale zones instead of scanning pages.
function SubjectFilterBar({
  kind,
  search,
  loaded,
  onKind,
  onSearch,
  exportControl,
}: {
  kind: string;
  search: string;
  loaded: number;
  onKind: (v: string) => void;
  onSearch: (v: string) => void;
  exportControl: ReactNode;
}) {
  const activeFilters = (kind !== "all" ? 1 : 0) + (search.trim() ? 1 : 0);
  return (
    <FeedToolbar extra={exportControl} activeFilters={activeFilters} loaded={loaded} noun="subject">
      <Select label="Kind" value={kind} onChange={(e) => onKind(e.target.value)}>
        <option value="all">All subjects</option>
        <option value="user">Federated users</option>
        <option value="application">Application identities</option>
      </Select>
      <Field
        label="Subject"
        placeholder="richard.hendricks@piedpiper.example"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
      />
    </FeedToolbar>
  );
}

// Copies the subject aggregate so an analyst can paste the exact facts into a ticket
// or hand them to automation without re-deriving anything from the UI.
function CopySubjectButton({ subject }: { subject: SubjectSummary }) {
  const copy = useCopyToClipboard();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() =>
        void copy(JSON.stringify(subject, null, 2), {
          onSuccess: () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          },
        })
      }
    >
      {copied ? "Copied" : "Copy JSON"}
    </Button>
  );
}

// The plain-language verdict an analyst reads first: does anything hold live
// authority for this identity right now, and if not, why not.
function SubjectVerdict({ subject, now }: { subject: SubjectSummary; now: number }) {
  const standing = subjectStanding(subject);
  if (standing === "live") {
    return (
      <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
        <div className="font-medium">Holds live authority</div>
        <p className="mt-0.5 text-emerald-700/80 dark:text-emerald-400/80">
          {subject.active_sessions === 1
            ? "1 session can currently mint tokens for this subject."
            : `${subject.active_sessions} sessions can currently mint tokens for this subject.`}
        </p>
      </div>
    );
  }
  if (standing === "revoked") {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        <div className="font-medium">Authority was revoked</div>
        <p className="mt-0.5 text-destructive/80">
          The most recent authority for this subject was cut off
          {subject.last_revoked_at ? ` ${relativeTime(subject.last_revoked_at, now)}` : ""}. Nothing
          can act for it until it is federated or exchanged again.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <div className="font-medium text-foreground">No live authority</div>
      <p className="mt-0.5">
        Every record has expired - normal when work finished. Nothing can act for this subject until
        an application exchanges its identity again.
      </p>
    </div>
  );
}

// The subject-level kill switch. Per-record controls cut one session or one
// delegation; this cuts everything at once - every live session record, the
// governed sessions riding them, delegations, and provider connections - for
// credential compromise or offboarding, where per-record surgery is too slow.
function SubjectKillSwitch({ zoneId, subject }: { zoneId: string; subject: SubjectSummary }) {
  const toast = useToast();
  const revoke = useRevokeSubject(zoneId);
  const [confirm, setConfirm] = useState(false);

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
      <p className="text-xs text-muted-foreground">
        Cut off everything this subject holds: live records, the sessions riding them, delegations,
        and provider connections.
      </p>
      <Button
        variant="danger"
        size="sm"
        loading={revoke.isPending}
        onClick={() => setConfirm(true)}
      >
        Cut off all authority
      </Button>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Cut off all authority"
        description="Every live authority record for this subject is revoked, the sessions riding them terminate, their delegations fall, and its provider connections are revoked. In-flight tokens die through the revocation stream. This cannot be undone; the subject regains authority only by federating or exchanging again."
        confirmLabel="Cut off"
        tone="danger"
        onConfirm={async () => {
          try {
            const result = await revoke.mutateAsync({ subjectId: subject.subject_id });
            toast({
              tone: "info",
              title: "Authority cut off",
              description: `${result.sessions} records revoked, ${result.agents} sessions terminated, ${result.delegations} delegations revoked, ${result.connections} connections revoked.`,
            });
          } catch (err) {
            toast({ tone: "error", title: "Cut off failed", description: errorMessage(err) });
          }
        }}
      />
    </div>
  );
}

// The investigation story for one subject, ordered by the questions an analyst asks:
// who is this, can anything act as it right now, what has acted for it, what approvals
// and upstream accounts hang off it - with raw authority records last, for audit.
function SubjectStory({ subject, zoneId }: { subject: SubjectSummary; zoneId: string }) {
  const now = Date.now();
  const overview = useSubjectOverview(zoneId, subject.subject_id);
  const standing = subjectStanding(subject);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge tone={standingTone(standing)}>{STANDING_LABELS[standing]}</Badge>
          <Badge tone="neutral">
            {subject.application_name ? "Application identity" : "Federated user"}
          </Badge>
        </div>
        <CopySubjectButton subject={subject} />
      </div>

      <SubjectVerdict subject={subject} now={now} />
      {standing === "live" ? <SubjectKillSwitch zoneId={zoneId} subject={subject} /> : null}

      <DetailGroup title="Identity">
        <DetailField
          label="Subject ID"
          hint="The opaque identifier every session, approval, connection, and audit event keys to"
        >
          <CopyValue value={subject.subject_id} />
        </DetailField>
        <DetailField label="Origin">
          {subject.application_name ? (
            <Link
              to={appLink("/applications")}
              search={{ focus: subject.subject_id }}
              className="text-xs text-foreground hover:underline"
            >
              {subject.application_name} - registered application in this zone
            </Link>
          ) : subject.issuer ? (
            <span className="text-xs text-foreground">
              Federated by <span className="font-mono">{subject.issuer}</span>
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">
              Exchanged by an application; no issuer recorded
            </span>
          )}
        </DetailField>
        <DetailField label="First seen">
          {new Date(subject.first_seen).toLocaleString()}
        </DetailField>
        <DetailField label="Last seen">
          {new Date(subject.last_seen).toLocaleString()}
          <span className="ml-2 text-xs text-muted-foreground">
            ({relativeTime(subject.last_seen, now)})
          </span>
        </DetailField>
      </DetailGroup>

      {overview.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : overview.data ? (
        <>
          <GovernedSection zoneId={zoneId} governed={overview.data.governed} />
          <ApprovalsSection approvals={overview.data.approvals} />
          <ConnectionsSection connections={overview.data.connections} />
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {overview.isError ? errorMessage(overview.error) : null}
        </p>
      )}

      <RecordsLedger zoneId={zoneId} subject={subject} />
    </div>
  );
}

// What has actually acted for this subject: the governed sessions bound to it, newest
// first, each one a jump into the Sessions workspace.
function GovernedSection({
  zoneId,
  governed,
}: {
  zoneId: string;
  governed: {
    active: number;
    total: number;
    recent: {
      id: string;
      application_name: string | null;
      application_id: string;
      lifecycle: string;
      status: string;
      spawned_at: string;
    }[];
  };
}) {
  void zoneId;
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? governed.recent : governed.recent.slice(0, LEDGER_PREVIEW);
  return (
    <section className="border-t border-border pt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Governed sessions
        </h3>
        <span className="text-xs text-muted-foreground">
          {governed.active} active · {governed.total} total
        </span>
      </div>
      {governed.recent.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          No governed sessions have acted for this subject yet. When an application runs work bound
          to this identity, it appears here.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {visible.map((run) => (
            <li
              key={run.id}
              className="flex items-center justify-between gap-3 border border-border bg-muted/10 px-3 py-2"
            >
              <div className="min-w-0">
                <Link
                  to={appLink("/sessions")}
                  search={{ focus: run.id }}
                  className="text-xs font-medium text-foreground hover:underline"
                >
                  {run.application_name ?? run.application_id}
                </Link>
                <div className="text-[10px] text-muted-foreground">
                  {run.lifecycle} · {run.status}
                </div>
              </div>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {relativeTime(run.spawned_at)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!expanded && governed.recent.length > LEDGER_PREVIEW ? (
        <button
          type="button"
          className="mt-2 text-[10px] text-muted-foreground hover:text-foreground hover:underline"
          onClick={() => setExpanded(true)}
        >
          Show {governed.recent.length - LEDGER_PREVIEW} more recent
        </button>
      ) : null}
    </section>
  );
}

// Approvals raised while acting for this subject: pending holds are work waiting on a
// human, so they lead with a direct route to the Approvals workspace.
function ApprovalsSection({ approvals }: { approvals: { pending: number; total: number } }) {
  return (
    <section className="border-t border-border pt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Approvals
        </h3>
        <Link
          to={appLink("/approvals")}
          className="text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          Open Approvals
        </Link>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        {approvals.total === 0 ? (
          "No approval holds have been raised while acting for this subject."
        ) : (
          <>
            {approvals.pending > 0 ? (
              <span className="font-medium text-amber-600 dark:text-amber-500">
                {approvals.pending} pending now
              </span>
            ) : (
              "None pending"
            )}
            {" · "}
            {approvals.total} raised in total under this subject.
          </>
        )}
      </p>
    </section>
  );
}

// Upstream accounts consented for this subject. A dead connection is the usual cause of
// "the agent suddenly cannot reach the provider", so status leads.
function ConnectionsSection({
  connections,
}: {
  connections: {
    id: string;
    provider_name: string | null;
    provider_id: string;
    status: string;
    created_at: string;
  }[];
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? connections : connections.slice(0, LEDGER_PREVIEW);
  return (
    <section className="border-t border-border pt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Provider connections
        </h3>
        <Link
          to={appLink("/providers")}
          className="text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          Open Providers
        </Link>
      </div>
      {connections.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          No upstream accounts are connected for this subject.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {visible.map((c) => (
            <li
              key={c.id}
              className="flex items-center justify-between gap-3 border border-border bg-muted/10 px-3 py-2"
            >
              <div className="min-w-0">
                <span className="text-xs font-medium text-foreground">
                  {c.provider_name ?? c.provider_id}
                </span>
                <span className="ml-2 text-[10px] text-muted-foreground">
                  connected {relativeTime(c.created_at)}
                </span>
              </div>
              <Badge tone={c.status === "active" ? "success" : "danger"}>{c.status}</Badge>
            </li>
          ))}
        </ul>
      )}
      {!expanded && connections.length > LEDGER_PREVIEW ? (
        <button
          type="button"
          className="mt-2 text-[10px] text-muted-foreground hover:text-foreground hover:underline"
          onClick={() => setExpanded(true)}
        >
          Show {connections.length - LEDGER_PREVIEW} more
        </button>
      ) : null}
    </section>
  );
}

// Inline authority cutoff. A subject session's live authority is held by its session and
// fed by inbound delegations, so both controls act right here: terminating the session
// or revoking a delegation takes effect on the runtime immediately, no page change required.
function AuthorityControls({ zoneId, session }: { zoneId: string; session: Session }) {
  const toast = useToast();
  const agent = useAgent(zoneId, session.id);
  const inbound = useAgentInboundDelegations(zoneId, session.id);
  const lifecycle = useAgentLifecycle(zoneId);
  const revoke = useRevokeDelegation(zoneId);
  const [confirmTerminate, setConfirmTerminate] = useState(false);

  const holdingAgent =
    agent.data && (agent.data.status === "active" || agent.data.status === "suspended")
      ? agent.data
      : null;
  const edges = (inbound.data ?? []).filter((edge) => !edge.revoked_at);

  if (!holdingAgent && edges.length === 0) {
    return (
      <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        This subject session ends by expiry or grant revocation. No live session or inbound
        delegation holds authority for it right now.
      </p>
    );
  }

  return (
    <section className="border-t border-border pt-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        Cut off authority
      </h3>
      <div className="mt-3 flex flex-col gap-2">
        {holdingAgent ? (
          <div className="flex items-center justify-between gap-3 border border-border bg-muted/10 px-3 py-2">
            <div className="min-w-0">
              <span className="text-xs font-medium text-foreground">
                A session holds this authority
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {holdingAgent.lifecycle} · {holdingAgent.status} · depth {holdingAgent.depth}
              </span>
            </div>
            <Button
              variant="danger"
              size="sm"
              loading={lifecycle.isPending}
              onClick={() => setConfirmTerminate(true)}
            >
              Terminate session
            </Button>
          </div>
        ) : null}
        {edges.map((edge) => (
          <div
            key={edge.id}
            className="flex items-center justify-between gap-3 border border-border bg-muted/10 px-3 py-2"
          >
            <div className="min-w-0">
              <span className="text-xs font-medium text-foreground">Inbound delegation</span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                {edge.scopes.join(", ") || "no scopes"} · from{" "}
                <span className="font-mono">{edge.source_session_id.slice(0, 8)}…</span>
              </span>
            </div>
            <Button
              variant="secondary"
              size="sm"
              loading={revoke.isPending}
              onClick={async () => {
                try {
                  await revoke.mutateAsync(edge.id);
                  toast({ tone: "success", title: "Delegation revoked" });
                } catch (err) {
                  toast({ tone: "error", title: "Revoke failed", description: errorMessage(err) });
                }
              }}
            >
              Revoke
            </Button>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={confirmTerminate}
        onClose={() => setConfirmTerminate(false)}
        title="Terminate session"
        description="Terminating ends this session and its entire descendant subtree immediately, revoking their authority and subject sessions. This cannot be undone."
        confirmLabel="Terminate"
        tone="danger"
        onConfirm={async () => {
          try {
            await lifecycle.mutateAsync({ id: session.id, action: "terminate" });
            toast({ tone: "info", title: "Session terminated" });
          } catch (err) {
            toast({ tone: "error", title: "Terminate failed", description: errorMessage(err) });
          }
        }}
      />
    </section>
  );
}

// One authority record: stored status with the lapsed marker, outcome, mint time, and
// the audit trail link. Live records carry the revocation controls.
function RecordRow({ zoneId, record, now }: { zoneId: string; record: Session; now: number }) {
  const eff = effectiveStatus(record, now);
  return (
    <li className="border border-border bg-muted/10 px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge tone={statusTone(eff)}>{eff}</Badge>
          {isStaleActive(record, now) ? (
            <Tooltip label="Expired by time - the runtime already rejects it and will reap it to 'expired'.">
              <span
                tabIndex={0}
                className="cursor-help rounded text-[10px] uppercase tracking-wide text-amber-600 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 dark:text-amber-500"
              >
                lapsed
              </span>
            </Tooltip>
          ) : null}
          <span className="truncate font-mono text-[10px] text-muted-foreground" title={record.id}>
            {record.id.slice(0, 8)}…
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span
            className={cx(
              "text-[10px]",
              eff === "revoked" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {sessionOutcome(record, eff)}
          </span>
          <span
            className="text-[10px] text-muted-foreground"
            title={new Date(record.authenticated_at).toLocaleString()}
          >
            {relativeTime(record.authenticated_at, now)}
          </span>
          <Link
            to={appLink("/audit")}
            search={{ session: record.id }}
            className="text-[10px] text-muted-foreground hover:text-foreground hover:underline"
          >
            Audit
          </Link>
        </div>
      </div>
      {eff === "active" ? <AuthorityControls zoneId={zoneId} session={record} /> : null}
    </li>
  );
}

const LEDGER_PREVIEW = 3;

// The raw ledger, last on purpose: one record per token exchange, for auditors who
// need the exact minting history. The drawer previews only the newest records; the
// full history opens in a filterable, paginated dialog so a long-lived subject
// never floods the investigation story.
function RecordsLedger({ zoneId, subject }: { zoneId: string; subject: SubjectSummary }) {
  const [open, setOpen] = useState(false);
  const feed = useSessionsFeed(zoneId, { subject_id: subject.subject_id, limit: LEDGER_PREVIEW });
  const records = (feed.data?.pages[0]?.rows ?? []).slice(0, LEDGER_PREVIEW);
  const now = Date.now();

  return (
    <section className="border-t border-border pt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Authority records
        </h3>
        <span className="text-[10px] text-muted-foreground">one per token exchange</span>
      </div>
      {feed.isLoading ? (
        <Skeleton className="mt-3 h-16 w-full" />
      ) : records.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">No records yet.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {records.map((record) => (
            <RecordRow key={record.id} zoneId={zoneId} record={record} now={now} />
          ))}
        </ul>
      )}
      {subject.total_sessions > LEDGER_PREVIEW ? (
        <Button variant="secondary" size="sm" className="mt-2" onClick={() => setOpen(true)}>
          View all {subject.total_sessions} records
        </Button>
      ) : null}
      {open ? (
        <RecordsModal zoneId={zoneId} subject={subject} onClose={() => setOpen(false)} />
      ) : null}
    </section>
  );
}

// Full record history for one subject in the standard console grid: search by record
// id, filter by stored status, sort by column, and page with the shared pager. The
// pager prefetches the next server batch when the operator reaches the last loaded
// page, so Next keeps walking the feed until history is exhausted.
function RecordsModal({
  zoneId,
  subject,
  onClose,
}: {
  zoneId: string;
  subject: SubjectSummary;
  onClose: () => void;
}) {
  const [status, setStatus] = useState("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(8);
  const feed = useSessionsFeed(zoneId, {
    subject_id: subject.subject_id,
    status: status === "all" ? undefined : status,
    limit: 50,
  });
  const rows = useMemo(() => (feed.data?.pages ?? []).flatMap((p) => p.rows), [feed.data]);
  const now = Date.now();

  useEffect(() => {
    setPage(1);
  }, [status, query, sort, pageSize]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((record) => record.id.toLowerCase().includes(q));
  }, [rows, query]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const accessor: ((record: Session) => string | number) | undefined =
      sort.column === "minted"
        ? (record) => Date.parse(record.authenticated_at)
        : sort.column === "status"
          ? (record) => effectiveStatus(record, now)
          : undefined;
    if (!accessor) return filtered;
    const dir = sort.direction === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = accessor(a);
      const bv = accessor(b);
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [filtered, sort, now]);

  const paged = useMemo(
    () => sorted.slice((page - 1) * pageSize, page * pageSize),
    [sorted, page, pageSize],
  );

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  useEffect(() => {
    if (!feed.hasNextPage || feed.isFetchingNextPage) return;
    if (sorted.length === 0 || page < pageCount) return;
    void feed.fetchNextPage();
  }, [feed, page, pageCount, sorted.length]);

  const columns: Column<Session>[] = [
    {
      id: "status",
      header: "Status",
      sortable: true,
      cell: (record) => {
        const eff = effectiveStatus(record, now);
        return (
          <span className="flex items-center gap-2">
            <Badge tone={statusTone(eff)}>{eff}</Badge>
            {isStaleActive(record, now) ? (
              <Tooltip label="Expired by time - the runtime already rejects it and will reap it to 'expired'.">
                <span
                  tabIndex={0}
                  className="cursor-help rounded text-[10px] uppercase tracking-wide text-amber-600 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 dark:text-amber-500"
                >
                  lapsed
                </span>
              </Tooltip>
            ) : null}
          </span>
        );
      },
    },
    {
      id: "record",
      header: "Record",
      truncate: true,
      cell: (record) => (
        <span
          className="block truncate font-mono text-[11px] text-muted-foreground"
          title={record.id}
        >
          {record.id}
        </span>
      ),
    },
    {
      id: "outcome",
      header: "Outcome",
      cell: (record) => {
        const eff = effectiveStatus(record, now);
        return (
          <span
            className={cx(
              "text-xs",
              eff === "revoked" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {sessionOutcome(record, eff)}
          </span>
        );
      },
    },
    {
      id: "minted",
      header: "Minted",
      sortable: true,
      align: "right",
      cell: (record) => (
        <span
          className="text-xs text-muted-foreground"
          title={new Date(record.authenticated_at).toLocaleString()}
        >
          {relativeTime(record.authenticated_at, now)}
        </span>
      ),
    },
    {
      id: "audit",
      header: "",
      align: "right",
      cell: (record) => (
        <Link
          to={appLink("/audit")}
          search={{ session: record.id }}
          className="text-xs text-muted-foreground hover:text-foreground hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          Audit
        </Link>
      ),
    },
  ];

  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-3xl"
      title={`Authority records · ${subjectDisplayName(subject)}`}
      description={`${subject.total_sessions} total · ${subject.active_sessions} live · ${subject.revoked_sessions} revoked. One record per token exchange; expiry is the normal end of short-lived authority.`}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          placeholder="Search by record id"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search by record id"
          className="w-full sm:w-64"
        />
        <FilterMenu
          groups={[
            {
              id: "status",
              label: "Status",
              value: status,
              onChange: setStatus,
              options: [
                { id: "all", label: "All statuses" },
                { id: "active", label: "Live" },
                { id: "revoked", label: "Revoked" },
                { id: "expired", label: "Expired" },
              ],
            },
          ]}
        />
      </div>
      <div>
        <DataTable
          columns={columns}
          rows={paged}
          rowKey={(record) => record.id}
          loading={feed.isLoading}
          skeletonRows={pageSize}
          sort={sort}
          onSortChange={(column) =>
            setSort((prev) =>
              prev?.column === column
                ? { column, direction: prev.direction === "asc" ? "desc" : "asc" }
                : { column, direction: "asc" },
            )
          }
          empty={
            <EmptyState
              bordered={false}
              title={query.trim() || status !== "all" ? "No matches" : "No records yet"}
              description={
                query.trim() || status !== "all"
                  ? "No records match the current search and filters. Adjust or clear them to see more."
                  : "Records appear as this subject's identity is exchanged for authority."
              }
            />
          }
        />
        {sorted.length > 0 ? (
          <div className="border-x border-b border-border bg-card">
            <Pagination
              page={page}
              pageSize={pageSize}
              total={sorted.length}
              hasMore={Boolean(feed.hasNextPage)}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
            />
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
