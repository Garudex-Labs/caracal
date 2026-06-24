/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Sessions route.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import {
  DetailField,
  DetailGroup,
  Mono,
  ResourceWorkspace,
} from "@/components/console/ResourceWorkspace";
import { ZoneScopedPage } from "@/components/console/ZoneScope";
import { Badge, Button, Field, Select, type Column } from "@/components/ui";
import { ConsoleApiError } from "@/platform/api/client";
import { useSessionsFeed } from "@/platform/api/hooks";
import type { Session, SessionQuery } from "@/platform/api/types";

export const Route = createFileRoute("/app/sessions")({
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
// reaper only flips orphaned (zone-deleted) sessions to expired — a session whose
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
// awaiting reaping — worth flagging so operators understand the record/runtime drift.
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

  const columns: Column<Session>[] = [
    {
      id: "subject",
      header: "Subject",
      cell: (s) => (
        <div>
          <div className="font-mono text-xs text-foreground">{s.subject_id}</div>
          <div className="text-xs text-muted-foreground">{s.session_type}</div>
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: (s) => <Badge tone={statusTone(s.status)}>{s.status}</Badge>,
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
      id: "expires",
      header: "Expires",
      align: "right",
      cell: (s) => (
        <span className="text-xs text-muted-foreground">
          {new Date(s.expires_at).toLocaleString()}
        </span>
      ),
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
      headerExtra={
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
      sortOptions={[
        { id: "recent", label: "Most recent" },
        { id: "subject", label: "Subject" },
      ]}
      empty={{
        title: feed.isError ? "Could not load sessions" : "No sessions",
        description: feed.isError
          ? errorMessage(feed.error)
          : "Sessions appear here once subjects authenticate in this zone.",
      }}
      detail={{
        title: (s) => s.subject_id,
        description: (s) => s.session_type,
        render: (s) => <SessionDetail session={s} />,
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
  return (
    <div className="flex flex-col gap-3 border border-border bg-muted/20 p-3">
      <div className="grid gap-3 sm:grid-cols-2">
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
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">
          {loaded} session{loaded === 1 ? "" : "s"} loaded{hasMore ? " · more available" : ""}
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={onLoadMore}
          disabled={!hasMore}
          loading={fetchingMore}
        >
          {hasMore ? "Load more" : "All loaded"}
        </Button>
      </div>
    </div>
  );
}

function SessionDetail({ session }: { session: Session }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <Badge tone={statusTone(session.status)}>{session.status}</Badge>
        <Badge tone="neutral">{session.session_type}</Badge>
      </div>

      <DetailGroup title="Session">
        <DetailField label="Session ID">
          <Mono>{session.id}</Mono>
        </DetailField>
        <DetailField label="Subject ID">
          <Mono>{session.subject_id}</Mono>
        </DetailField>
        {session.parent_id ? (
          <DetailField label="Parent">
            <Mono>{session.parent_id}</Mono>
          </DetailField>
        ) : null}
      </DetailGroup>

      <DetailGroup title="Lifecycle">
        <DetailField label="Authenticated">
          {new Date(session.authenticated_at).toLocaleString()}
        </DetailField>
        <DetailField label="Created">{new Date(session.created_at).toLocaleString()}</DetailField>
        <DetailField label="Expires">{new Date(session.expires_at).toLocaleString()}</DetailField>
      </DetailGroup>

      <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        Sessions are read-only here. They end by expiry, grant revocation, or agent termination.
      </p>
    </div>
  );
}
