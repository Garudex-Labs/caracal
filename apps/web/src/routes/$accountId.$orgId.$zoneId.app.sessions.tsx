/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Sessions runtime workspace for live sessions and the delegated authority between them.
*/
import { appLink } from "@/platform/nav/appLink";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";

import { DelegationInspector } from "@/components/console/DelegationInspector";
import { CsvExportButton } from "@/components/console/CsvExportButton";
import {
  delegationErrorMessage,
  edgeStatusLabel,
  edgeStatusTone,
  shortId,
} from "@/components/console/delegationFormat";
import { FeedTabs, FeedToolbar } from "@/components/console/FeedToolbar";
import {
  BriefRow,
  CopyValue,
  DetailField,
  EventTimeline,
  Mono,
  ResourceWorkspace,
  type TimelineEvent,
} from "@/components/console/ResourceWorkspace";
import { ModulePage } from "@/components/console/ModulePage";
import { ZoneScopedPage } from "@/components/console/ZoneScope";
import {
  Badge,
  Button,
  Drawer,
  Field,
  Modal,
  Select,
  Skeleton,
  Spinner,
  useToast,
  type Column,
} from "@/components/ui";
import { cx } from "@/lib/cx";
import { auditDecisionTone, auditEventContext, auditEventLabel } from "@/lib/auditPresentation";
import { relativeTime } from "@/lib/time";
import { ConsoleApiError } from "@/platform/api/client";
import {
  useAgentActivity,
  useAgentChildren,
  useAgentEffectiveAuthority,
  useAgentInboundDelegations,
  useAgentInvocations,
  useAgentLifecycle,
  useAgentOutboundDelegations,
  useAgentServices,
  useAgentsFeed,
  useApplications,
  useDelegationsFeed,
} from "@/platform/api/hooks";
import type {
  Agent,
  AgentStatus,
  AgentQuery,
  Application,
  DelegationEdge,
  InvocationStatus,
} from "@/platform/api/types";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/sessions")({
  component: SessionsRoute,
  validateSearch: (
    search: Record<string, unknown>,
  ): { view?: "sessions" | "delegation"; focus?: string } => ({
    view: search.view === "delegation" ? "delegation" : undefined,
    focus: typeof search.focus === "string" ? search.focus : undefined,
  }),
});

type SessionsView = "sessions" | "delegation";

const VIEW_TABS: { id: SessionsView; label: string }[] = [
  { id: "sessions", label: "Sessions" },
  { id: "delegation", label: "Delegation" },
];

function SessionsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const view: SessionsView = search.view === "delegation" ? "delegation" : "sessions";
  const tabs = (
    <FeedTabs
      tabs={VIEW_TABS}
      value={view}
      onChange={(v) =>
        navigate({
          search: { view: v === "delegation" ? v : undefined, focus: undefined },
          replace: true,
        })
      }
      label="Runtime view"
    />
  );
  return (
    <ZoneScopedPage
      title="Sessions"
      description="Live sessions and the authority delegated between them in this zone."
      breadcrumbs={[{ label: "Console", to: appLink() }, { label: "Sessions" }]}
    >
      {(zone) =>
        view === "sessions" ? (
          <SessionsPage zoneId={zone.id} tabs={tabs} />
        ) : (
          <DelegationPage zoneId={zone.id} tabs={tabs} />
        )
      }
    </ZoneScopedPage>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ConsoleApiError) {
    if (error.code === "coordinator_not_configured") return "Coordinator service not connected.";
    if (error.code === "upstream_unreachable") return "Coordinator service unreachable.";
    return error.code.replace(/_/g, " ");
  }
  return "Unexpected error.";
}

function CoordinatorOffline({ code, onRetry }: { code: string; onRetry: () => void }) {
  const configured = code !== "coordinator_not_configured";
  return (
    <div className="border border-border p-6">
      <div className="flex items-start gap-4">
        <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center border border-border bg-card text-amber-600 dark:text-amber-400">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
          >
            <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          </svg>
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            {configured ? "Coordinator unreachable" : "Coordinator not connected"}
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Sessions are served by the Caracal Coordinator runtime.{" "}
            {configured
              ? "It is configured but not responding. Confirm the runtime is running, then retry."
              : "Start the local stack with `caracal up` to provision and run it, then retry."}
          </p>
          <div className="mt-5">
            <Button variant="secondary" size="sm" onClick={onRetry}>
              Retry
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function statusTone(status: AgentStatus): "success" | "warning" | "muted" {
  if (status === "active") return "success";
  if (status === "suspended") return "warning";
  return "muted";
}

type Liveness = { tone: "success" | "warning" | "danger" | "muted"; label: string; detail: string };

// Derives a single runtime-health signal from lifecycle fields so operators can spot dying
// sessions at a glance: task sessions are governed by TTL, service sessions by heartbeat lease.
function liveness(agent: Agent, now = Date.now()): Liveness {
  if (agent.status === "expired") {
    return {
      tone: "muted",
      label: "Expired",
      detail: agent.terminated_at
        ? `TTL elapsed ${relativeTime(agent.terminated_at, now)}`
        : "TTL elapsed",
    };
  }
  if (agent.status === "terminated") {
    return {
      tone: "muted",
      label: "Terminated",
      detail: agent.terminated_at ? `Ended ${relativeTime(agent.terminated_at, now)}` : "Ended",
    };
  }
  if (agent.status === "suspended") {
    return { tone: "warning", label: "Suspended", detail: "Authority paused until resumed" };
  }
  if (agent.lifecycle === "service") {
    if (!agent.heartbeat_deadline_at) {
      return {
        tone: "muted",
        label: "No lease",
        detail: "Service session has not reported a heartbeat",
      };
    }
    const deadline = Date.parse(agent.heartbeat_deadline_at);
    if (deadline < now) {
      return {
        tone: "danger",
        label: "Lease expired",
        detail: `Heartbeat lost ${relativeTime(agent.heartbeat_deadline_at, now)}, pending auto-suspend`,
      };
    }
    if (deadline - now < 30_000) {
      return {
        tone: "warning",
        label: "Lease expiring",
        detail: `Heartbeat lease ends ${relativeTime(agent.heartbeat_deadline_at, now)}`,
      };
    }
    return {
      tone: "success",
      label: "Healthy",
      detail: `Heartbeat lease valid until ${new Date(deadline).toLocaleTimeString()}`,
    };
  }
  // task agent: TTL from spawned_at
  if (agent.ttl_seconds && agent.spawned_at) {
    const expires = Date.parse(agent.spawned_at) + agent.ttl_seconds * 1000;
    if (expires < now) {
      return { tone: "danger", label: "Expired", detail: "Past TTL, pending auto-terminate" };
    }
    if (expires - now < 60_000) {
      return {
        tone: "warning",
        label: "Expiring",
        detail: `TTL ends ${relativeTime(new Date(expires).toISOString(), now)}`,
      };
    }
    return {
      tone: "success",
      label: "Active",
      detail: `TTL ends ${relativeTime(new Date(expires).toISOString(), now)}`,
    };
  }
  return { tone: "success", label: "Active", detail: "Running" };
}

function agentExpiry(agent: Agent): string {
  if (agent.status !== "active") return "-";
  if (agent.lifecycle === "service") {
    return agent.heartbeat_deadline_at
      ? new Date(agent.heartbeat_deadline_at).toLocaleString()
      : "no lease";
  }
  if (agent.ttl_seconds && agent.spawned_at) {
    return new Date(Date.parse(agent.spawned_at) + agent.ttl_seconds * 1000).toLocaleString();
  }
  return "-";
}

// The most human-meaningful name for a session row. Operators tag sessions by role via labels,
// so the first label reads as the session's name; the application's name is the fallback. The
// raw session id stays available as a secondary, copyable identifier.
function agentTitle(agent: Agent, appNames: Map<string, string>): string {
  return agent.labels[0] ?? appNames.get(agent.application_id) ?? agent.application_id;
}

// How long the session has run: start to termination for ended sessions, start to now for live ones.
function agentDuration(agent: Agent, now = Date.now()): string {
  const start = Date.parse(agent.spawned_at);
  const end = agent.terminated_at ? Date.parse(agent.terminated_at) : now;
  const secs = Math.max(Math.round((end - start) / 1000), 0);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return mins % 60 ? `${hrs}h ${mins % 60}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

// Plain-language rendering of why a session ended, drawn from the durable termination reason.
const TERMINATION_REASON_LABELS: Record<string, string> = {
  requested: "Requested",
  ttl: "TTL expired",
  parent_terminated: "Parent terminated",
  service_heartbeat_lost: "Heartbeat lost",
  zone_purged: "Zone purged",
};

function terminationReasonLabel(reason: string): string {
  return TERMINATION_REASON_LABELS[reason] ?? reason.replace(/_/g, " ");
}

// The session's recorded lifecycle as ordered events: start, service heartbeats, and the
// terminal or upcoming end of the run.
function agentEvents(agent: Agent): TimelineEvent[] {
  const events: TimelineEvent[] = [{ label: "Spawned", at: agent.spawned_at, tone: "neutral" }];
  if (agent.lifecycle === "service" && agent.last_heartbeat_at) {
    events.push({ label: "Last heartbeat", at: agent.last_heartbeat_at, tone: "neutral" });
  }
  if (agent.terminated_at) {
    events.push({
      label: agent.status === "expired" ? "Expired" : "Terminated",
      at: agent.terminated_at,
      tone: "muted",
      detail: agent.termination_reason
        ? terminationReasonLabel(agent.termination_reason)
        : undefined,
    });
    return events;
  }
  if (agent.lifecycle === "service") {
    if (agent.heartbeat_deadline_at) {
      events.push({
        label: "Lease ends",
        at: agent.heartbeat_deadline_at,
        tone: "muted",
        future: true,
      });
    }
  } else if (agent.ttl_seconds) {
    events.push({
      label: "Expires",
      at: new Date(Date.parse(agent.spawned_at) + agent.ttl_seconds * 1000).toISOString(),
      tone: "muted",
      future: true,
    });
  }
  return events;
}

function SessionsPage({ zoneId, tabs }: { zoneId: string; tabs: ReactNode }) {
  const toast = useToast();
  const lifecycle = useAgentLifecycle(zoneId);

  const apps = useApplications(zoneId);
  const appNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const app of apps.data ?? []) map.set(app.id, app.name);
    return map;
  }, [apps.data]);

  const [status, setStatus] = useState<string>("all");
  const [lifecycleFilter, setLifecycleFilter] = useState<string>("all");
  const [application, setApplication] = useState("");
  const [label, setLabel] = useState("");
  const [confirm, setConfirm] = useState<{
    agent: Agent;
    action: "suspend" | "terminate";
  } | null>(null);

  const serverQuery = useMemo<AgentQuery>(() => {
    const q: AgentQuery = {};
    if (status !== "all") q.status = status;
    if (lifecycleFilter !== "all") q.lifecycle = lifecycleFilter;
    if (application.trim()) q.application_id = application.trim();
    if (label.trim()) q.label = label.trim();
    return q;
  }, [status, lifecycleFilter, application, label]);

  const feed = useAgentsFeed(zoneId, serverQuery);
  const rows = useMemo(() => (feed.data?.pages ?? []).flatMap((page) => page.rows), [feed.data]);

  const coordError = feed.isError && feed.error instanceof ConsoleApiError ? feed.error.code : null;
  const coordinatorDown =
    coordError === "coordinator_not_configured" || coordError === "upstream_unreachable";

  async function runLifecycle(agent: Agent, action: "suspend" | "resume" | "terminate") {
    try {
      await lifecycle.mutateAsync({ id: agent.agent_session_id, action });
      const verb =
        action === "suspend" ? "suspended" : action === "resume" ? "resumed" : "terminated";
      toast({ tone: action === "terminate" ? "info" : "success", title: `Session ${verb}` });
    } catch (err) {
      toast({ tone: "error", title: "Action failed", description: errorMessage(err) });
    }
  }

  if (coordinatorDown) {
    return (
      <ModulePage
        title="Sessions"
        description="Live sessions and the authority delegated between them in this zone."
        breadcrumbs={[{ label: "Console", to: appLink() }, { label: "Sessions" }]}
      >
        <CoordinatorOffline code={coordError as string} onRetry={() => feed.refetch()} />
      </ModulePage>
    );
  }

  const columns: Column<Agent>[] = [
    {
      id: "session",
      header: "Session",
      cell: (a) => (
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">
            {agentTitle(a, appNames)}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="font-mono">{shortId(a.agent_session_id)}</span>
            <span>· {appNames.get(a.application_id) ?? shortId(a.application_id)}</span>
            {a.labels.length > 1 ? (
              <span>
                +{a.labels.length - 1} label{a.labels.length - 1 === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
        </div>
      ),
    },
    {
      id: "health",
      header: "Health",
      cell: (a) => {
        const live = liveness(a);
        return (
          <Badge
            tone={
              live.tone === "danger"
                ? "danger"
                : live.tone === "success"
                  ? "success"
                  : live.tone === "warning"
                    ? "warning"
                    : "muted"
            }
          >
            {live.label}
          </Badge>
        );
      },
    },
    {
      id: "kind",
      header: "Kind",
      cell: (a) => (
        <span className="text-xs text-muted-foreground">
          {a.lifecycle}
          <span className="ml-1.5 font-mono text-[10px]">
            {a.depth === 0 ? "root" : `d${a.depth}`}
          </span>
        </span>
      ),
    },
    {
      id: "started",
      header: "Started",
      cell: (a) => (
        <span className="text-xs text-muted-foreground">{relativeTime(a.spawned_at)}</span>
      ),
    },
    {
      id: "duration",
      header: "Duration",
      cell: (a) => (
        <span className="font-mono text-xs text-muted-foreground">{agentDuration(a)}</span>
      ),
    },
    {
      id: "outcome",
      header: "Outcome",
      align: "right",
      cell: (a) =>
        a.status === "terminated" || a.status === "expired" ? (
          <span className="text-xs text-muted-foreground">
            {a.termination_reason ? terminationReasonLabel(a.termination_reason) : "Ended"}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">{agentExpiry(a)}</span>
        ),
    },
  ];

  return (
    <>
      <ResourceWorkspace
        title="Sessions"
        description="Live sessions, their authority, and delegation lineage in this zone."
        breadcrumbs={[{ label: "Console", to: appLink() }, { label: "Sessions" }]}
        toolbarExtra={
          <AgentFilterBar
            tabs={tabs}
            status={status}
            lifecycle={lifecycleFilter}
            application={application}
            applications={apps.data ?? []}
            label={label}
            loaded={rows.length}
            onStatus={setStatus}
            onLifecycle={setLifecycleFilter}
            onApplication={setApplication}
            onLabel={setLabel}
            exportControl={
              <CsvExportButton
                zoneId={zoneId}
                path="agent-sessions"
                query={Object.fromEntries(
                  Object.entries(serverQuery).map(([k, v]) => [k, String(v)]),
                )}
                noun="sessions"
              />
            }
          />
        }
        rows={rows}
        loading={feed.isLoading}
        columns={columns}
        rowKey={(a) => a.agent_session_id}
        pageSize={12}
        feed={{
          hasMore: Boolean(feed.hasNextPage),
          fetching: feed.isFetchingNextPage,
          loadMore: () => feed.fetchNextPage(),
        }}
        search={{
          placeholder: "Filter loaded sessions by id, app, or label…",
          match: (a, q) =>
            a.agent_session_id.toLowerCase().includes(q) ||
            a.application_id.toLowerCase().includes(q) ||
            (appNames.get(a.application_id) ?? "").toLowerCase().includes(q) ||
            a.lifecycle.toLowerCase().includes(q) ||
            a.labels.some((l) => l.toLowerCase().includes(q)),
        }}
        empty={{
          title: feed.isError ? "Could not load sessions" : "No sessions",
          description: feed.isError
            ? errorMessage(feed.error)
            : "Sessions appear here as the Coordinator starts them in this zone.",
        }}
        detail={{
          title: (a) => agentTitle(a, appNames),
          description: (a) => `Started ${relativeTime(a.spawned_at)}`,
          width: "max-w-2xl",
          render: (a) => (
            <AgentInspector
              zoneId={zoneId}
              agent={a}
              appName={appNames.get(a.application_id) ?? null}
              busy={lifecycle.isPending}
              onSuspend={() => setConfirm({ agent: a, action: "suspend" })}
              onResume={() => void runLifecycle(a, "resume")}
              onTerminate={() => setConfirm({ agent: a, action: "terminate" })}
            />
          ),
        }}
      />

      <AgentLifecycleConfirm
        zoneId={zoneId}
        request={confirm}
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          if (confirm) await runLifecycle(confirm.agent, confirm.action);
        }}
      />
    </>
  );
}

// Server-side session filters + cursor pagination. Filters run against the Coordinator so
// large zones stay searchable; "Load more" follows the keyset cursor.
function AgentFilterBar({
  tabs,
  status,
  lifecycle,
  application,
  applications,
  label,
  loaded,
  onStatus,
  onLifecycle,
  onApplication,
  onLabel,
  exportControl,
}: {
  tabs: ReactNode;
  status: string;
  lifecycle: string;
  application: string;
  applications: Application[];
  label: string;
  loaded: number;
  onStatus: (v: string) => void;
  onLifecycle: (v: string) => void;
  onApplication: (v: string) => void;
  onLabel: (v: string) => void;
  exportControl: ReactNode;
}) {
  const activeFilters =
    (status !== "all" ? 1 : 0) +
    (lifecycle !== "all" ? 1 : 0) +
    [application, label].filter((v) => v.trim()).length;
  return (
    <FeedToolbar
      extra={exportControl}
      trailing={tabs}
      activeFilters={activeFilters}
      loaded={loaded}
      noun="session"
    >
      <Select label="Status" value={status} onChange={(e) => onStatus(e.target.value)}>
        <option value="all">All statuses</option>
        <option value="active">Active</option>
        <option value="suspended">Suspended</option>
        <option value="terminated">Terminated</option>
        <option value="expired">Expired</option>
      </Select>
      <Select label="Lifecycle" value={lifecycle} onChange={(e) => onLifecycle(e.target.value)}>
        <option value="all">All lifecycles</option>
        <option value="task">Task</option>
        <option value="service">Service</option>
      </Select>
      <Select
        label="Application"
        value={application}
        onChange={(e) => onApplication(e.target.value)}
      >
        <option value="">All applications</option>
        {applications.map((app) => (
          <option key={app.id} value={app.id}>
            {app.name}
          </option>
        ))}
      </Select>
      <Field
        label="Label"
        placeholder="exact label"
        value={label}
        onChange={(e) => onLabel(e.target.value)}
      />
    </FeedToolbar>
  );
}

// The delegation view of the runtime workspace: the graph of delegated authority between
// sessions, with chain traversal and revocation impact in the delegation inspector.
function DelegationPage({ zoneId, tabs }: { zoneId: string; tabs: ReactNode }) {
  const feed = useDelegationsFeed(zoneId);
  const rows = useMemo(() => (feed.data?.pages ?? []).flatMap((p) => p.rows), [feed.data]);

  const coordError = feed.isError && feed.error instanceof ConsoleApiError ? feed.error.code : null;
  const coordinatorDown =
    coordError === "coordinator_not_configured" || coordError === "upstream_unreachable";

  if (coordinatorDown) {
    return (
      <ModulePage
        title="Sessions"
        description="Live sessions and the authority delegated between them in this zone."
        breadcrumbs={[{ label: "Console", to: appLink() }, { label: "Sessions" }]}
      >
        <CoordinatorOffline code={coordError as string} onRetry={() => feed.refetch()} />
      </ModulePage>
    );
  }

  const columns: Column<DelegationEdge>[] = [
    {
      id: "delegation",
      header: "Delegation",
      cell: (e) => (
        <div className="flex items-center gap-2 font-mono text-xs">
          <span className="text-foreground">{shortId(e.source_session_id)}</span>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="shrink-0 text-muted-foreground"
          >
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
          <span className="text-foreground">{shortId(e.target_session_id)}</span>
        </div>
      ),
    },
    {
      id: "scopes",
      header: "Scopes",
      cell: (e) => (
        <div className="flex flex-wrap items-center gap-1">
          {e.scopes.slice(0, 2).map((scope) => (
            <span
              key={scope}
              className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
            >
              {scope}
            </span>
          ))}
          {e.scopes.length > 2 ? (
            <span className="text-[11px] text-muted-foreground">+{e.scopes.length - 2}</span>
          ) : null}
          {e.scopes.length === 0 ? <span className="text-xs text-muted-foreground">-</span> : null}
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: (e) => <Badge tone={edgeStatusTone(e)}>{edgeStatusLabel(e)}</Badge>,
    },
    {
      id: "expires",
      header: "Expires",
      align: "right",
      cell: (e) => (
        <span className="text-xs text-muted-foreground">
          {e.expires_at ? new Date(e.expires_at).toLocaleString() : "-"}
        </span>
      ),
    },
  ];

  return (
    <ResourceWorkspace
      title="Sessions"
      description="Active delegations. Each one grants a session authority to act on another's behalf within scope."
      breadcrumbs={[{ label: "Console", to: appLink() }, { label: "Sessions" }]}
      toolbarExtra={<FeedToolbar trailing={tabs} loaded={rows.length} noun="delegation" />}
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
      search={{
        placeholder: "Search loaded delegations by session or scope…",
        match: (e, q) =>
          e.source_session_id.toLowerCase().includes(q) ||
          e.target_session_id.toLowerCase().includes(q) ||
          e.scopes.some((s) => s.toLowerCase().includes(q)),
      }}
      sortOptions={[
        { id: "recent", label: "Most recent" },
        { id: "expiring", label: "Expiring soon" },
        { id: "scopes", label: "Most scopes" },
      ]}
      sortComparators={{
        recent: (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
        expiring: (a, b) =>
          (a.expires_at ? Date.parse(a.expires_at) : Infinity) -
          (b.expires_at ? Date.parse(b.expires_at) : Infinity),
        scopes: (a, b) => b.scopes.length - a.scopes.length,
      }}
      empty={{
        title: feed.isError ? "Could not load delegations" : "No active delegations",
        description: feed.isError
          ? delegationErrorMessage(feed.error)
          : "When sessions delegate authority to one another, the active delegations appear here with their chains and impact.",
      }}
      detail={{
        title: (e) => `${shortId(e.source_session_id)} → ${shortId(e.target_session_id)}`,
        description: (e) => e.id,
        width: "max-w-2xl",
        render: (e) => <DelegationInspector zoneId={zoneId} edge={e} />,
      }}
    />
  );
}

// Lifecycle confirmation that previews the cascade blast radius. Suspend and terminate
// recurse the session subtree and revoke subject sessions held only by it, so the operator
// sees the direct child sessions that will be affected before committing. Resume is the
// undo action and runs directly without a confirmation.
function AgentLifecycleConfirm({
  zoneId,
  request,
  onClose,
  onConfirm,
}: {
  zoneId: string;
  request: { agent: Agent; action: "suspend" | "terminate" } | null;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const children = useAgentChildren(zoneId, request ? request.agent.agent_session_id : null);
  const childCount = (children.data ?? []).length;

  if (!request) return null;
  const { action } = request;
  const title = action === "suspend" ? "Suspend session" : "Terminate session";
  const base =
    action === "suspend"
      ? "Suspending pauses this session's authority and cascades to its descendant sessions. Subject sessions held only by the suspended subtree are revoked. In-flight work may fail until resumed."
      : "Terminating ends this session and its entire descendant subtree immediately, revoking their authority and subject sessions. This cannot be undone.";

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      description={`${request.agent.lifecycle} session · depth ${request.agent.depth}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={action === "terminate" ? "danger" : "primary"}
            onClick={async () => {
              await onConfirm();
              onClose();
            }}
          >
            {action === "suspend" ? "Suspend" : "Terminate"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">{base}</p>
        <div className="border border-border bg-muted/20 p-3 text-xs">
          {children.isLoading ? (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Spinner className="h-3.5 w-3.5" /> Checking cascade impact…
            </span>
          ) : childCount === 0 ? (
            <span className="text-muted-foreground">
              No direct child sessions. Only this session is affected.
            </span>
          ) : (
            <div className="flex flex-col gap-2">
              <span className="font-medium text-foreground">
                {childCount} direct child session{childCount === 1 ? "" : "s"} will cascade
                {action === "suspend" ? " into suspension" : " into termination"} (descendants
                included):
              </span>
              <ul className="flex flex-col gap-1">
                {(children.data ?? []).slice(0, 6).map((c) => (
                  <li key={c.agent_session_id} className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-[11px] text-muted-foreground">
                      {c.agent_session_id}
                    </span>
                    <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                  </li>
                ))}
              </ul>
              {childCount > 6 ? (
                <span className="text-muted-foreground">…and {childCount - 6} more</span>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function AgentInspector({
  zoneId,
  agent,
  appName,
  busy,
  onSuspend,
  onResume,
  onTerminate,
}: {
  zoneId: string;
  agent: Agent;
  appName: string | null;
  busy: boolean;
  onSuspend: () => void;
  onResume: () => void;
  onTerminate: () => void;
}) {
  const authority = useAgentEffectiveAuthority(zoneId, agent.agent_session_id);
  const children = useAgentChildren(zoneId, agent.agent_session_id);
  const terminal = agent.status === "terminated" || agent.status === "expired";
  const metadata = agent.metadata ?? {};
  const task = typeof metadata.task === "string" ? metadata.task : null;
  const extraMeta = Object.entries(metadata).filter(([key]) => key !== "task");
  const live = liveness(agent);
  const now = Date.now();

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={statusTone(agent.status)}>{agent.status}</Badge>
        <Badge
          tone="neutral"
          title={
            agent.lifecycle === "service"
              ? "Long-lived session, governed by heartbeat lease"
              : "Task session, governed by TTL"
          }
        >
          {agent.lifecycle}
        </Badge>
        <Badge tone="muted" title="Distance from the root session in the delegation tree">
          {agent.depth === 0 ? "root" : `depth ${agent.depth}`}
        </Badge>
        {agent.labels.slice(1).map((l) => (
          <Badge key={l} tone="muted">
            {l}
          </Badge>
        ))}
        {!terminal ? (
          <div className="ml-auto flex items-center gap-2">
            {agent.status === "suspended" ? (
              <Button variant="secondary" size="sm" loading={busy} onClick={onResume}>
                Resume
              </Button>
            ) : (
              <Button variant="secondary" size="sm" loading={busy} onClick={onSuspend}>
                Suspend
              </Button>
            )}
            <Button variant="danger" size="sm" onClick={onTerminate}>
              Terminate
            </Button>
          </div>
        ) : null}
      </div>

      <div className="rounded-md border border-border bg-card px-3 py-2.5">
        <dl className="flex flex-col gap-2">
          <BriefRow label="Task">
            <span className={task ? "text-sm text-foreground" : "text-sm text-muted-foreground"}>
              {task ?? "None recorded"}
            </span>
          </BriefRow>
          <BriefRow label="Application">
            {appName ? (
              <Link
                to={appLink("/applications")}
                className="text-sm text-foreground hover:underline"
              >
                {appName}
              </Link>
            ) : (
              <Mono>{agent.application_id}</Mono>
            )}
          </BriefRow>
          {live.tone !== "success" ? (
            <BriefRow label="Health">
              <span
                className={cx(
                  "text-xs",
                  live.tone === "danger"
                    ? "text-destructive"
                    : live.tone === "warning"
                      ? "text-amber-700 dark:text-amber-400"
                      : "text-muted-foreground",
                )}
              >
                {live.label}. {live.detail}.
              </span>
            </BriefRow>
          ) : null}
        </dl>
      </div>

      <EventTimeline events={agentEvents(agent)} now={now} />

      <AgentActivity zoneId={zoneId} sessionId={agent.agent_session_id} />

      <AuthorityEnvelope authority={authority} />

      <AgentDelegations zoneId={zoneId} sessionId={agent.agent_session_id} />

      <AgentExecution
        zoneId={zoneId}
        sessionId={agent.agent_session_id}
        applicationId={agent.application_id}
        isService={agent.lifecycle === "service"}
      />

      {(children.data ?? []).length > 0 ? (
        <section className="border-t border-border pt-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Child sessions
          </h3>
          <ul className="mt-3 divide-y divide-border border-y border-border">
            {(children.data ?? []).map((child) => (
              <li
                key={child.agent_session_id}
                className="flex items-center justify-between gap-3 py-2.5"
              >
                <Mono>{child.agent_session_id}</Mono>
                <div className="flex items-center gap-1.5">
                  <Badge tone="muted">{child.lifecycle}</Badge>
                  <Badge tone={statusTone(child.status)}>{child.status}</Badge>
                </div>
              </li>
            ))}
          </ul>
        </section>
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
            label="Session ID"
            hint="This session's id; delegations and holds reference it"
          >
            <CopyValue value={agent.agent_session_id} />
          </DetailField>
          <DetailField label="Application" hint="The application identity this session runs under">
            <CopyValue value={agent.application_id} />
          </DetailField>
          {agent.parent_id ? (
            <DetailField label="Parent session" hint="The session that started this one">
              <Link
                to={appLink("/sessions")}
                search={{ focus: agent.parent_id }}
                className="break-all font-mono text-xs text-foreground hover:underline"
              >
                {agent.parent_id}
              </Link>
            </DetailField>
          ) : null}
          {agent.subject_session_id ? (
            <DetailField
              label="Subject session"
              hint="The authenticated subject this session acts for"
            >
              <Link
                to={appLink("/subjects")}
                search={{ record: agent.subject_session_id }}
                className="break-all font-mono text-xs text-foreground hover:underline"
              >
                {agent.subject_session_id}
              </Link>
            </DetailField>
          ) : null}
          {extraMeta.map(([key, value]) => (
            <DetailField key={key} label={key}>
              <Mono>{typeof value === "object" ? JSON.stringify(value) : String(value)}</Mono>
            </DetailField>
          ))}
        </dl>
      </details>
    </div>
  );
}

// Full effective-authority envelope. The Coordinator intersects every active inbound
// delegation into scopes/resources/hops/ttl/expiry; surfacing all of it (not just scopes)
// lets an operator see the session's complete runtime authority boundary.
function AuthorityEnvelope({
  authority,
}: {
  authority: ReturnType<typeof useAgentEffectiveAuthority>;
}) {
  return (
    <section className="border-t border-border pt-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        Effective authority
      </h3>
      {authority.isLoading ? (
        <Skeleton className="mt-3 h-20 w-full" />
      ) : authority.isError ? (
        <p className="mt-2 text-sm text-muted-foreground">{errorMessage(authority.error)}</p>
      ) : authority.data ? (
        (() => {
          const a = authority.data;
          const noAuthority = a.inbound_edges.length === 0;
          return (
            <div className="mt-3 flex flex-col gap-3">
              <div className="grid grid-cols-3 gap-px border border-border bg-border [&>*]:bg-background">
                <Metric label="Inbound delegations" value={a.inbound_edges.length} />
                <Metric
                  label="Max hops"
                  text={a.effective_max_hops == null ? "∞" : String(a.effective_max_hops)}
                />
                <Metric
                  label="Authority ends"
                  text={a.earliest_expires_at ? relativeTime(a.earliest_expires_at) : "-"}
                />
              </div>

              {noAuthority ? (
                <p className="text-sm text-muted-foreground">
                  No inbound delegations. This session acts only under its own application
                  authority.
                </p>
              ) : (
                <>
                  <div>
                    <span className="text-xs text-muted-foreground">
                      Scopes ({a.effective_scopes.length})
                    </span>
                    {a.effective_scopes.length > 0 ? (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {a.effective_scopes.map((scope) => (
                          <span
                            key={scope}
                            className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                          >
                            {scope}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-1 text-sm text-muted-foreground">
                        Scope intersection is empty: inbound delegations share no common scope.
                      </p>
                    )}
                  </div>

                  <div>
                    <span className="text-xs text-muted-foreground">
                      Resources{" "}
                      {a.effective_resource_constrained ? (
                        <Badge tone="warning">constrained</Badge>
                      ) : (
                        <Badge tone="muted">unconstrained</Badge>
                      )}
                    </span>
                    {a.effective_resources.length > 0 ? (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {a.effective_resources.map((r) => (
                          <span
                            key={r}
                            className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                          >
                            {r}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {a.effective_resource_constrained
                          ? "Constrained by resource id only."
                          : "Authority is not resource-bound."}
                      </p>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })()
      ) : null}
    </section>
  );
}

// Inbound/outbound delegations for the session, keyed by its session id. Inbound =
// authority the session received; outbound = authority it granted onward.
function AgentDelegations({ zoneId, sessionId }: { zoneId: string; sessionId: string }) {
  const [tab, setTab] = useState<"inbound" | "outbound">("inbound");
  const [inspect, setInspect] = useState<DelegationEdge | null>(null);
  const inbound = useAgentInboundDelegations(zoneId, tab === "inbound" ? sessionId : null);
  const outbound = useAgentOutboundDelegations(zoneId, tab === "outbound" ? sessionId : null);
  const active = tab === "inbound" ? inbound : outbound;
  const edges = active.data ?? [];

  return (
    <section className="border-t border-border pt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Delegations
        </h3>
        <div className="inline-flex overflow-hidden border border-border">
          {(["inbound", "outbound"] as const).map((id) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={cx(
                "px-2.5 py-1 text-xs font-medium capitalize transition-colors",
                tab === id
                  ? "bg-foreground text-background"
                  : "bg-background text-muted-foreground hover:text-foreground",
              )}
            >
              {id}
            </button>
          ))}
        </div>
      </div>
      {active.isLoading ? (
        <Skeleton className="mt-3 h-12 w-full" />
      ) : edges.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No {tab} delegations.{" "}
          <Link
            to={appLink("/sessions")}
            search={{ view: "delegation" }}
            className="text-foreground hover:underline"
          >
            Open delegation workspace
          </Link>
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-border border-y border-border">
          {edges.map((edge) => (
            <li key={edge.id}>
              <button
                type="button"
                onClick={() => setInspect(edge)}
                className="flex w-full flex-col gap-1 py-2.5 text-left transition-colors hover:bg-muted/40"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-[11px] text-muted-foreground">
                    {tab === "inbound" ? edge.source_session_id : edge.target_session_id}
                  </span>
                  <Badge tone={edge.status === "active" ? "success" : "muted"}>{edge.status}</Badge>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  {edge.scopes.slice(0, 4).map((s) => (
                    <span
                      key={s}
                      className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                    >
                      {s}
                    </span>
                  ))}
                  {edge.scopes.length > 4 ? (
                    <span className="text-[10px] text-muted-foreground">
                      +{edge.scopes.length - 4}
                    </span>
                  ) : null}
                  {edge.scopes.length === 0 ? (
                    <span className="text-[10px] text-muted-foreground">no scopes</span>
                  ) : null}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      <Drawer
        open={inspect !== null}
        onClose={() => setInspect(null)}
        title={
          inspect
            ? `${shortId(inspect.source_session_id)} → ${shortId(inspect.target_session_id)}`
            : ""
        }
        description={inspect?.id}
        width="max-w-2xl"
      >
        {inspect ? (
          <DelegationInspector zoneId={zoneId} edge={inspect} onRevoked={() => setInspect(null)} />
        ) : null}
      </Drawer>
    </section>
  );
}

function invocationTone(status: InvocationStatus): "success" | "warning" | "danger" | "muted" {
  if (status === "succeeded") return "success";
  if (status === "running" || status === "pending") return "warning";
  if (status === "failed" || status === "timed_out" || status === "dead") return "danger";
  return "muted";
}

// Authoritative record of what the session actually did: the durable audit events correlated
// by agent_session_id (token issuance, resource calls, denials), newest first. This is the
// core of the session audit - it answers "what happened" beyond the current lifecycle state.
function AgentActivity({ zoneId, sessionId }: { zoneId: string; sessionId: string }) {
  const activity = useAgentActivity(zoneId, sessionId);
  const events = activity.data?.rows ?? [];

  return (
    <section className="border-t border-border pt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Activity
        </h3>
        <Link
          to={appLink("/audit")}
          search={{ agent: sessionId }}
          className="text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          Open in Audit
        </Link>
      </div>
      {activity.isLoading ? (
        <Skeleton className="mt-3 h-16 w-full" />
      ) : events.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          No recorded activity yet. Exchanges and authority decisions appear here as the session
          acts.
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

// Read-only execution lens. Surfaces durable invocations involving this session and, for
// service sessions, the registered service endpoint + health. Payloads are never exposed;
// all mutation stays with the runtime identity.
function AgentExecution({
  zoneId,
  sessionId,
  applicationId,
  isService,
}: {
  zoneId: string;
  sessionId: string;
  applicationId: string;
  isService: boolean;
}) {
  const invocations = useAgentInvocations(zoneId, sessionId);
  const services = useAgentServices(zoneId, isService ? applicationId : null);
  const rows = invocations.data ?? [];
  const svc = services.data ?? [];

  // Execution only earns space when there is something to show: a registered service
  // endpoint or at least one durable invocation involving this agent.
  if (!isService && !invocations.isLoading && rows.length === 0) return null;

  return (
    <section className="border-t border-border pt-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        Execution
      </h3>

      {isService ? (
        services.isLoading ? (
          <Skeleton className="mt-3 h-10 w-full" />
        ) : svc.length > 0 ? (
          <div className="mt-3 flex flex-col gap-2">
            {svc.map((s) => (
              <div key={s.id} className="border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-xs text-foreground">
                    {s.endpoint_url}
                  </span>
                  <Badge tone={s.health === "healthy" ? "success" : s.health ? "warning" : "muted"}>
                    {s.health ?? "unknown"}
                  </Badge>
                </div>
                <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                  {s.framework_name ? (
                    <span>
                      {s.framework_name}
                      {s.framework_version ? ` ${s.framework_version}` : ""}
                    </span>
                  ) : null}
                  {s.protocol_versions.length > 0 ? (
                    <span>proto {s.protocol_versions.join(", ")}</span>
                  ) : null}
                  {s.last_heartbeat_at ? (
                    <span>heartbeat {relativeTime(s.last_heartbeat_at)}</span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            No registered service endpoint for this agent&apos;s application.
          </p>
        )
      ) : null}

      <div className="mt-3">
        <span className="text-xs text-muted-foreground">Recent invocations ({rows.length})</span>
        {invocations.isLoading ? (
          <Skeleton className="mt-2 h-12 w-full" />
        ) : rows.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">No invocations yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-border border-y border-border">
            {rows.slice(0, 8).map((inv) => (
              <li key={inv.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="truncate font-mono text-xs text-foreground">{inv.method}</div>
                  <div className="font-mono text-[10px] text-muted-foreground">
                    {inv.attempts}/{inv.max_attempts} attempts ·{" "}
                    {inv.completed_at
                      ? `done ${relativeTime(inv.completed_at)}`
                      : inv.deadline_at
                        ? `deadline ${relativeTime(inv.deadline_at)}`
                        : `created ${relativeTime(inv.created_at)}`}
                  </div>
                </div>
                <Badge tone={invocationTone(inv.status)}>{inv.status.replace(/_/g, " ")}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function Metric({ label, value, text }: { label: string; value?: number; text?: string }) {
  return (
    <div className="p-3">
      <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold tracking-tight text-foreground">
        {value !== undefined ? value : text}
      </div>
    </div>
  );
}
