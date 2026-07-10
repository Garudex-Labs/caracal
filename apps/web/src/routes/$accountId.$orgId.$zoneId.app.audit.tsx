/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Audit route.
*/
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";

import { CreatedBy } from "@/components/console/CreatedBy";
import { FeedTabs, FeedToolbar } from "@/components/console/FeedToolbar";
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
  Modal,
  Select,
  Skeleton,
  useCopyToClipboard,
  type Column,
} from "@/components/ui";
import {
  AUDIT_CATEGORIES,
  auditDelegationChain,
  auditEntities,
  auditEventLabel,
  auditReason,
  auditSummary,
  type AuditEntity,
} from "@/lib/auditPresentation";
import { ConsoleApiError } from "@/platform/api/client";
import {
  useAdminAuditFeed,
  useApplications,
  useAuditFeed,
  useDecisionTrace,
  usePolicySets,
  usePolicySetVersions,
} from "@/platform/api/hooks";
import { config } from "@/platform/config";
import { appLink } from "@/platform/nav/appLink";
import type {
  AdminAuditEvent,
  AdminAuditQuery,
  Application,
  AuditDetail,
  AuditEvent,
  AuditQuery,
  DeniedDecision,
} from "@/platform/api/types";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/audit")({
  component: AuditRoute,
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    view?: "activity" | "admin";
    focus?: string;
    request?: string;
    sessionId?: string;
    application?: string;
    authorityRecordId?: string;
  } => ({
    view: search.view === "admin" ? "admin" : search.view === "activity" ? "activity" : undefined,
    focus: typeof search.focus === "string" ? search.focus : undefined,
    request: typeof search.request === "string" ? search.request : undefined,
    sessionId: typeof search.sessionId === "string" ? search.sessionId : undefined,
    application: typeof search.application === "string" ? search.application : undefined,
    authorityRecordId:
      typeof search.authorityRecordId === "string" ? search.authorityRecordId : undefined,
  }),
});

type AuditMode = "activity" | "admin";

function AuditRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const mode: AuditMode = search.view === "admin" ? "admin" : "activity";
  const onMode = (m: AuditMode) =>
    navigate({
      search: { view: m === "admin" ? m : undefined },
      replace: true,
    });
  return (
    <ZoneScopedPage
      title="Audit"
      description="Authority decisions and admin changes recorded in this zone."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Audit" }]}
    >
      {(zone) =>
        mode === "activity" ? (
          <AuditPage
            zoneId={zone.id}
            mode={mode}
            onMode={onMode}
            initial={{
              request: search.request,
              sessionId: search.sessionId,
              application: search.application,
              authorityRecordId: search.authorityRecordId,
            }}
          />
        ) : (
          <AdminAuditPage zoneId={zone.id} mode={mode} onMode={onMode} />
        )
      }
    </ZoneScopedPage>
  );
}

const MODE_TABS: { id: AuditMode; label: string }[] = [
  { id: "activity", label: "Activity" },
  { id: "admin", label: "Admin changes" },
];

// An inline audit toolbar designed to sit on the same row as the workspace search box. It
// keeps everything on one line: a Filters button whose labeled fields drop into a floating
// panel, an export control, and the loaded count plus feed tabs pushed to the right.
function AuditToolbar({
  mode,
  onMode,
  exportControl,
  activeFilters,
  loaded,
  noun,
  children,
}: {
  mode: AuditMode;
  onMode: (m: AuditMode) => void;
  exportControl?: ReactNode;
  activeFilters: number;
  loaded: number;
  noun: string;
  children: ReactNode;
}) {
  return (
    <FeedToolbar
      extra={exportControl}
      trailing={<FeedTabs tabs={MODE_TABS} value={mode} onChange={onMode} label="Audit feed" />}
      activeFilters={activeFilters}
      loaded={loaded}
      noun={noun}
    >
      {children}
    </FeedToolbar>
  );
}

// Exportable fields mirror the control plane's export whitelist for each feed, so the
// column picker and the server projection can never drift apart silently.
const ACTIVITY_EXPORT_FIELDS: { id: string; label: string; core?: boolean }[] = [
  { id: "occurred_at", label: "Occurred at", core: true },
  { id: "event_type", label: "Event type", core: true },
  { id: "decision", label: "Decision", core: true },
  { id: "evaluation_status", label: "Evaluation status" },
  { id: "request_id", label: "Request ID", core: true },
  { id: "trace_id", label: "Trace ID" },
  { id: "id", label: "Event ID" },
  { id: "application_id", label: "Application ID", core: true },
  { id: "application_name", label: "Application name", core: true },
  { id: "resource", label: "Resource", core: true },
  { id: "provider_id", label: "Provider ID" },
  { id: "connection_id", label: "Connection ID" },
  { id: "requested_scopes", label: "Requested scopes" },
  { id: "reason", label: "Denial reason", core: true },
  { id: "agent_session_id", label: "Session ID" },
  { id: "agent_lifecycle", label: "Session lifecycle" },
  { id: "agent_labels", label: "Session labels" },
  { id: "delegation_edge_id", label: "Delegation" },
  { id: "delegation_hop_count", label: "Delegation hops" },
  { id: "method", label: "HTTP method" },
  { id: "latency_ms", label: "Latency (ms)" },
  { id: "upstream_status", label: "Upstream status" },
  { id: "upstream_host", label: "Upstream host" },
  { id: "gateway_status", label: "Gateway status" },
  { id: "result_class", label: "Result class" },
  { id: "error_kind", label: "Error kind" },
  { id: "response_bytes", label: "Response bytes" },
  { id: "auth_mode", label: "Auth mode" },
  { id: "subject_fingerprint", label: "Subject fingerprint" },
  { id: "subject", label: "Subject" },
  { id: "authorized_by", label: "Authorized by" },
  { id: "command", label: "Command" },
  { id: "subcommand", label: "Subcommand" },
  { id: "challenge_id", label: "Approval hold" },
  { id: "tier", label: "Approval tier" },
  { id: "approver_class", label: "Approver class" },
  { id: "privacy_mode", label: "Privacy mode" },
  { id: "approver_subject_id", label: "Approver subject" },
  { id: "ingested_at", label: "Ingested at" },
];

const ADMIN_EXPORT_FIELDS: { id: string; label: string; core?: boolean }[] = [
  { id: "occurred_at", label: "Occurred at", core: true },
  { id: "action", label: "Action", core: true },
  { id: "method", label: "Method", core: true },
  { id: "path", label: "Path", core: true },
  { id: "entity_type", label: "Entity type", core: true },
  { id: "entity_id", label: "Entity ID", core: true },
  { id: "status_code", label: "Status code", core: true },
  { id: "actor_id", label: "Actor ID" },
  { id: "actor_name", label: "Actor name", core: true },
  { id: "actor_scope", label: "Actor scope" },
  { id: "change_kind", label: "Change kind" },
  { id: "changed_fields", label: "Changed fields" },
  { id: "request_id", label: "Request ID" },
  { id: "chain_seq", label: "Chain sequence" },
  { id: "signed", label: "Chain signed" },
  { id: "id", label: "Event ID" },
];

// Downloads a filtered slice of the feed straight from the control plane, letting the
// operator pick exactly which columns, how many rows, and which format leave the zone.
function ExportDialog({
  zoneId,
  feed,
  fields,
  query,
}: {
  zoneId: string;
  feed: "audit" | "admin-audit";
  fields: { id: string; label: string; core?: boolean }[];
  query: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<"csv" | "json">("csv");
  const [limit, setLimit] = useState("500");
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(fields.filter((f) => f.core).map((f) => f.id)),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function download() {
    setPending(true);
    setError(null);
    try {
      const ordered = fields.filter((f) => selected.has(f.id)).map((f) => f.id);
      const params = new URLSearchParams(query);
      params.set("fields", ordered.join(","));
      params.set("limit", String(Math.min(Math.max(Number(limit) || 500, 1), 1000)));
      if (format === "csv") params.set("format", "csv");
      const res = await fetch(
        `${config.consoleBaseUrl}/v1/zones/${zoneId}/${feed}?${params.toString()}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error(`export_failed_${res.status}`);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      let blob: Blob;
      if (format === "csv") {
        blob = await res.blob();
      } else {
        const body = (await res.json()) as { items: unknown[] };
        blob = new Blob([JSON.stringify(body.items, null, 2)], { type: "application/json" });
      }
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${feed}-${stamp}.${format}`;
      anchor.click();
      URL.revokeObjectURL(url);
      setOpen(false);
    } catch {
      setError("Export failed. Check the control plane connection and try again.");
    } finally {
      setPending(false);
    }
  }

  const noun = feed === "audit" ? "events" : "changes";
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label={`Export ${noun}`}
        title={`Export ${noun}`}
        className="grid h-9 w-9 place-items-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 3v12" />
          <path d="m7 10 5 5 5-5" />
          <path d="M5 21h14" />
        </svg>
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Export ${noun}`}
        description="Exports honor the active filters and time range. Pick the columns and format for your SIEM or evidence bundle; secrets are always redacted before leaving the zone."
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void download()} disabled={pending || selected.size === 0}>
              {pending ? "Exporting…" : "Download"}
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label="Format"
            value={format}
            onChange={(e) => setFormat(e.target.value as "csv" | "json")}
          >
            <option value="csv">CSV</option>
            <option value="json">JSON</option>
          </Select>
          <Field
            label="Max rows"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            placeholder="500"
          />
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Columns
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setSelected(new Set(fields.map((f) => f.id)))}
              >
                All
              </button>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setSelected(new Set(fields.filter((f) => f.core).map((f) => f.id)))}
              >
                Core
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {fields.map((f) => (
              <label
                key={f.id}
                className="flex cursor-pointer items-center gap-2 text-xs text-foreground"
              >
                <input
                  type="checkbox"
                  checked={selected.has(f.id)}
                  onChange={() => toggle(f.id)}
                  className="h-3.5 w-3.5 accent-foreground"
                />
                {f.label}
              </label>
            ))}
          </div>
        </div>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </Modal>
    </>
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
  if (decision === "allow" || decision === "approved" || decision === "consumed") return "success";
  if (decision === "deny" || decision === "rejected") return "danger";
  if (decision === "partial" || decision === "pending") return "warning";
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
  initial,
}: {
  zoneId: string;
  mode: AuditMode;
  onMode: (m: AuditMode) => void;
  initial: {
    request?: string;
    sessionId?: string;
    application?: string;
    authorityRecordId?: string;
  };
}) {
  const [category, setCategory] = useState<string>("all");
  const [decision, setDecision] = useState<string>("all");
  const [eventType, setEventType] = useState("");
  const [requestId, setRequestId] = useState(initial.request ?? "");
  const [applicationId, setApplicationId] = useState(initial.application ?? "");
  const [sessionId, setSessionId] = useState(initial.sessionId ?? "");
  const [authorityRecordId, setAuthorityRecordId] = useState(initial.authorityRecordId ?? "");
  const [label, setLabel] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");

  const serverQuery = useMemo<AuditQuery>(() => {
    const q: AuditQuery = {};
    if (decision !== "all") q.decision = decision;
    // An explicit event type is the narrower filter and wins over the category's type list.
    if (eventType.trim()) q.event_type = eventType.trim();
    else if (category !== "all") {
      const domain = AUDIT_CATEGORIES.find((c) => c.id === category);
      if (domain) q.event_type = domain.types.join(",");
    }
    if (requestId.trim()) q.request_id = requestId.trim();
    if (applicationId.trim()) q.application_id = applicationId.trim();
    if (sessionId.trim()) q.agent_session_id = sessionId.trim();
    if (authorityRecordId.trim()) q.session_id = authorityRecordId.trim();
    if (label.trim()) q.label = label.trim();
    const sinceTs = parseTimeInput(since);
    if (sinceTs) q.since = sinceTs;
    const untilTs = parseTimeInput(until);
    if (untilTs) q.until = untilTs;
    return q;
  }, [
    category,
    decision,
    eventType,
    requestId,
    applicationId,
    sessionId,
    authorityRecordId,
    label,
    since,
    until,
  ]);

  const feed = useAuditFeed(zoneId, serverQuery);
  const rows = useMemo(() => (feed.data?.pages ?? []).flatMap((page) => page.rows), [feed.data]);

  // Application names resolve actor ids into readable identities; token events carry the
  // name in metadata, gateway and control events only the id.
  const apps = useApplications(zoneId);
  const appNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const app of apps.data ?? []) map.set(app.id, app.name);
    return map;
  }, [apps.data]);

  const actorName = (e: AuditEvent): string | null => {
    const meta = e.metadata_json ?? {};
    const name = typeof meta.application_name === "string" ? meta.application_name : null;
    const id =
      typeof meta.application_id === "string"
        ? meta.application_id
        : typeof meta.client_id === "string"
          ? meta.client_id
          : null;
    return name ?? (id ? (appNames.get(id) ?? id) : null);
  };

  const columns: Column<AuditEvent>[] = [
    {
      id: "event",
      header: "Event",
      cell: (e) => (
        <div className="min-w-0">
          <div className="font-medium text-foreground">
            {auditEventLabel(e.event_type, e.decision)}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {auditSummary(e, actorName(e))}
          </div>
        </div>
      ),
    },
    {
      id: "actor",
      header: "Actor",
      cell: (e) => {
        const name = actorName(e);
        return name ? (
          <span className="truncate text-sm text-foreground">{name}</span>
        ) : (
          <span className="text-sm text-muted-foreground">-</span>
        );
      },
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
      feed={{
        hasMore: Boolean(feed.hasNextPage),
        fetching: feed.isFetchingNextPage,
        loadMore: () => feed.fetchNextPage(),
      }}
      toolbarExtra={
        <AuditFilterBar
          mode={mode}
          onMode={onMode}
          exportControl={
            <ExportDialog
              zoneId={zoneId}
              feed="audit"
              fields={ACTIVITY_EXPORT_FIELDS}
              query={Object.fromEntries(
                Object.entries(serverQuery).map(([k, v]) => [k, String(v)]),
              )}
            />
          }
          category={category}
          decision={decision}
          eventType={eventType}
          requestId={requestId}
          applicationId={applicationId}
          applications={apps.data ?? []}
          sessionId={sessionId}
          authorityRecordId={authorityRecordId}
          label={label}
          since={since}
          until={until}
          loaded={rows.length}
          onCategory={setCategory}
          onDecision={setDecision}
          onEventType={setEventType}
          onRequestId={setRequestId}
          onApplicationId={setApplicationId}
          onSessionId={setSessionId}
          onAuthorityRecordId={setAuthorityRecordId}
          onLabel={setLabel}
          onSince={setSince}
          onUntil={setUntil}
        />
      }
      search={{
        placeholder: "Filter loaded events by actor, resource, or request…",
        match: (e, q) => {
          const meta = e.metadata_json ?? {};
          return (
            e.id.toLowerCase().includes(q) ||
            e.event_type.toLowerCase().includes(q) ||
            auditEventLabel(e.event_type, e.decision).toLowerCase().includes(q) ||
            (e.request_id ?? "").toLowerCase().includes(q) ||
            (actorName(e) ?? "").toLowerCase().includes(q) ||
            (typeof meta.resource === "string" ? meta.resource : "").toLowerCase().includes(q)
          );
        },
      }}
      empty={{
        title: feed.isError ? "Could not load audit" : "No audit events",
        description: feed.isError
          ? errorMessage(feed.error)
          : "Authority decisions and security events will appear here as traffic flows through this zone.",
      }}
      detail={{
        title: (e) => auditEventLabel(e.event_type, e.decision),
        description: (e) => auditSummary(e, actorName(e)),
        width: "max-w-xl",
        render: (e) => (
          <AuditDetailView zoneId={zoneId} event={e} actorName={actorName(e)} appNames={appNames} />
        ),
      }}
    />
  );
}

// Server-side audit filters keep large zones searchable: filters run against the control
// plane and the table's Next control walks the server cursor for additional pages, rather
// than scanning only the latest page client-side.
function AuditFilterBar({
  mode,
  onMode,
  exportControl,
  category,
  decision,
  eventType,
  requestId,
  applicationId,
  applications,
  sessionId,
  authorityRecordId,
  label,
  since,
  until,
  loaded,
  onCategory,
  onDecision,
  onEventType,
  onRequestId,
  onApplicationId,
  onSessionId,
  onAuthorityRecordId,
  onLabel,
  onSince,
  onUntil,
}: {
  mode: AuditMode;
  onMode: (m: AuditMode) => void;
  exportControl: ReactNode;
  category: string;
  decision: string;
  eventType: string;
  requestId: string;
  applicationId: string;
  applications: Application[];
  sessionId: string;
  authorityRecordId: string;
  label: string;
  since: string;
  until: string;
  loaded: number;
  onCategory: (v: string) => void;
  onDecision: (v: string) => void;
  onEventType: (v: string) => void;
  onRequestId: (v: string) => void;
  onApplicationId: (v: string) => void;
  onSessionId: (v: string) => void;
  onAuthorityRecordId: (v: string) => void;
  onLabel: (v: string) => void;
  onSince: (v: string) => void;
  onUntil: (v: string) => void;
}) {
  const activeFilters =
    (category !== "all" ? 1 : 0) +
    (decision !== "all" ? 1 : 0) +
    [eventType, requestId, applicationId, sessionId, authorityRecordId, label, since, until].filter(
      (v) => v.trim(),
    ).length;
  return (
    <AuditToolbar
      mode={mode}
      onMode={onMode}
      exportControl={exportControl}
      activeFilters={activeFilters}
      loaded={loaded}
      noun="event"
    >
      <Select label="Category" value={category} onChange={(e) => onCategory(e.target.value)}>
        <option value="all">All categories</option>
        {AUDIT_CATEGORIES.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </Select>
      <Select label="Decision" value={decision} onChange={(e) => onDecision(e.target.value)}>
        <option value="all">All decisions</option>
        <option value="allow">Allow</option>
        <option value="deny">Deny</option>
        <option value="partial">Partial</option>
      </Select>
      <Field
        label="Event type"
        placeholder="token_exchange"
        value={eventType}
        onChange={(e) => onEventType(e.target.value)}
      />
      <Field
        label="Request ID"
        placeholder="Correlate one request"
        value={requestId}
        onChange={(e) => onRequestId(e.target.value)}
      />
      <Select
        label="Application"
        value={applicationId}
        onChange={(e) => onApplicationId(e.target.value)}
      >
        <option value="">All applications</option>
        {applications.map((app) => (
          <option key={app.id} value={app.id}>
            {app.name}
          </option>
        ))}
      </Select>
      <Field
        label="Session ID"
        placeholder="Follow one Session"
        value={sessionId}
        onChange={(e) => onSessionId(e.target.value)}
      />
      <Field
        label="Authority record ID"
        placeholder="Follow one STS exchange record"
        value={authorityRecordId}
        onChange={(e) => onAuthorityRecordId(e.target.value)}
      />
      <Field
        label="Session label"
        placeholder="Scope to one Session role"
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
  const copy = useCopyToClipboard();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() =>
        void copy(JSON.stringify(value, null, 2), {
          onSuccess: () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          },
        })
      }
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

// Maps a linked entity to the console page that owns it, so an audit event drills
// straight into the application, resource, provider, session, delegation, or
// approval hold it references.
function entityLink(entity: AuditEntity): { to: string; search?: Record<string, string> } {
  switch (entity.kind) {
    case "application":
      return { to: appLink("/applications"), search: { focus: entity.id } };
    case "resource":
      return { to: appLink("/resources"), search: { focus: entity.id } };
    case "provider":
      return { to: appLink("/providers"), search: { focus: entity.id } };
    case "session":
      return { to: appLink("/sessions"), search: { focus: entity.id } };
    case "delegation":
      return { to: appLink("/sessions"), search: { view: "delegation", focus: entity.id } };
    case "approval":
      return { to: appLink("/approvals"), search: { focus: entity.id } };
  }
}

const ENTITY_KIND_LABELS: Record<AuditEntity["kind"], string> = {
  application: "Application",
  resource: "Resource",
  provider: "Provider",
  session: "Session",
  delegation: "Delegation",
  approval: "Approval hold",
};

function metaString(meta: Record<string, unknown>, key: string): string | null {
  const value = meta[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Evaluation statuses double as deny-reason codes on STS events, so they render as
// plain words rather than raw snake_case.
function evaluationLabel(status: string | null): string {
  return status ? status.replace(/_/g, " ") : "-";
}

function AuditDetailView({
  zoneId,
  event,
  actorName,
  appNames,
}: {
  zoneId: string;
  event: AuditEvent;
  actorName: string | null;
  appNames: Map<string, string>;
}) {
  const meta = event.metadata_json ?? {};
  const entities = auditEntities(event);
  const reason = auditReason(event);
  const chain = auditDelegationChain(event);
  const scopes = Array.isArray(meta.requested_scopes)
    ? meta.requested_scopes.filter((s): s is string => typeof s === "string")
    : [];
  const facts: { label: string; value: ReactNode }[] = [];
  const method = metaString(meta, "method");
  if (method) facts.push({ label: "Method", value: method });
  if (typeof meta.latency_ms === "number") {
    facts.push({ label: "Latency", value: `${meta.latency_ms} ms` });
  }
  if (typeof meta.upstream_status === "number") {
    facts.push({ label: "Upstream status", value: String(meta.upstream_status) });
  }
  const resultClass = metaString(meta, "result_class");
  if (resultClass) facts.push({ label: "Result", value: resultClass });
  const errorKind = metaString(meta, "error_kind");
  if (errorKind) facts.push({ label: "Error", value: errorKind.replace(/_/g, " ") });
  const authMode = metaString(meta, "auth_mode");
  if (authMode) facts.push({ label: "Auth mode", value: authMode });
  const upstreamHost = metaString(meta, "upstream_host");
  if (upstreamHost) facts.push({ label: "Upstream host", value: <Mono>{upstreamHost}</Mono> });
  const command = [metaString(meta, "command"), metaString(meta, "subcommand")]
    .filter(Boolean)
    .join(" ");
  if (command) facts.push({ label: "Command", value: <Mono>{command}</Mono> });
  const lifecycle = metaString(meta, "agent_lifecycle");
  if (lifecycle) facts.push({ label: "Session lifecycle", value: lifecycle });

  // Attribution facts answer who stood behind the action: the control-plane subject,
  // and the operator-asserted authority recorded for approval-gated changes.
  const attribution: { label: string; value: ReactNode }[] = [];
  const subject = metaString(meta, "subject");
  if (subject) attribution.push({ label: "Subject", value: <Mono>{subject}</Mono> });
  const authorizedBy = metaString(meta, "authorized_by");
  if (authorizedBy) attribution.push({ label: "Authorized by", value: authorizedBy });
  const approverSubject = metaString(meta, "approver_subject_id");
  if (approverSubject) {
    attribution.push({ label: "Approver", value: <Mono>{approverSubject}</Mono> });
  }
  const subjectFingerprint = metaString(meta, "subject_fingerprint");
  if (subjectFingerprint) {
    attribution.push({ label: "Subject fingerprint", value: <Mono>{subjectFingerprint}</Mono> });
  }

  // Approval facts reconstruct the hold an approval-gated exchange waited on.
  const approval: { label: string; value: ReactNode }[] = [];
  const tier = metaString(meta, "tier");
  if (tier) approval.push({ label: "Tier", value: tier });
  const approverClass = metaString(meta, "approver_class");
  if (approverClass) approval.push({ label: "Approver class", value: approverClass });
  const privacyMode = metaString(meta, "privacy_mode");
  if (privacyMode) approval.push({ label: "Privacy mode", value: privacyMode });

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {event.decision ? (
            <Badge tone={decisionTone(event.decision)}>{event.decision}</Badge>
          ) : null}
          <Badge tone="neutral">{auditEventLabel(event.event_type, event.decision)}</Badge>
        </div>
        <CopyJsonButton value={event} label="Copy event JSON" />
      </div>

      <p className="text-sm leading-6 text-foreground">{auditSummary(event, actorName)}</p>

      {reason && event.decision === "deny" ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5">
          <p className="text-sm font-medium text-foreground">{reason.label}</p>
          {reason.hint ? (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{reason.hint}</p>
          ) : null}
        </div>
      ) : null}

      <DetailGroup title="What happened">
        <DetailField label="Event">{auditEventLabel(event.event_type, event.decision)}</DetailField>
        <DetailField label="Decision">{event.decision ?? "-"}</DetailField>
        <DetailField label="Evaluation">{evaluationLabel(event.evaluation_status)}</DetailField>
        <DetailField label="Occurred">{new Date(event.occurred_at).toLocaleString()}</DetailField>
        {event.request_id ? (
          <DetailField label="Request ID">
            <Mono>{event.request_id}</Mono>
          </DetailField>
        ) : null}
        {metaString(meta, "trace_id") ? (
          <DetailField label="Trace ID">
            <Mono>{metaString(meta, "trace_id")}</Mono>
          </DetailField>
        ) : null}
      </DetailGroup>

      {entities.length > 0 ? (
        <DetailGroup title="Involved">
          {entities.map((entity) => {
            const link = entityLink(entity);
            const label =
              entity.kind === "application"
                ? (appNames.get(entity.id) ?? entity.label)
                : entity.label;
            return (
              <DetailField
                key={`${entity.kind}:${entity.id}`}
                label={ENTITY_KIND_LABELS[entity.kind]}
              >
                <Link
                  to={link.to}
                  search={link.search}
                  className="break-all font-mono text-xs text-foreground hover:underline"
                >
                  {label}
                </Link>
              </DetailField>
            );
          })}
        </DetailGroup>
      ) : null}

      {attribution.length > 0 ? (
        <DetailGroup title="Attribution">
          {attribution.map((fact) => (
            <DetailField key={fact.label} label={fact.label}>
              {fact.value}
            </DetailField>
          ))}
        </DetailGroup>
      ) : null}

      {approval.length > 0 ? (
        <DetailGroup title="Approval hold">
          {approval.map((fact) => (
            <DetailField key={fact.label} label={fact.label}>
              {fact.value}
            </DetailField>
          ))}
        </DetailGroup>
      ) : null}

      {scopes.length > 0 || facts.length > 0 ? (
        <DetailGroup title="Request">
          {scopes.length > 0 ? (
            <DetailField label="Scopes">
              <span className="flex flex-wrap gap-1">
                {scopes.map((s) => (
                  <span
                    key={s}
                    className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                  >
                    {s}
                  </span>
                ))}
              </span>
            </DetailField>
          ) : null}
          {facts.map((fact) => (
            <DetailField key={fact.label} label={fact.label}>
              {fact.value}
            </DetailField>
          ))}
        </DetailGroup>
      ) : null}

      {chain.length > 0 ? (
        <section>
          <SubHeading>Delegation chain</SubHeading>
          <ol className="mt-2 flex flex-col gap-1">
            {chain.map((hop, i) => (
              <li
                key={`${hop.delegationEdgeId ?? i}`}
                className="flex items-center gap-2 text-xs text-foreground"
              >
                <span className="text-muted-foreground">{i + 1}.</span>
                <span className="truncate">
                  {hop.applicationId
                    ? (appNames.get(hop.applicationId) ?? hop.applicationId)
                    : "unknown application"}
                </span>
                {hop.sessionId ? (
                  <Link
                    to={appLink("/sessions")}
                    search={{ focus: hop.sessionId }}
                    className="truncate font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                  >
                    {hop.sessionId}
                  </Link>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <details className="rounded-md border border-border">
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground">
          Technical details
        </summary>
        <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
          <DetailField label="Event ID">
            <Mono>{event.id}</Mono>
          </DetailField>
          {Object.keys(meta).length > 0 ? <JsonBlock value={meta} /> : null}
        </div>
      </details>

      {event.request_id ? <DecisionTraceView zoneId={zoneId} requestId={event.request_id} /> : null}
    </div>
  );
}

// Full per-event forensic detail: the determining policies, diagnostics, policy-set
// binding, manifest hash, and metadata recorded for one event in the request group.
// The policy-set binding resolves to its human name and version number so the trace
// reads as enforcement history rather than opaque identifiers.
function TraceEventDetail({
  zoneId,
  event,
  index,
}: {
  zoneId: string;
  event: AuditDetail;
  index: number;
}) {
  const determining = event.determining_policies_json ?? [];
  const diagnostics = event.diagnostics_json ?? [];
  const metadata = event.metadata_json ?? {};
  const sets = usePolicySets(event.policy_set_id ? zoneId : null);
  const versions = usePolicySetVersions(
    event.policy_set_version_id ? zoneId : null,
    event.policy_set_id,
  );
  const setName = sets.data?.find((s) => s.id === event.policy_set_id)?.name;
  const versionNumber = versions.data?.find((v) => v.id === event.policy_set_version_id)?.version;
  return (
    <details className="rounded-md border border-border">
      <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-xs">
        <span className="flex items-center gap-2">
          <span className="text-muted-foreground">#{index + 1}</span>
          <span className="font-medium text-foreground">
            {auditEventLabel(event.event_type, event.decision)}
          </span>
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
              <Link
                to={appLink("/policies")}
                search={{ tab: "sets", focus: event.policy_set_id }}
                className="text-foreground underline decoration-border underline-offset-2 transition-colors hover:decoration-foreground"
                title={event.policy_set_id}
              >
                {setName ?? event.policy_set_id}
              </Link>
            </DetailField>
          ) : null}
          {event.policy_set_version_id ? (
            <DetailField label="Policy set version">
              {versionNumber ? (
                <span title={event.policy_set_version_id}>v{versionNumber}</span>
              ) : (
                <Mono>{event.policy_set_version_id}</Mono>
              )}
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
            <DeterminingPolicies entries={determining} />
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

// The decision contract names the boundary that produced each decision (for example
// "delegation-load" or "mint"). Render those names directly; anything with an
// unexpected shape falls back to raw JSON so forensics never lose data.
function DeterminingPolicies({ entries }: { entries: unknown[] }) {
  const named: string[] = [];
  const unnamed: unknown[] = [];
  for (const entry of entries) {
    const policy =
      entry && typeof entry === "object" && "policy" in entry
        ? (entry as { policy: unknown }).policy
        : null;
    if (typeof policy === "string" && policy) named.push(policy);
    else unnamed.push(entry);
  }
  return (
    <div className="flex flex-col gap-2">
      {named.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {named.map((policy, index) => (
            <Badge key={`${policy}-${index}`} tone="neutral">
              {policy}
            </Badge>
          ))}
        </div>
      ) : null}
      {unnamed.length > 0 ? <JsonBlock value={unnamed} /> : null}
    </div>
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
          <span className="font-medium text-foreground">
            {auditEventLabel(denied.event_type, "deny")}
          </span>
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
            <DeterminingPolicies entries={denied.determining_policies} />
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
              <TraceEventDetail key={ev.id} zoneId={zoneId} event={ev} index={i} />
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

function operatorOf(payload: Record<string, unknown> | null): string | null {
  const operator = payload?.operator;
  return typeof operator === "string" && operator.length > 0 ? operator : null;
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
  const [entityId, setEntityId] = useState("");
  const [actorId, setActorId] = useState("");
  const [method, setMethod] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");

  const serverQuery = useMemo<AdminAuditQuery>(() => {
    const q: AdminAuditQuery = {};
    if (entityType.trim()) q.entity_type = entityType.trim();
    if (entityId.trim()) q.entity_id = entityId.trim();
    if (actorId.trim()) q.actor_id = actorId.trim();
    if (method) q.method = method;
    const sinceTs = parseTimeInput(since);
    if (sinceTs) q.since = sinceTs;
    const untilTs = parseTimeInput(until);
    if (untilTs) q.until = untilTs;
    return q;
  }, [entityType, entityId, actorId, method, since, until]);

  const feed = useAdminAuditFeed(zoneId, serverQuery);
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
      cell: (e) => {
        const operator = operatorOf(e.payload_json);
        return (
          <div className="min-w-0">
            <div className="truncate text-sm text-foreground">
              {operator ? <CreatedBy id={operator} /> : (e.actor_name ?? "-")}
            </div>
            <div className="truncate text-[11px] text-muted-foreground">
              {operator ? (e.actor_name ?? e.actor_scope ?? "") : (e.actor_scope ?? "")}
            </div>
          </div>
        );
      },
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
      feed={{
        hasMore: Boolean(feed.hasNextPage),
        fetching: feed.isFetchingNextPage,
        loadMore: () => feed.fetchNextPage(),
      }}
      toolbarExtra={
        <AdminAuditFilterBar
          mode={mode}
          onMode={onMode}
          exportControl={
            <ExportDialog
              zoneId={zoneId}
              feed="admin-audit"
              fields={ADMIN_EXPORT_FIELDS}
              query={Object.fromEntries(
                Object.entries(serverQuery).map(([k, v]) => [k, String(v)]),
              )}
            />
          }
          entityType={entityType}
          entityId={entityId}
          actorId={actorId}
          method={method}
          since={since}
          until={until}
          loaded={rows.length}
          onEntityType={setEntityType}
          onEntityId={setEntityId}
          onActorId={setActorId}
          onMethod={setMethod}
          onSince={setSince}
          onUntil={setUntil}
        />
      }
      search={{
        placeholder: "Filter loaded changes by path, actor, or entity…",
        match: (e, q) =>
          e.path.toLowerCase().includes(q) ||
          (e.actor_name ?? "").toLowerCase().includes(q) ||
          (operatorOf(e.payload_json) ?? "").toLowerCase().includes(q) ||
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
        {operatorOf(event.payload_json) ? (
          <DetailField label="Profile">
            <CreatedBy id={operatorOf(event.payload_json)} />
          </DetailField>
        ) : null}
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
  exportControl,
  entityType,
  entityId,
  actorId,
  method,
  since,
  until,
  loaded,
  onEntityType,
  onEntityId,
  onActorId,
  onMethod,
  onSince,
  onUntil,
}: {
  mode: AuditMode;
  onMode: (m: AuditMode) => void;
  exportControl: ReactNode;
  entityType: string;
  entityId: string;
  actorId: string;
  method: string;
  since: string;
  until: string;
  loaded: number;
  onEntityType: (v: string) => void;
  onEntityId: (v: string) => void;
  onActorId: (v: string) => void;
  onMethod: (v: string) => void;
  onSince: (v: string) => void;
  onUntil: (v: string) => void;
}) {
  const activeFilters =
    (method ? 1 : 0) + [entityType, entityId, actorId, since, until].filter((v) => v.trim()).length;
  return (
    <AuditToolbar
      mode={mode}
      onMode={onMode}
      exportControl={exportControl}
      activeFilters={activeFilters}
      loaded={loaded}
      noun="change"
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
        label="Entity ID"
        placeholder="Follow one entity's history"
        value={entityId}
        onChange={(e) => onEntityId(e.target.value)}
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
