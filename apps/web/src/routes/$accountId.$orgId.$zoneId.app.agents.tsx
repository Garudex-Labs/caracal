/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Agents runtime workspace for live agent sessions and their lifecycle.
*/
import { appLink } from "@/platform/nav/appLink";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { DelegationInspector } from "@/components/console/DelegationInspector";
import { shortId } from "@/components/console/delegationFormat";
import { FeedToolbar } from "@/components/console/FeedToolbar";
import {
  DetailField,
  DetailGroup,
  Mono,
  ResourceWorkspace,
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
import { ConsoleApiError } from "@/platform/api/client";
import {
  useAgentChildren,
  useAgentEffectiveAuthority,
  useAgentInboundDelegations,
  useAgentInvocations,
  useAgentLifecycle,
  useAgentOutboundDelegations,
  useAgentServices,
  useAgentsFeed,
} from "@/platform/api/hooks";
import type {
  Agent,
  AgentStatus,
  AgentQuery,
  DelegationEdge,
  InvocationStatus,
} from "@/platform/api/types";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/agents")({
  component: AgentsRoute,
});

function AgentsRoute() {
  return (
    <ZoneScopedPage
      title="Agents"
      description="Live agent sessions and their delegation lineage in this zone."
      breadcrumbs={[{ label: "Console", to: appLink() }, { label: "Agents" }]}
    >
      {(zone) => <AgentsGate zoneId={zone.id} />}
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

function AgentsGate({ zoneId }: { zoneId: string }) {
  return <AgentsPage zoneId={zoneId} />;
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
            Agent sessions are served by the Caracal Coordinator runtime.{" "}
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
// agents at a glance: task agents are governed by TTL, service agents by heartbeat lease.
function liveness(agent: Agent, now = Date.now()): Liveness {
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
        detail: "Service agent has not reported a heartbeat",
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

function relativeTime(iso: string, now = Date.now()): string {
  const diff = Date.parse(iso) - now;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? "from now" : "ago";
  const mins = Math.round(abs / 60_000);
  if (mins < 1) return diff >= 0 ? "in <1m" : "<1m ago";
  if (mins < 60) return `${mins}m ${suffix}`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ${suffix}`;
  return `${Math.round(hrs / 24)}d ${suffix}`;
}

function AgentsPage({ zoneId }: { zoneId: string }) {
  const toast = useToast();
  const lifecycle = useAgentLifecycle(zoneId);

  const [status, setStatus] = useState<string>("all");
  const [lifecycleFilter, setLifecycleFilter] = useState<string>("all");
  const [application, setApplication] = useState("");
  const [label, setLabel] = useState("");
  const [confirm, setConfirm] = useState<{
    agent: Agent;
    action: "suspend" | "resume" | "terminate";
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
      toast({ tone: action === "terminate" ? "info" : "success", title: `Agent ${verb}` });
    } catch (err) {
      toast({ tone: "error", title: "Action failed", description: errorMessage(err) });
    }
  }

  if (coordinatorDown) {
    return (
      <ModulePage
        title="Agents"
        description="Live agent sessions and their delegation lineage in this zone."
        breadcrumbs={[{ label: "Console", to: appLink() }, { label: "Agents" }]}
      >
        <CoordinatorOffline code={coordError as string} onRetry={() => feed.refetch()} />
      </ModulePage>
    );
  }

  const columns: Column<Agent>[] = [
    {
      id: "agent",
      header: "Agent session",
      cell: (a) => (
        <div className="min-w-0">
          <div className="truncate font-mono text-xs text-foreground">{a.agent_session_id}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            <span className="font-mono text-[10px] text-muted-foreground">{a.application_id}</span>
            {a.labels.slice(0, 2).map((l) => (
              <span
                key={l}
                className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                {l}
              </span>
            ))}
            {a.labels.length > 2 ? (
              <span className="text-[10px] text-muted-foreground">+{a.labels.length - 2}</span>
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
      id: "status",
      header: "Status",
      cell: (a) => <Badge tone={statusTone(a.status)}>{a.status}</Badge>,
    },
    {
      id: "lifecycle",
      header: "Lifecycle",
      cell: (a) => <span className="text-xs text-muted-foreground">{a.lifecycle}</span>,
    },
    {
      id: "depth",
      header: "Depth",
      cell: (a) => (
        <span className="font-mono text-xs text-muted-foreground">
          {a.depth === 0 ? "root" : `d${a.depth}`}
        </span>
      ),
    },
    {
      id: "expires",
      header: "Expires",
      align: "right",
      cell: (a) => <span className="text-xs text-muted-foreground">{agentExpiry(a)}</span>,
    },
  ];

  return (
    <>
      <ResourceWorkspace
        title="Agents"
        description="Live agent sessions, their authority, and delegation lineage in this zone."
        breadcrumbs={[{ label: "Console", to: appLink() }, { label: "Agents" }]}
        toolbarExtra={
          <AgentFilterBar
            status={status}
            lifecycle={lifecycleFilter}
            application={application}
            label={label}
            loaded={rows.length}
            hasMore={Boolean(feed.hasNextPage)}
            fetchingMore={feed.isFetchingNextPage}
            onStatus={setStatus}
            onLifecycle={setLifecycleFilter}
            onApplication={setApplication}
            onLabel={setLabel}
            onLoadMore={() => feed.fetchNextPage()}
          />
        }
        rows={rows}
        loading={feed.isLoading}
        columns={columns}
        rowKey={(a) => a.agent_session_id}
        pageSize={12}
        search={{
          placeholder: "Filter loaded agents by session, app, or label…",
          match: (a, q) =>
            a.agent_session_id.toLowerCase().includes(q) ||
            a.application_id.toLowerCase().includes(q) ||
            a.lifecycle.toLowerCase().includes(q) ||
            a.labels.some((l) => l.toLowerCase().includes(q)),
        }}
        empty={{
          title: feed.isError ? "Could not load agents" : "No agent sessions",
          description: feed.isError
            ? errorMessage(feed.error)
            : "Agent sessions appear here as the Coordinator spawns them in this zone.",
        }}
        detail={{
          title: (a) => a.agent_session_id,
          description: (a) => `${a.lifecycle} · ${a.status}`,
          width: "max-w-2xl",
          render: (a) => (
            <AgentInspector
              zoneId={zoneId}
              agent={a}
              busy={lifecycle.isPending}
              onSuspend={() => setConfirm({ agent: a, action: "suspend" })}
              onResume={() => setConfirm({ agent: a, action: "resume" })}
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

// Server-side agent filters + cursor pagination. Filters run against the Coordinator so
// large zones stay searchable; "Load more" follows the keyset cursor.
function AgentFilterBar({
  status,
  lifecycle,
  application,
  label,
  loaded,
  hasMore,
  fetchingMore,
  onStatus,
  onLifecycle,
  onApplication,
  onLabel,
  onLoadMore,
}: {
  status: string;
  lifecycle: string;
  application: string;
  label: string;
  loaded: number;
  hasMore: boolean;
  fetchingMore: boolean;
  onStatus: (v: string) => void;
  onLifecycle: (v: string) => void;
  onApplication: (v: string) => void;
  onLabel: (v: string) => void;
  onLoadMore: () => void;
}) {
  const activeFilters =
    (status !== "all" ? 1 : 0) +
    (lifecycle !== "all" ? 1 : 0) +
    [application, label].filter((v) => v.trim()).length;
  return (
    <FeedToolbar
      activeFilters={activeFilters}
      loaded={loaded}
      noun="agent"
      hasMore={hasMore}
      fetchingMore={fetchingMore}
      onLoadMore={onLoadMore}
    >
      <Select label="Status" value={status} onChange={(e) => onStatus(e.target.value)}>
        <option value="all">All statuses</option>
        <option value="active">Active</option>
        <option value="suspended">Suspended</option>
        <option value="terminated">Terminated</option>
      </Select>
      <Select label="Lifecycle" value={lifecycle} onChange={(e) => onLifecycle(e.target.value)}>
        <option value="all">All lifecycles</option>
        <option value="task">Task</option>
        <option value="service">Service</option>
      </Select>
      <Field
        label="Application"
        placeholder="application id"
        value={application}
        onChange={(e) => onApplication(e.target.value)}
      />
      <Field
        label="Label"
        placeholder="exact label"
        value={label}
        onChange={(e) => onLabel(e.target.value)}
      />
    </FeedToolbar>
  );
}

// Lifecycle confirmation that previews the cascade blast radius. Suspend and terminate
// recurse the agent subtree and revoke subject sessions on the backend, so the operator
// sees the direct child sessions that will be affected before committing.
function AgentLifecycleConfirm({
  zoneId,
  request,
  onClose,
  onConfirm,
}: {
  zoneId: string;
  request: { agent: Agent; action: "suspend" | "resume" | "terminate" } | null;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const cascades = request?.action !== "resume";
  const children = useAgentChildren(
    zoneId,
    cascades && request ? request.agent.agent_session_id : null,
  );
  const childCount = (children.data ?? []).length;

  if (!request) return null;
  const { action } = request;
  const title =
    action === "suspend"
      ? "Suspend agent session"
      : action === "resume"
        ? "Resume agent session"
        : "Terminate agent session";
  const base =
    action === "suspend"
      ? "Suspending pauses this agent's authority and cascades to its descendant agents. Subject sessions held only by the suspended subtree are revoked. In-flight work may fail until resumed."
      : action === "resume"
        ? "Resuming restores this agent's authority and reactivates its suspended subtree."
        : "Terminating ends this agent and its entire descendant subtree immediately, revoking their authority and subject sessions. This cannot be undone.";

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      description={`${request.agent.lifecycle} agent · depth ${request.agent.depth}`}
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
            {action === "suspend" ? "Suspend" : action === "resume" ? "Resume" : "Terminate"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">{base}</p>
        {cascades ? (
          <div className="border border-border bg-muted/20 p-3 text-xs">
            {children.isLoading ? (
              <span className="flex items-center gap-2 text-muted-foreground">
                <Spinner className="h-3.5 w-3.5" /> Checking cascade impact…
              </span>
            ) : childCount === 0 ? (
              <span className="text-muted-foreground">
                No direct child sessions. Only this agent is affected.
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
                    <li
                      key={c.agent_session_id}
                      className="flex items-center justify-between gap-2"
                    >
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
        ) : null}
      </div>
    </Modal>
  );
}

function AgentInspector({
  zoneId,
  agent,
  busy,
  onSuspend,
  onResume,
  onTerminate,
}: {
  zoneId: string;
  agent: Agent;
  busy: boolean;
  onSuspend: () => void;
  onResume: () => void;
  onTerminate: () => void;
}) {
  const authority = useAgentEffectiveAuthority(zoneId, agent.agent_session_id);
  const children = useAgentChildren(zoneId, agent.agent_session_id);
  const terminal = agent.status === "terminated";
  const metadata = agent.metadata ?? {};
  const live = liveness(agent);
  const toast = useToast();

  function copy(value: string, label: string) {
    void navigator.clipboard?.writeText(value);
    toast({ tone: "success", title: `${label} copied` });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={statusTone(agent.status)}>{agent.status}</Badge>
        <Badge tone="neutral">{agent.lifecycle}</Badge>
        <Badge tone="muted">{agent.depth === 0 ? "root" : `depth ${agent.depth}`}</Badge>
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

      <div
        className={cx(
          "flex items-center gap-3 border px-3 py-2.5",
          live.tone === "danger"
            ? "border-destructive/40 bg-destructive/5"
            : live.tone === "warning"
              ? "border-amber-500/40 bg-amber-500/5"
              : live.tone === "success"
                ? "border-emerald-500/30 bg-emerald-500/5"
                : "border-border bg-muted/20",
        )}
      >
        <span
          className={cx(
            "inline-block h-2 w-2 rounded-full",
            live.tone === "danger"
              ? "bg-destructive"
              : live.tone === "warning"
                ? "bg-amber-500"
                : live.tone === "success"
                  ? "bg-emerald-500"
                  : "bg-muted-foreground",
          )}
        />
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{live.label}</div>
          <div className="text-xs text-muted-foreground">{live.detail}</div>
        </div>
      </div>

      <DetailGroup title="Identity">
        <DetailField label="Agent session">
          <button
            onClick={() => copy(agent.agent_session_id, "Session ID")}
            className="text-left hover:underline"
          >
            <Mono>{agent.agent_session_id}</Mono>
          </button>
        </DetailField>
        <DetailField label="Application">
          <Link
            to={appLink("/applications")}
            className="font-mono text-xs text-foreground hover:underline"
          >
            {agent.application_id}
          </Link>
        </DetailField>
        {agent.parent_id ? (
          <DetailField label="Parent session">
            <Mono>{agent.parent_id}</Mono>
          </DetailField>
        ) : null}
        {agent.subject_session_id ? (
          <DetailField label="Subject session">
            <Link
              to={appLink("/sessions")}
              search={{ subject: agent.subject_session_id }}
              className="font-mono text-xs text-foreground hover:underline"
            >
              {agent.subject_session_id}
            </Link>
          </DetailField>
        ) : null}
      </DetailGroup>

      <DetailGroup title="Lifecycle">
        <DetailField label="Spawned">{new Date(agent.spawned_at).toLocaleString()}</DetailField>
        {agent.ttl_seconds != null ? (
          <DetailField label="TTL">
            {agent.ttl_seconds}s
            {agent.status === "active" && agent.lifecycle === "task" ? (
              <span className="ml-1 text-muted-foreground">· expires {agentExpiry(agent)}</span>
            ) : null}
          </DetailField>
        ) : null}
        {agent.last_heartbeat_at ? (
          <DetailField label="Last heartbeat">
            {new Date(agent.last_heartbeat_at).toLocaleString()}
          </DetailField>
        ) : null}
        {agent.heartbeat_deadline_at ? (
          <DetailField label="Heartbeat lease">
            {new Date(agent.heartbeat_deadline_at).toLocaleString()}
          </DetailField>
        ) : null}
        {agent.terminated_at ? (
          <DetailField label="Terminated">
            {new Date(agent.terminated_at).toLocaleString()}
          </DetailField>
        ) : null}
      </DetailGroup>

      <AuthorityEnvelope authority={authority} />

      <AgentDelegations zoneId={zoneId} sessionId={agent.agent_session_id} />

      <AgentExecution
        zoneId={zoneId}
        sessionId={agent.agent_session_id}
        applicationId={agent.application_id}
        isService={agent.lifecycle === "service"}
      />

      <section className="border-t border-border pt-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Child sessions
        </h3>
        {children.isLoading ? (
          <Skeleton className="mt-3 h-12 w-full" />
        ) : (children.data ?? []).length > 0 ? (
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
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">No child sessions.</p>
        )}
      </section>

      {agent.labels.length > 0 ? (
        <section className="border-t border-border pt-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Labels
          </h3>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {agent.labels.map((l) => (
              <span
                key={l}
                className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
              >
                {l}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {Object.keys(metadata).length > 0 ? (
        <section className="border-t border-border pt-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Metadata
          </h3>
          <div className="mt-3 max-h-64 overflow-auto border border-border">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border">
                {Object.entries(metadata).map(([key, value]) => (
                  <tr key={key}>
                    <td className="w-2/5 px-3 py-2 align-top font-mono text-xs text-muted-foreground">
                      {key}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-foreground">
                      {typeof value === "object" ? JSON.stringify(value) : String(value)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

// Full effective-authority envelope. The Coordinator intersects every active inbound edge
// into scopes/resources/hops/ttl/expiry; surfacing all of it (not just scopes) lets an
// operator see the agent's complete runtime authority boundary.
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
              <div className="grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-4 [&>*]:bg-background">
                <Metric label="Inbound edges" value={a.inbound_edges.length} />
                <Metric
                  label="Max hops"
                  text={a.effective_max_hops == null ? "∞" : String(a.effective_max_hops)}
                />
                <Metric
                  label="TTL"
                  text={a.effective_ttl_seconds == null ? "-" : `${a.effective_ttl_seconds}s`}
                />
                <Metric
                  label="Expires"
                  text={a.earliest_expires_at ? relativeTime(a.earliest_expires_at) : "-"}
                />
              </div>

              {noAuthority ? (
                <p className="text-sm text-muted-foreground">
                  No inbound delegations. This agent acts only under its own application authority.
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
                        Scope intersection is empty: inbound edges share no common scope.
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

// Inbound/outbound delegation edges for the agent, keyed by its agent session. Inbound =
// authority the agent received; outbound = authority it granted onward.
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
          No {tab} delegation edges.{" "}
          <Link to={appLink("/delegation")} className="text-foreground hover:underline">
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

// Read-only execution lens. Surfaces durable invocations involving this agent and, for
// service agents, the registered service endpoint + health. Payloads are never exposed;
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
          <p className="mt-1 text-xs text-muted-foreground">
            No invocations involve this agent session. Invocations are issued by the runtime; this
            view is read-only.
          </p>
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
