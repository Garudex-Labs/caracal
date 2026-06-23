/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Audit route.
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
import { Badge, Skeleton, type Column } from "@/components/ui";
import { ConsoleApiError } from "@/platform/api/client";
import { useAudit, useDecisionTrace } from "@/platform/api/hooks";
import type { AuditEvent } from "@/platform/api/types";

export const Route = createFileRoute("/app/audit")({
  component: AuditRoute,
});

function AuditRoute() {
  return (
    <ZoneScopedPage
      title="Audit"
      description="Authority decisions and security events recorded in this zone."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Audit" }]}
    >
      {(zone) => <AuditPage zoneId={zone.id} />}
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

function decisionTone(decision: string | null): "success" | "danger" | "warning" | "muted" {
  if (decision === "allow") return "success";
  if (decision === "deny") return "danger";
  if (decision === "partial") return "warning";
  return "muted";
}

function AuditPage({ zoneId }: { zoneId: string }) {
  const query = useAudit(zoneId);
  const rows = query.data ?? [];

  const columns: Column<AuditEvent>[] = [
    {
      id: "event",
      header: "Event",
      cell: (e) => (
        <div>
          <div className="font-medium text-foreground">{e.event_type}</div>
          {e.request_id ? (
            <div className="font-mono text-xs text-muted-foreground">
              {e.request_id.slice(0, 18)}…
            </div>
          ) : null}
        </div>
      ),
    },
    {
      id: "decision",
      header: "Decision",
      cell: (e) =>
        e.decision ? (
          <Badge tone={decisionTone(e.decision)}>{e.decision}</Badge>
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        ),
    },
    {
      id: "status",
      header: "Status",
      cell: (e) => (
        <span className="text-xs text-muted-foreground">{e.evaluation_status ?? "—"}</span>
      ),
    },
    {
      id: "occurred",
      header: "Occurred",
      sortable: true,
      align: "right",
      cell: (e) => (
        <span className="text-xs text-muted-foreground">
          {new Date(e.occurred_at).toLocaleString()}
        </span>
      ),
    },
  ];

  return (
    <ResourceWorkspace
      title="Audit"
      description="Authority decisions and security events recorded in this zone. Showing the latest 100 events."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Audit" }]}
      headerExtra={<LiveBadge label="Live · refreshes every 10s" />}
      rows={rows}
      loading={query.isLoading}
      columns={columns}
      rowKey={(e) => e.id}
      pageSize={12}
      search={{
        placeholder: "Search by event or request ID…",
        match: (e, q) =>
          e.event_type.toLowerCase().includes(q) ||
          (e.request_id ?? "").toLowerCase().includes(q) ||
          (e.evaluation_status ?? "").toLowerCase().includes(q),
      }}
      sortOptions={[{ id: "recent", label: "Most recent" }]}
      empty={{
        title: query.isError ? "Could not load audit" : "No audit events",
        description: query.isError
          ? errorMessage(query.error)
          : "Authority decisions and security events will appear here as traffic flows through this zone.",
      }}
      detail={{
        title: (e) => e.event_type,
        description: (e) => e.request_id ?? e.id,
        width: "max-w-xl",
        render: (e) => <AuditDetailView zoneId={zoneId} event={e} />,
      }}
    />
  );
}

function AuditDetailView({ zoneId, event }: { zoneId: string; event: AuditEvent }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2">
        {event.decision ? (
          <Badge tone={decisionTone(event.decision)}>{event.decision}</Badge>
        ) : null}
        <Badge tone="neutral">{event.event_type}</Badge>
      </div>

      <DetailGroup title="Event">
        <DetailField label="Event ID">
          <Mono>{event.id}</Mono>
        </DetailField>
        {event.request_id ? (
          <DetailField label="Request ID">
            <Mono>{event.request_id}</Mono>
          </DetailField>
        ) : null}
        <DetailField label="Evaluation">{event.evaluation_status ?? "—"}</DetailField>
        <DetailField label="Occurred">{new Date(event.occurred_at).toLocaleString()}</DetailField>
      </DetailGroup>

      {event.metadata_json && Object.keys(event.metadata_json).length > 0 ? (
        <DetailGroup title="Metadata">
          <pre className="mt-2 max-h-48 overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs text-foreground">
            {JSON.stringify(event.metadata_json, null, 2)}
          </pre>
        </DetailGroup>
      ) : null}

      {event.request_id ? <DecisionTraceView zoneId={zoneId} requestId={event.request_id} /> : null}
    </div>
  );
}

function DecisionTraceView({ zoneId, requestId }: { zoneId: string; requestId: string }) {
  const trace = useDecisionTrace(zoneId, requestId);

  return (
    <section className="border-t border-border pt-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        Decision trace
      </h3>
      {trace.isLoading ? (
        <Skeleton className="mt-3 h-16 w-full" />
      ) : trace.isError ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Trace unavailable: {errorMessage(trace.error)}
        </p>
      ) : trace.data ? (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Final decision</span>
            <Badge tone={decisionTone(trace.data.final_decision)}>
              {trace.data.final_decision}
            </Badge>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Events in request</span>
            <span className="text-foreground">{trace.data.events.length}</span>
          </div>
          {trace.data.denied.length > 0 ? (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Denied decisions</span>
              <Badge tone="danger">{trace.data.denied.length}</Badge>
            </div>
          ) : null}
          <ol className="mt-1 flex flex-col gap-1.5">
            {trace.data.events.map((ev) => (
              <li
                key={ev.id}
                className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5 text-xs"
              >
                <span className="font-mono text-foreground">{ev.event_type}</span>
                {ev.decision ? (
                  <Badge tone={decisionTone(ev.decision)}>{ev.decision}</Badge>
                ) : (
                  <span className="text-muted-foreground">{ev.evaluation_status ?? "—"}</span>
                )}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
