/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Audit route.
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
import { Badge, Button, Field, Select, Skeleton, type Column } from "@/components/ui";
import { cx } from "@/lib/cx";
import { ConsoleApiError } from "@/platform/api/client";
import { useAdminAuditFeed, useAuditFeed, useDecisionTrace } from "@/platform/api/hooks";
import type {
  AdminAuditEvent,
  AdminAuditQuery,
  AuditEvent,
  AuditQuery,
} from "@/platform/api/types";

export const Route = createFileRoute("/app/audit")({
  component: AuditRoute,
});

type AuditMode = "decisions" | "admin";

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
        ) : (
          <AdminAuditPage zoneId={zone.id} mode={mode} onMode={setMode} />
        )
      }
    </ZoneScopedPage>
  );
}

function ModeTabs({ mode, onMode }: { mode: AuditMode; onMode: (m: AuditMode) => void }) {
  const tabs: { id: AuditMode; label: string }[] = [
    { id: "decisions", label: "Authority decisions" },
    { id: "admin", label: "Admin changes" },
  ];
  return (
    <div className="flex items-center gap-1.5">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onMode(tab.id)}
          className={cx(
            "inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
            mode === tab.id
              ? "border-foreground/20 bg-accent text-foreground"
              : "border-border text-muted-foreground hover:bg-surface hover:text-foreground",
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
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

// Accepts a relative window (e.g. 15m, 2h, 7d, 30s), an ISO timestamp, or a
// datetime-local value and returns an ISO string the control plane understands.
function parseTimeInput(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  const relative = /^(\d+)\s*(s|m|h|d)$/.exec(text.toLowerCase());
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const ms = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 0;
    return new Date(Date.now() - amount * ms).toISOString();
  }
  const ts = Date.parse(text);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : undefined;
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
      description="Authority decisions and security events recorded in this zone."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Audit" }]}
      rows={rows}
      loading={feed.isLoading}
      columns={columns}
      rowKey={(e) => e.id}
      pageSize={12}
      headerExtra={
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
      sortOptions={[{ id: "recent", label: "Most recent" }]}
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
  return (
    <div className="flex flex-col gap-3 border border-border bg-muted/20 p-3">
      <ModeTabs mode={mode} onMode={onMode} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
          onChange={(e) => onSince(e.target.value)}
        />
        <Field
          label="Until"
          placeholder="15m, 2h, or a date"
          value={until}
          onChange={(e) => onUntil(e.target.value)}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">
          {loaded} event{loaded === 1 ? "" : "s"} loaded
          {hasMore ? " · more available" : ""}
          {live ? " · live" : " · paused"}
        </span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onToggleLive}>
            {live ? "Pause" : "Resume"}
          </Button>
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
    </div>
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
          <div className="truncate text-sm text-foreground">{e.actor_name ?? "—"}</div>
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
              {e.method === "DELETE" ? "deleted" : "—"}
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
      headerExtra={
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
      sortOptions={[{ id: "recent", label: "Most recent" }]}
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
        <DetailField label="Name">{event.actor_name ?? "—"}</DetailField>
        <DetailField label="Scope">{event.actor_scope ?? "—"}</DetailField>
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
          Field values are never stored in the audit log — only which fields changed.
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
  return (
    <div className="flex flex-col gap-3 border border-border bg-muted/20 p-3">
      <ModeTabs mode={mode} onMode={onMode} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
          onChange={(e) => onSince(e.target.value)}
        />
        <Field
          label="Until"
          placeholder="15m, 2h, or a date"
          value={until}
          onChange={(e) => onUntil(e.target.value)}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">
          {loaded} change{loaded === 1 ? "" : "s"} loaded
          {hasMore ? " · more available" : ""}
          {live ? " · live" : " · paused"}
        </span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onToggleLive}>
            {live ? "Pause" : "Resume"}
          </Button>
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
    </div>
  );
}
