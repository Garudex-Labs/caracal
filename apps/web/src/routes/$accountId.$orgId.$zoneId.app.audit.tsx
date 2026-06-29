/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Audit route.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";

import { FeedToolbar } from "@/components/console/FeedToolbar";
import {
  DetailField,
  DetailGroup,
  Mono,
  ResourceWorkspace,
} from "@/components/console/ResourceWorkspace";
import { ZoneScopedPage } from "@/components/console/ZoneScope";
import {
  Badge,
  Button,
  Field,
  Select,
  Skeleton,
  type Column,
  type FilterGroup,
} from "@/components/ui";
import { ConsoleApiError } from "@/platform/api/client";
import { useAdminAuditFeed, useAuditFeed, useDecisionTrace } from "@/platform/api/hooks";
import {
  clearOperatorNotices,
  useOperatorNotices,
  type OperatorNoticeRecord,
  type OperatorNoticeSeverity,
} from "@/platform/state/operatorNotices";
import type {
  AdminAuditEvent,
  AdminAuditQuery,
  AuditDetail,
  AuditEvent,
  AuditQuery,
  DeniedDecision,
} from "@/platform/api/types";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/audit")({
  component: AuditRoute,
  validateSearch: (search: Record<string, unknown>): { focus?: string } => ({
    focus: typeof search.focus === "string" ? search.focus : undefined,
  }),
});

type AuditMode = "decisions" | "admin" | "operator";

function AuditRoute() {
  const [mode, setMode] = useState<AuditMode>("decisions");
  return (
    <ZoneScopedPage
      title="Audit"
      description="Authority decisions and admin changes recorded in this zone."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Audit" }]}
    >
      {(zone) =>
        mode === "decisions" ? (
          <AuditPage zoneId={zone.id} mode={mode} onMode={setMode} />
        ) : mode === "admin" ? (
          <AdminAuditPage zoneId={zone.id} mode={mode} onMode={setMode} />
        ) : (
          <OperatorErrorsPage mode={mode} onMode={setMode} />
        )
      }
    </ZoneScopedPage>
  );
}

function ModeTabs({ mode, onMode }: { mode: AuditMode; onMode: (m: AuditMode) => void }) {
  return (
    <select
      value={mode}
      onChange={(e) => onMode(e.target.value as AuditMode)}
      aria-label="Audit feed"
      className="h-8 cursor-pointer rounded-md border border-border bg-background px-2.5 pr-7 text-xs font-medium text-foreground outline-none transition-colors hover:bg-surface focus:border-ring focus:ring-2 focus:ring-ring/25"
    >
      <option value="decisions">Authority decisions</option>
      <option value="admin">Admin changes</option>
      <option value="operator">Operator errors</option>
    </select>
  );
}

// The Operator notices feed: the session-scoped, client-side log of conditions the Operator
// surfaced (a send with no provider warning, a request that could not be processed error). These
// are client-observed and never sent to the server, so they are read from the shared in-memory
// store rather than a backend feed, and they are not zone-scoped — they cover the whole console
// session. Notices are labelled and coloured by severity, filterable by severity and text, and
// sortable by severity or time.
function severityTone(severity: OperatorNoticeSeverity): "danger" | "warning" {
  return severity === "error" ? "danger" : "warning";
}

function OperatorErrorsPage({ mode, onMode }: { mode: AuditMode; onMode: (m: AuditMode) => void }) {
  const all = useOperatorNotices();
  const [severity, setSeverity] = useState<string>("all");

  const rows = useMemo(
    () => (severity === "all" ? all : all.filter((n) => n.severity === severity)),
    [all, severity],
  );

  const counts = useMemo(() => {
    let errors = 0;
    let warnings = 0;
    for (const n of all) {
      if (n.severity === "error") errors += 1;
      else warnings += 1;
    }
    return { errors, warnings };
  }, [all]);

  const filters: FilterGroup[] = [
    {
      id: "severity",
      label: "Severity",
      value: severity,
      onChange: setSeverity,
      options: [
        { id: "all", label: "All severities", count: all.length },
        { id: "error", label: "Errors", count: counts.errors },
        { id: "warning", label: "Warnings", count: counts.warnings },
      ],
    },
  ];

  const columns: Column<OperatorNoticeRecord>[] = [
    {
      id: "severity",
      header: "Severity",
      sortable: true,
      cell: (e) => <Badge tone={severityTone(e.severity)}>{e.severity}</Badge>,
    },
    {
      id: "message",
      header: "Notice",
      cell: (e) => <div className="text-sm text-foreground">{e.message}</div>,
    },
    {
      id: "occurred",
      header: "Occurred",
      sortable: true,
      align: "right",
      cell: (e) => (
        <span className="text-xs text-muted-foreground">{new Date(e.at).toLocaleString()}</span>
      ),
    },
  ];

  return (
    <ResourceWorkspace
      title="Audit"
      description="Errors and warnings the Operator surfaced during this console session."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Audit" }]}
      rows={rows}
      loading={false}
      columns={columns}
      rowKey={(e) => e.id}
      pageSize={12}
      filters={all.length > 0 ? filters : undefined}
      initialSort={{ column: "occurred", direction: "desc" }}
      sortValues={{
        // Errors sort ahead of warnings when sorting by severity descending.
        severity: (e) => (e.severity === "error" ? 1 : 0),
        occurred: (e) => e.at,
      }}
      toolbarExtra={
        <FeedToolbar
          leading={<ModeTabs mode={mode} onMode={onMode} />}
          activeFilters={severity === "all" ? 0 : 1}
          loaded={rows.length}
          noun="notice"
          hasMore={false}
          fetchingMore={false}
          onLoadMore={() => {}}
        >
          <Button
            variant="secondary"
            onClick={() => clearOperatorNotices()}
            disabled={all.length === 0}
          >
            Clear
          </Button>
        </FeedToolbar>
      }
      search={{
        placeholder: "Filter operator notices…",
        match: (e, q) => e.message.toLowerCase().includes(q) || e.severity.includes(q),
      }}
      empty={{
        title: "No operator notices",
        description:
          "Errors and warnings the Operator surfaces this session — such as sending with no AI provider connected — are recorded here.",
      }}
      detail={{
        title: (e) => `Operator ${e.severity}`,
        description: (e) => new Date(e.at).toLocaleString(),
        width: "max-w-lg",
        render: (e) => (
          <DetailGroup title="Details">
            <DetailField label="Severity">
              <Badge tone={severityTone(e.severity)}>{e.severity}</Badge>
            </DetailField>
            <DetailField label="Message">{e.message}</DetailField>
            <DetailField label="Occurred">{new Date(e.at).toLocaleString()}</DetailField>
          </DetailGroup>
        ),
      }}
    />
  );
}

// An inline audit toolbar designed to sit on the same row as the workspace search box. It
// keeps everything on one line: the feed selector, a Filters button whose labeled fields
// drop into a floating panel, and the live indicator plus cursor control pushed to the right.
function AuditToolbar({
  mode,
  onMode,
  activeFilters,
  loaded,
  noun,
  hasMore,
  fetchingMore,
  live,
  onToggleLive,
  onLoadMore,
  children,
}: {
  mode: AuditMode;
  onMode: (m: AuditMode) => void;
  activeFilters: number;
  loaded: number;
  noun: string;
  hasMore: boolean;
  fetchingMore: boolean;
  live: boolean;
  onToggleLive: () => void;
  onLoadMore: () => void;
  children: ReactNode;
}) {
  return (
    <FeedToolbar
      leading={<ModeTabs mode={mode} onMode={onMode} />}
      activeFilters={activeFilters}
      loaded={loaded}
      noun={noun}
      hasMore={hasMore}
      fetchingMore={fetchingMore}
      live={live}
      onToggleLive={onToggleLive}
      onLoadMore={onLoadMore}
    >
      {children}
    </FeedToolbar>
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

// Accepts a literal "now", a relative window (e.g. 30s, 15m, 2h, 7d, 2w), a canonical ISO
// timestamp, or any other date the platform can parse. Returns an ISO string the control
// plane understands,
// or undefined when the field is blank or the value cannot be parsed.
const TIME_UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};
const RELATIVE_TIME = /^(\d+)\s*(s|m|h|d|w)$/i;
const CANONICAL_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function parseTimeInput(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  if (text.toLowerCase() === "now") return new Date().toISOString();
  const relative = RELATIVE_TIME.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = TIME_UNIT_MS[relative[2]!.toLowerCase()]!;
    return new Date(Date.now() - amount * unit).toISOString();
  }
  if (CANONICAL_ISO.test(text)) return text;
  const ts = Date.parse(text);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : undefined;
}

// Inline feedback parity with the TUI form, which rejects unparseable time input
// rather than silently dropping it.
function timeInputError(value: string): string | undefined {
  return value.trim() && !parseTimeInput(value)
    ? "Enter a relative time like 15m, 2h, 7d, an ISO timestamp, or a date"
    : undefined;
}

function AuditPage({
  zoneId,
  mode,
  onMode,
}: {
  zoneId: string;
  mode: AuditMode;
  onMode: (m: AuditMode) => void;
}) {
  const [decision, setDecision] = useState<string>("all");
  const [eventType, setEventType] = useState("");
  const [requestId, setRequestId] = useState("");
  const [agentSession, setAgentSession] = useState("");
  const [label, setLabel] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [live, setLive] = useState(true);

  const serverQuery = useMemo<AuditQuery>(() => {
    const q: AuditQuery = {};
    if (decision !== "all") q.decision = decision;
    if (eventType.trim()) q.event_type = eventType.trim();
    if (requestId.trim()) q.request_id = requestId.trim();
    if (agentSession.trim()) q.agent_session_id = agentSession.trim();
    if (label.trim()) q.label = label.trim();
    const sinceTs = parseTimeInput(since);
    if (sinceTs) q.since = sinceTs;
    const untilTs = parseTimeInput(until);
    if (untilTs) q.until = untilTs;
    return q;
  }, [decision, eventType, requestId, agentSession, label, since, until]);

  const feed = useAuditFeed(zoneId, serverQuery, live);
  const rows = useMemo(() => (feed.data?.pages ?? []).flatMap((page) => page.rows), [feed.data]);

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
          <span className="text-sm text-muted-foreground">-</span>
        ),
    },
    {
      id: "status",
      header: "Status",
      cell: (e) => (
        <span className="text-xs text-muted-foreground">{e.evaluation_status ?? "-"}</span>
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
      description="Authority decisions and security events recorded in this zone."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Audit" }]}
      rows={rows}
      loading={feed.isLoading}
      columns={columns}
      rowKey={(e) => e.id}
      pageSize={12}
      toolbarExtra={
        <AuditFilterBar
          mode={mode}
          onMode={onMode}
          decision={decision}
          eventType={eventType}
          requestId={requestId}
          agentSession={agentSession}
          label={label}
          since={since}
          until={until}
          live={live}
          loaded={rows.length}
          hasMore={Boolean(feed.hasNextPage)}
          fetchingMore={feed.isFetchingNextPage}
          onDecision={setDecision}
          onEventType={setEventType}
          onRequestId={setRequestId}
          onAgentSession={setAgentSession}
          onLabel={setLabel}
          onSince={setSince}
          onUntil={setUntil}
          onToggleLive={() => setLive((v) => !v)}
          onLoadMore={() => feed.fetchNextPage()}
        />
      }
      search={{
        placeholder: "Filter loaded events by type or request ID…",
        match: (e, q) =>
          e.event_type.toLowerCase().includes(q) ||
          (e.request_id ?? "").toLowerCase().includes(q) ||
          (e.evaluation_status ?? "").toLowerCase().includes(q),
      }}
      empty={{
        title: feed.isError ? "Could not load audit" : "No audit events",
        description: feed.isError
          ? errorMessage(feed.error)
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

// Server-side audit filters keep large zones searchable: filters run against the control
// plane and the cursor "Load more" pulls additional pages on demand, rather than scanning
// only the latest page client-side.
function AuditFilterBar({
  mode,
  onMode,
  decision,
  eventType,
  requestId,
  agentSession,
  label,
  since,
  until,
  live,
  loaded,
  hasMore,
  fetchingMore,
  onDecision,
  onEventType,
  onRequestId,
  onAgentSession,
  onLabel,
  onSince,
  onUntil,
  onToggleLive,
  onLoadMore,
}: {
  mode: AuditMode;
  onMode: (m: AuditMode) => void;
  decision: string;
  eventType: string;
  requestId: string;
  agentSession: string;
  label: string;
  since: string;
  until: string;
  live: boolean;
  loaded: number;
  hasMore: boolean;
  fetchingMore: boolean;
  onDecision: (v: string) => void;
  onEventType: (v: string) => void;
  onRequestId: (v: string) => void;
  onAgentSession: (v: string) => void;
  onLabel: (v: string) => void;
  onSince: (v: string) => void;
  onUntil: (v: string) => void;
  onToggleLive: () => void;
  onLoadMore: () => void;
}) {
  const activeFilters =
    (decision !== "all" ? 1 : 0) +
    [eventType, requestId, agentSession, label, since, until].filter((v) => v.trim()).length;
  return (
    <AuditToolbar
      mode={mode}
      onMode={onMode}
      activeFilters={activeFilters}
      loaded={loaded}
      noun="event"
      hasMore={hasMore}
      fetchingMore={fetchingMore}
      live={live}
      onToggleLive={onToggleLive}
      onLoadMore={onLoadMore}
    >
      <Select label="Decision" value={decision} onChange={(e) => onDecision(e.target.value)}>
        <option value="all">All decisions</option>
        <option value="allow">Allow</option>
        <option value="deny">Deny</option>
        <option value="partial">Partial</option>
      </Select>
      <Field
        label="Event type"
        placeholder="TokenExchange"
        value={eventType}
        onChange={(e) => onEventType(e.target.value)}
      />
      <Field
        label="Request ID"
        placeholder="Correlate one request"
        value={requestId}
        onChange={(e) => onRequestId(e.target.value)}
      />
      <Field
        label="Agent session"
        placeholder="Follow one agent session"
        value={agentSession}
        onChange={(e) => onAgentSession(e.target.value)}
      />
      <Field
        label="Agent label"
        placeholder="Scope to one agent role"
        value={label}
        onChange={(e) => onLabel(e.target.value)}
      />
      <Field
        label="Since"
        placeholder="15m, 2h, 7d, or a date"
        value={since}
        error={timeInputError(since)}
        onChange={(e) => onSince(e.target.value)}
      />
      <Field
        label="Until"
        placeholder="15m, 2h, or a date"
        value={until}
        error={timeInputError(until)}
        onChange={(e) => onUntil(e.target.value)}
      />
    </AuditToolbar>
  );
}

// Copies the raw backend payload to the clipboard so operators can paste full audit
// evidence into tickets.
function CopyJsonButton({ value, label = "Copy JSON" }: { value: unknown; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => {
        void navigator.clipboard?.writeText(JSON.stringify(value, null, 2));
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="mt-2 max-h-48 overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs text-foreground">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function SubHeading({ children }: { children: ReactNode }) {
  return (
    <h4 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
      {children}
    </h4>
  );
}

function AuditDetailView({ zoneId, event }: { zoneId: string; event: AuditEvent }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {event.decision ? (
            <Badge tone={decisionTone(event.decision)}>{event.decision}</Badge>
          ) : null}
          <Badge tone="neutral">{event.event_type}</Badge>
        </div>
        <CopyJsonButton value={event} label="Copy event JSON" />
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
        <DetailField label="Evaluation">{event.evaluation_status ?? "-"}</DetailField>
        <DetailField label="Occurred">{new Date(event.occurred_at).toLocaleString()}</DetailField>
      </DetailGroup>

      {event.metadata_json && Object.keys(event.metadata_json).length > 0 ? (
        <DetailGroup title="Metadata">
          <JsonBlock value={event.metadata_json} />
        </DetailGroup>
      ) : null}

      {event.request_id ? <DecisionTraceView zoneId={zoneId} requestId={event.request_id} /> : null}
    </div>
  );
}

// Full per-event forensic detail: the determining policies, diagnostics, policy-set
// binding, manifest hash, and metadata recorded for one event in the request group.
function TraceEventDetail({ event, index }: { event: AuditDetail; index: number }) {
  const determining = event.determining_policies_json ?? [];
  const diagnostics = event.diagnostics_json ?? [];
  const metadata = event.metadata_json ?? {};
  return (
    <details className="rounded-md border border-border">
      <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-xs">
        <span className="flex items-center gap-2">
          <span className="text-muted-foreground">#{index + 1}</span>
          <span className="font-mono text-foreground">{event.event_type}</span>
        </span>
        {event.decision ? (
          <Badge tone={decisionTone(event.decision)}>{event.decision}</Badge>
        ) : (
          <span className="text-muted-foreground">{event.evaluation_status ?? "-"}</span>
        )}
      </summary>
      <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
        <DetailGroup title="Event">
          <DetailField label="Event ID">
            <Mono>{event.id}</Mono>
          </DetailField>
          <DetailField label="Occurred">{new Date(event.occurred_at).toLocaleString()}</DetailField>
          <DetailField label="Evaluation">{event.evaluation_status ?? "-"}</DetailField>
          {event.policy_set_id ? (
            <DetailField label="Policy set">
              <Mono>{event.policy_set_id}</Mono>
            </DetailField>
          ) : null}
          {event.policy_set_version_id ? (
            <DetailField label="Policy set version">
              <Mono>{event.policy_set_version_id}</Mono>
            </DetailField>
          ) : null}
          {event.manifest_sha ? (
            <DetailField label="Manifest SHA">
              <Mono>{event.manifest_sha}</Mono>
            </DetailField>
          ) : null}
        </DetailGroup>
        {determining.length > 0 ? (
          <div>
            <SubHeading>Determining policies</SubHeading>
            <JsonBlock value={determining} />
          </div>
        ) : null}
        {diagnostics.length > 0 ? (
          <div>
            <SubHeading>Diagnostics</SubHeading>
            <JsonBlock value={diagnostics} />
          </div>
        ) : null}
        {Object.keys(metadata).length > 0 ? (
          <div>
            <SubHeading>Metadata</SubHeading>
            <JsonBlock value={metadata} />
          </div>
        ) : null}
      </div>
    </details>
  );
}

// Denied decisions carry the reconstructed policy input alongside the determining
// policies and diagnostics, which is the core forensic payload for incident response.
function DeniedDecisionDetail({ denied, index }: { denied: DeniedDecision; index: number }) {
  return (
    <details className="rounded-md border border-destructive/30">
      <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-xs">
        <span className="flex items-center gap-2">
          <span className="text-muted-foreground">#{index + 1}</span>
          <span className="font-mono text-foreground">{denied.event_type}</span>
        </span>
        <Badge tone="danger">deny</Badge>
      </summary>
      <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
        <DetailGroup title="Denied">
          <DetailField label="Event ID">
            <Mono>{denied.event_id}</Mono>
          </DetailField>
          <DetailField label="Evaluation">{denied.evaluation_status ?? "-"}</DetailField>
        </DetailGroup>
        <div>
          <SubHeading>Policy input</SubHeading>
          <JsonBlock value={denied.policy_input} />
        </div>
        {denied.determining_policies.length > 0 ? (
          <div>
            <SubHeading>Determining policies</SubHeading>
            <JsonBlock value={denied.determining_policies} />
          </div>
        ) : null}
        {denied.diagnostics.length > 0 ? (
          <div>
            <SubHeading>Diagnostics</SubHeading>
            <JsonBlock value={denied.diagnostics} />
          </div>
        ) : null}
        {Object.keys(denied.metadata).length > 0 ? (
          <div>
            <SubHeading>Metadata</SubHeading>
            <JsonBlock value={denied.metadata} />
          </div>
        ) : null}
      </div>
    </details>
  );
}

function DecisionTraceView({ zoneId, requestId }: { zoneId: string; requestId: string }) {
  const trace = useDecisionTrace(zoneId, requestId);

  return (
    <section className="border-t border-border pt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Decision trace
        </h3>
        {trace.data ? <CopyJsonButton value={trace.data} label="Copy trace JSON" /> : null}
      </div>
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

          <div className="mt-1 flex flex-col gap-1.5">
            <SubHeading>Events</SubHeading>
            {trace.data.events.map((ev, i) => (
              <TraceEventDetail key={ev.id} event={ev} index={i} />
            ))}
          </div>

          {trace.data.denied.length > 0 ? (
            <div className="mt-1 flex flex-col gap-1.5">
              <SubHeading>Denied decisions</SubHeading>
              {trace.data.denied.map((d, i) => (
                <DeniedDecisionDetail key={d.event_id} denied={d} index={i} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/* ----------------------------- admin changes ----------------------------- */

const ADMIN_METHODS = ["", "POST", "PUT", "PATCH", "DELETE"];

function methodTone(method: string): "success" | "danger" | "warning" | "neutral" {
  if (method === "POST") return "success";
  if (method === "DELETE") return "danger";
  if (method === "PATCH" || method === "PUT") return "warning";
  return "neutral";
}

function statusTone(status: number): "success" | "danger" | "warning" {
  if (status >= 500) return "danger";
  if (status >= 400) return "warning";
  return "success";
}

function changedFields(payload: Record<string, unknown> | null): string[] {
  const fields = payload?.changed_fields;
  return Array.isArray(fields) ? fields.filter((f): f is string => typeof f === "string") : [];
}

function AdminAuditPage({
  zoneId,
  mode,
  onMode,
}: {
  zoneId: string;
  mode: AuditMode;
  onMode: (m: AuditMode) => void;
}) {
  const [entityType, setEntityType] = useState("");
  const [actorId, setActorId] = useState("");
  const [method, setMethod] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [live, setLive] = useState(true);

  const serverQuery = useMemo<AdminAuditQuery>(() => {
    const q: AdminAuditQuery = {};
    if (entityType.trim()) q.entity_type = entityType.trim();
    if (actorId.trim()) q.actor_id = actorId.trim();
    if (method) q.method = method;
    const sinceTs = parseTimeInput(since);
    if (sinceTs) q.since = sinceTs;
    const untilTs = parseTimeInput(until);
    if (untilTs) q.until = untilTs;
    return q;
  }, [entityType, actorId, method, since, until]);

  const feed = useAdminAuditFeed(zoneId, serverQuery, live);
  const rows = useMemo(() => (feed.data?.pages ?? []).flatMap((page) => page.rows), [feed.data]);

  const columns: Column<AdminAuditEvent>[] = [
    {
      id: "action",
      header: "Change",
      cell: (e) => (
        <div className="flex items-center gap-2">
          <Badge tone={methodTone(e.method)}>{e.method}</Badge>
          <div className="min-w-0">
            <div className="truncate font-mono text-xs text-foreground">{e.path}</div>
            {e.entity_type ? (
              <div className="truncate text-[11px] text-muted-foreground">
                {e.entity_type}
                {e.entity_id ? ` · ${e.entity_id}` : ""}
              </div>
            ) : null}
          </div>
        </div>
      ),
    },
    {
      id: "actor",
      header: "Actor",
      cell: (e) => (
        <div className="min-w-0">
          <div className="truncate text-sm text-foreground">{e.actor_name ?? "-"}</div>
          <div className="truncate text-[11px] text-muted-foreground">{e.actor_scope ?? ""}</div>
        </div>
      ),
    },
    {
      id: "fields",
      header: "Fields",
      cell: (e) => {
        const fields = changedFields(e.payload_json);
        const secret = e.payload_json?.secret_rotated === true;
        if (fields.length === 0 && !secret) {
          return (
            <span className="text-xs text-muted-foreground">
              {e.method === "DELETE" ? "deleted" : "-"}
            </span>
          );
        }
        return (
          <div className="flex flex-wrap gap-1">
            {fields.slice(0, 4).map((f) => (
              <span
                key={f}
                className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
              >
                {f}
              </span>
            ))}
            {fields.length > 4 ? (
              <span className="text-[11px] text-muted-foreground">+{fields.length - 4}</span>
            ) : null}
            {secret ? <Badge tone="warning">secret rotated</Badge> : null}
          </div>
        );
      },
    },
    {
      id: "status",
      header: "Status",
      cell: (e) => <Badge tone={statusTone(e.status_code)}>{e.status_code}</Badge>,
    },
    {
      id: "occurred",
      header: "Occurred",
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
      description="Tamper-evident record of every admin change in this zone."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Audit" }]}
      rows={rows}
      loading={feed.isLoading}
      columns={columns}
      rowKey={(e) => e.id}
      pageSize={12}
      toolbarExtra={
        <AdminAuditFilterBar
          mode={mode}
          onMode={onMode}
          entityType={entityType}
          actorId={actorId}
          method={method}
          since={since}
          until={until}
          live={live}
          loaded={rows.length}
          hasMore={Boolean(feed.hasNextPage)}
          fetchingMore={feed.isFetchingNextPage}
          onEntityType={setEntityType}
          onActorId={setActorId}
          onMethod={setMethod}
          onSince={setSince}
          onUntil={setUntil}
          onToggleLive={() => setLive((v) => !v)}
          onLoadMore={() => feed.fetchNextPage()}
        />
      }
      search={{
        placeholder: "Filter loaded changes by path, actor, or entity…",
        match: (e, q) =>
          e.path.toLowerCase().includes(q) ||
          (e.actor_name ?? "").toLowerCase().includes(q) ||
          (e.entity_type ?? "").toLowerCase().includes(q) ||
          (e.entity_id ?? "").toLowerCase().includes(q),
      }}
      empty={{
        title: feed.isError ? "Could not load admin changes" : "No admin changes",
        description: feed.isError
          ? errorMessage(feed.error)
          : "Every create, update, and delete an operator performs in this zone will appear here.",
      }}
      detail={{
        title: (e) => `${e.method} ${e.entity_type ?? "change"}`,
        description: (e) => e.path,
        width: "max-w-xl",
        render: (e) => <AdminAuditDetailView event={e} />,
      }}
    />
  );
}

function AdminAuditDetailView({ event }: { event: AdminAuditEvent }) {
  const fields = changedFields(event.payload_json);
  const secret = event.payload_json?.secret_rotated === true;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={methodTone(event.method)}>{event.method}</Badge>
        <Badge tone={statusTone(event.status_code)}>{event.status_code}</Badge>
        <Badge tone={event.signed ? "success" : "muted"}>
          {event.signed ? "Chain signed" : "Hash linked"}
        </Badge>
      </div>

      <DetailGroup title="Change">
        <DetailField label="Action">
          <Mono>{event.action}</Mono>
        </DetailField>
        {event.entity_type ? (
          <DetailField label="Entity">
            {event.entity_type}
            {event.entity_id ? ` · ${event.entity_id}` : ""}
          </DetailField>
        ) : null}
        <DetailField label="Occurred">{new Date(event.occurred_at).toLocaleString()}</DetailField>
        {event.chain_seq !== null ? (
          <DetailField label="Chain sequence">#{event.chain_seq}</DetailField>
        ) : null}
      </DetailGroup>

      <DetailGroup title="Actor">
        <DetailField label="Name">{event.actor_name ?? "-"}</DetailField>
        <DetailField label="Scope">{event.actor_scope ?? "-"}</DetailField>
        {event.actor_id ? (
          <DetailField label="Actor ID">
            <Mono>{event.actor_id}</Mono>
          </DetailField>
        ) : null}
        {event.request_id ? (
          <DetailField label="Request ID">
            <Mono>{event.request_id}</Mono>
          </DetailField>
        ) : null}
      </DetailGroup>

      <section className="border-t border-border pt-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Touched fields
        </h3>
        {fields.length > 0 || secret ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {fields.map((f) => (
              <span
                key={f}
                className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
              >
                {f}
              </span>
            ))}
            {secret ? <Badge tone="warning">secret rotated</Badge> : null}
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            {event.method === "DELETE" ? "Entity deleted." : "No field changes recorded."}
          </p>
        )}
        <p className="mt-3 text-[11px] text-muted-foreground">
          Field values are never stored in the audit log, only which fields changed.
        </p>
      </section>
    </div>
  );
}

function AdminAuditFilterBar({
  mode,
  onMode,
  entityType,
  actorId,
  method,
  since,
  until,
  live,
  loaded,
  hasMore,
  fetchingMore,
  onEntityType,
  onActorId,
  onMethod,
  onSince,
  onUntil,
  onToggleLive,
  onLoadMore,
}: {
  mode: AuditMode;
  onMode: (m: AuditMode) => void;
  entityType: string;
  actorId: string;
  method: string;
  since: string;
  until: string;
  live: boolean;
  loaded: number;
  hasMore: boolean;
  fetchingMore: boolean;
  onEntityType: (v: string) => void;
  onActorId: (v: string) => void;
  onMethod: (v: string) => void;
  onSince: (v: string) => void;
  onUntil: (v: string) => void;
  onToggleLive: () => void;
  onLoadMore: () => void;
}) {
  const activeFilters =
    (method ? 1 : 0) + [entityType, actorId, since, until].filter((v) => v.trim()).length;
  return (
    <AuditToolbar
      mode={mode}
      onMode={onMode}
      activeFilters={activeFilters}
      loaded={loaded}
      noun="change"
      hasMore={hasMore}
      fetchingMore={fetchingMore}
      live={live}
      onToggleLive={onToggleLive}
      onLoadMore={onLoadMore}
    >
      <Select label="Method" value={method} onChange={(e) => onMethod(e.target.value)}>
        {ADMIN_METHODS.map((m) => (
          <option key={m || "all"} value={m}>
            {m || "All methods"}
          </option>
        ))}
      </Select>
      <Field
        label="Entity type"
        placeholder="applications, resources…"
        value={entityType}
        onChange={(e) => onEntityType(e.target.value)}
      />
      <Field
        label="Actor ID"
        placeholder="Admin token id"
        value={actorId}
        onChange={(e) => onActorId(e.target.value)}
      />
      <Field
        label="Since"
        placeholder="15m, 2h, 7d, or a date"
        value={since}
        error={timeInputError(since)}
        onChange={(e) => onSince(e.target.value)}
      />
      <Field
        label="Until"
        placeholder="15m, 2h, or a date"
        value={until}
        error={timeInputError(until)}
        onChange={(e) => onUntil(e.target.value)}
      />
    </AuditToolbar>
  );
}
