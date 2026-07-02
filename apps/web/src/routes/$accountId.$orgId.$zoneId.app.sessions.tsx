/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Sessions route.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

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
  Field,
  Select,
  Skeleton,
  Tooltip,
  useCopyToClipboard,
  type Column,
} from "@/components/ui";
import { cx } from "@/lib/cx";
import { ConsoleApiError } from "@/platform/api/client";
import { useSessionActivity, useSessionsFeed } from "@/platform/api/hooks";
import type { AuditEvent, Session, SessionQuery } from "@/platform/api/types";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/sessions")({
  component: SessionsRoute,
  validateSearch: (search: Record<string, unknown>): { subject?: string } => ({
    subject: typeof search.subject === "string" ? search.subject : undefined,
  }),
});

function SessionsRoute() {
  const { subject } = Route.useSearch();
  return (
    <ZoneScopedPage
      title="Sessions"
      description="Authenticated subject sessions issued in this zone."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Sessions" }]}
    >
      {(zone) => <SessionsPage zoneId={zone.id} initialSubject={subject} />}
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

// Human-readable span between two instants, used to show how long a session held
// authority from authentication to its terminal moment (or to now while it is live).
function formatDuration(ms: number): string {
  const mins = Math.floor(Math.max(0, ms) / 60000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

// The instant a session stopped carrying authority: its revocation time when revoked,
// otherwise its expiry. Live sessions have no terminal instant.
function sessionEnd(session: Session, effective: EffectiveStatus): number | null {
  if (effective === "active") return null;
  if (session.revoked_at) return Date.parse(session.revoked_at);
  return Date.parse(session.expires_at);
}

function sessionDuration(session: Session, effective: EffectiveStatus, now: number): string {
  const start = Date.parse(session.authenticated_at) || Date.parse(session.created_at);
  const end = sessionEnd(session, effective) ?? now;
  return formatDuration(end - start);
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

const AUDIT_EVENT_LABELS: Record<string, string> = {
  token_exchange: "Token issued",
  exchange_denied: "Token denied",
  gateway_resource_request: "Resource call",
  scope_mismatch: "Scope denied",
  rate_limited: "Rate limited",
  replay_detected: "Replay blocked",
  resource_not_found: "Resource missing",
  credential_refresh_failed: "Credential refresh failed",
  policy_eval_failed: "Policy error",
};

function auditEventLabel(eventType: string): string {
  return AUDIT_EVENT_LABELS[eventType] ?? eventType.replace(/_/g, " ");
}

function auditDecisionTone(decision: string | null): "success" | "danger" | "muted" {
  if (decision === "allow") return "success";
  if (decision === "deny") return "danger";
  return "muted";
}

// Pulls the resource/method context out of an audit event's metadata for a one-line summary.
function auditEventContext(event: AuditEvent): string {
  const meta = event.metadata_json ?? {};
  const parts: string[] = [];
  const resource = meta.resource ?? meta.resource_id ?? meta.target;
  const method = meta.method ?? meta.action;
  if (typeof method === "string" && method) parts.push(method);
  if (typeof resource === "string" && resource) parts.push(resource);
  return parts.join(" \u00b7 ");
}

function SessionsPage({ zoneId, initialSubject }: { zoneId: string; initialSubject?: string }) {
  const [status, setStatus] = useState<string>("all");
  const [subject, setSubject] = useState(initialSubject ?? "");

  const serverQuery = useMemo<SessionQuery>(() => {
    const q: SessionQuery = {};
    if (status !== "all") q.status = status;
    if (subject.trim()) q.subject_id = subject.trim();
    return q;
  }, [status, subject]);

  const feed = useSessionsFeed(zoneId, serverQuery);
  const rows = useMemo(() => (feed.data?.pages ?? []).flatMap((page) => page.rows), [feed.data]);
  const now = Date.now();

  const columns: Column<Session>[] = [
    {
      id: "subject",
      header: "Subject",
      sortable: true,
      cell: (s) => (
        <div>
          <div className="font-mono text-xs text-foreground">{s.subject_id}</div>
          <div className="text-xs text-muted-foreground">{s.session_type}</div>
        </div>
      ),
    },
    {
      id: "status",
      header: "Authority",
      cell: (s) => {
        const eff = effectiveStatus(s, now);
        return (
          <div className="flex items-center gap-1.5">
            <Badge tone={statusTone(eff)}>{eff}</Badge>
            {isStaleActive(s, now) ? (
              <Tooltip label="Expired by time - the runtime already rejects it and will reap it to 'expired'.">
                <span
                  tabIndex={0}
                  className="cursor-help rounded text-[10px] uppercase tracking-wide text-amber-600 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 dark:text-amber-500"
                >
                  lapsed
                </span>
              </Tooltip>
            ) : null}
          </div>
        );
      },
    },
    {
      id: "authenticated",
      header: "Authenticated",
      sortable: true,
      cell: (s) => (
        <span className="text-xs text-muted-foreground">
          {new Date(s.authenticated_at).toLocaleString()}
        </span>
      ),
    },
    {
      id: "duration",
      header: "Duration",
      sortable: true,
      cell: (s) => {
        const eff = effectiveStatus(s, now);
        return (
          <span className="text-xs text-muted-foreground" title="Time held from authentication">
            {sessionDuration(s, eff, now)}
            {eff === "active" ? (
              <span className="ml-1 text-muted-foreground/70">so far</span>
            ) : null}
          </span>
        );
      },
    },
    {
      id: "outcome",
      header: "Outcome",
      align: "right",
      sortable: true,
      cell: (s) => {
        const eff = effectiveStatus(s, now);
        const ended = sessionEnd(s, eff);
        return (
          <div className="text-right">
            <div
              className={cx(
                "text-xs",
                eff === "revoked"
                  ? "text-destructive"
                  : eff === "expired"
                    ? "text-amber-600 dark:text-amber-500"
                    : "text-muted-foreground",
              )}
            >
              {sessionOutcome(s, eff)}
            </div>
            {ended ? (
              <div
                className="text-[10px] text-muted-foreground"
                title={new Date(ended).toLocaleString()}
              >
                {relativeTime(new Date(ended).toISOString(), now)}
              </div>
            ) : null}
          </div>
        );
      },
    },
  ];

  return (
    <ResourceWorkspace
      title="Sessions"
      description="Authenticated subject sessions issued in this zone. Sessions end by expiry, grant revocation, or agent termination."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Sessions" }]}
      rows={rows}
      loading={feed.isLoading}
      columns={columns}
      rowKey={(s) => s.id}
      toolbarExtra={
        <SessionFilterBar
          status={status}
          subject={subject}
          loaded={rows.length}
          hasMore={Boolean(feed.hasNextPage)}
          fetchingMore={feed.isFetchingNextPage}
          onStatus={setStatus}
          onSubject={setSubject}
          onLoadMore={() => feed.fetchNextPage()}
        />
      }
      search={{
        placeholder: "Search loaded sessions by subject…",
        match: (s, q) =>
          s.subject_id.toLowerCase().includes(q) || s.session_type.toLowerCase().includes(q),
      }}
      initialSort={{ column: "authenticated", direction: "desc" }}
      sortValues={{
        subject: (s) => s.subject_id.toLowerCase(),
        authenticated: (s) => Date.parse(s.authenticated_at) || 0,
        duration: (s) => {
          const eff = effectiveStatus(s, now);
          const start = Date.parse(s.authenticated_at) || Date.parse(s.created_at);
          return (sessionEnd(s, eff) ?? now) - start;
        },
        outcome: (s) => sessionOutcome(s, effectiveStatus(s, now)).toLowerCase(),
      }}
      empty={{
        title: feed.isError ? "Could not load sessions" : "No sessions",
        description: feed.isError
          ? errorMessage(feed.error)
          : "Sessions appear here once subjects authenticate in this zone.",
      }}
      detail={{
        title: (s) => s.subject_id,
        description: (s) => s.session_type,
        render: (s) => <SessionDetail session={s} zoneId={zoneId} />,
      }}
    />
  );
}

// Server-side session filters and cursor pagination so operators can locate a subject's
// session in enterprise-scale zones instead of scanning only the first page.
function SessionFilterBar({
  status,
  subject,
  loaded,
  hasMore,
  fetchingMore,
  onStatus,
  onSubject,
  onLoadMore,
}: {
  status: string;
  subject: string;
  loaded: number;
  hasMore: boolean;
  fetchingMore: boolean;
  onStatus: (v: string) => void;
  onSubject: (v: string) => void;
  onLoadMore: () => void;
}) {
  const activeFilters = (status !== "all" ? 1 : 0) + (subject.trim() ? 1 : 0);
  return (
    <FeedToolbar
      activeFilters={activeFilters}
      loaded={loaded}
      noun="session"
      hasMore={hasMore}
      fetchingMore={fetchingMore}
      onLoadMore={onLoadMore}
    >
      <Select label="Status" value={status} onChange={(e) => onStatus(e.target.value)}>
        <option value="all">All statuses</option>
        <option value="active">Active</option>
        <option value="revoked">Revoked</option>
        <option value="expired">Expired</option>
      </Select>
      <Field
        label="Subject"
        placeholder="user@example.com"
        value={subject}
        onChange={(e) => onSubject(e.target.value)}
      />
      <p className="text-[11px] text-muted-foreground sm:col-span-2">
        Status filters by the stored value. A session stored as{" "}
        <span className="font-mono">active</span> whose expiry has passed shows as{" "}
        <span className="font-medium">expired</span> here because the runtime already rejects it.
      </p>
    </FeedToolbar>
  );
}

// Copies the raw session object operators would otherwise be unable to extract from the
// structured panel, preserving the full backend record (including zone_id) for debugging
// and sharing.
function CopyJsonButton({ session }: { session: Session }) {
  const copy = useCopyToClipboard();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() =>
        void copy(JSON.stringify(session, null, 2), {
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

function SessionDetail({ session, zoneId }: { session: Session; zoneId: string }) {
  const now = Date.now();
  const eff = effectiveStatus(session, now);
  const stale = isStaleActive(session, now);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge tone={statusTone(eff)}>{eff}</Badge>
          <Badge tone="neutral">{session.session_type}</Badge>
          {stale ? <Badge tone="warning">awaiting reap</Badge> : null}
        </div>
        <CopyJsonButton session={session} />
      </div>

      <AuthoritySummary session={session} effective={eff} stale={stale} now={now} />

      <DetailGroup title="Session">
        <DetailField label="Session ID">
          <CopyValue value={session.id} />
        </DetailField>
        <DetailField label="Subject ID">
          <CopyValue value={session.subject_id} />
        </DetailField>
        {session.parent_id ? (
          <DetailField label="Parent">
            <CopyValue value={session.parent_id} />
          </DetailField>
        ) : null}
      </DetailGroup>

      <DetailGroup title="Lifecycle">
        <DetailField label="Authenticated">
          {new Date(session.authenticated_at).toLocaleString()}
        </DetailField>
        <DetailField label="Created">{new Date(session.created_at).toLocaleString()}</DetailField>
        <DetailField label="Expires">
          {new Date(session.expires_at).toLocaleString()}
          <span className="ml-2 text-xs text-muted-foreground">
            ({relativeTime(session.expires_at, now)})
          </span>
        </DetailField>
        {session.revoked_at ? (
          <DetailField label="Revoked">
            {new Date(session.revoked_at).toLocaleString()}
            <span className="ml-2 text-xs text-muted-foreground">
              ({revocationReasonLabel(session.revoked_reason)})
            </span>
          </DetailField>
        ) : null}
      </DetailGroup>

      <SessionActivity zoneId={zoneId} sessionId={session.id} />

      <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        Sessions are read-only here. They end by expiry, grant revocation, or agent termination. To
        cut off authority now, revoke the delegation or terminate the holding agent.
      </p>
    </div>
  );
}

// Read-only correlation lens. Surfaces the durable audit events keyed to this session -
// token exchanges, resource calls, and authority decisions - so an operator can trace what
// the subject actually did while the session held authority. Payloads are never exposed.
function SessionActivity({ zoneId, sessionId }: { zoneId: string; sessionId: string }) {
  const activity = useSessionActivity(zoneId, sessionId);
  const events = activity.data?.rows ?? [];

  return (
    <section className="border-t border-border pt-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        Activity
      </h3>
      {activity.isLoading ? (
        <Skeleton className="mt-3 h-16 w-full" />
      ) : events.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          No recorded activity yet. Token exchanges, resource calls, and authority decisions for
          this session appear here as the subject acts.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {events.map((event) => {
            const context = auditEventContext(event);
            const latency = event.metadata_json?.latency_ms;
            return (
              <li
                key={event.id}
                className="flex items-start justify-between gap-3 border border-border bg-muted/10 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-foreground">
                      {auditEventLabel(event.event_type)}
                    </span>
                    {event.decision ? (
                      <Badge tone={auditDecisionTone(event.decision)}>{event.decision}</Badge>
                    ) : null}
                  </div>
                  {context ? (
                    <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                      {context}
                    </div>
                  ) : null}
                </div>
                <div className="shrink-0 text-right text-[10px] text-muted-foreground">
                  <div>{relativeTime(event.occurred_at)}</div>
                  {typeof latency === "number" ? <div>{latency}ms</div> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// States the authority this session currently carries, derived from the same rule the
// STS enforces at token mint time, so an operator can trust the console's verdict rather
// than inferring it from a raw status string.
function AuthoritySummary({
  session,
  effective,
  stale,
  now,
}: {
  session: Session;
  effective: EffectiveStatus;
  stale: boolean;
  now: number;
}) {
  if (effective === "active") {
    return (
      <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
        <div className="font-medium">Carries live authority</div>
        <p className="mt-0.5 text-emerald-700/80 dark:text-emerald-400/80">
          This session can mint tokens until it expires {relativeTime(session.expires_at, now)}.
        </p>
      </div>
    );
  }
  if (effective === "revoked") {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        <div className="font-medium">No authority: revoked</div>
        <p className="mt-0.5 text-destructive/80">
          The runtime rejects every exchange for this session. Revocation is irreversible.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
      <div className="font-medium">No authority: expired</div>
      <p className="mt-0.5 text-amber-700/80 dark:text-amber-400/80">
        Expiry passed {relativeTime(session.expires_at, now)}, so the runtime rejects every
        exchange.
        {stale ? " The stored status is still 'active'; it will be reaped to 'expired'." : ""}
      </p>
    </div>
  );
}
