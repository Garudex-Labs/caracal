/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Sessions route.
*/
import { createFileRoute } from "@tanstack/react-router";

import {
  DetailField,
  DetailGroup,
  Mono,
  ResourceWorkspace,
} from "@/components/console/ResourceWorkspace";
import { LiveBadge } from "@/components/console/LiveBadge";
import { ZoneScopedPage } from "@/components/console/ZoneScope";
import { Badge, type Column } from "@/components/ui";
import { ConsoleApiError } from "@/platform/api/client";
import { useSessions } from "@/platform/api/hooks";
import type { Session } from "@/platform/api/types";

export const Route = createFileRoute("/app/sessions")({
  component: SessionsRoute,
});

function SessionsRoute() {
  return (
    <ZoneScopedPage
      title="Sessions"
      description="Authenticated subject sessions issued in this zone."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Sessions" }]}
    >
      {(zone) => <SessionsPage zoneId={zone.id} />}
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

function statusTone(status: string): "success" | "muted" | "danger" {
  if (status === "active") return "success";
  if (status === "revoked") return "danger";
  return "muted";
}

function SessionsPage({ zoneId }: { zoneId: string }) {
  const query = useSessions(zoneId);
  const rows = query.data ?? [];

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
      headerExtra={<LiveBadge label="Live · refreshes every 10s" />}
      rows={rows}
      loading={query.isLoading}
      columns={columns}
      rowKey={(s) => s.id}
      search={{
        placeholder: "Search by subject…",
        match: (s, q) =>
          s.subject_id.toLowerCase().includes(q) || s.session_type.toLowerCase().includes(q),
      }}
      sortOptions={[
        { id: "recent", label: "Most recent" },
        { id: "subject", label: "Subject" },
      ]}
      empty={{
        title: query.isError ? "Could not load sessions" : "No sessions",
        description: query.isError
          ? errorMessage(query.error)
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
