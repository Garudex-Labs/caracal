/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Agents runtime workspace for live agent sessions and their lifecycle.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import {
  DetailField,
  DetailGroup,
  Mono,
  ResourceWorkspace,
} from "@/components/console/ResourceWorkspace";
import { LiveBadge } from "@/components/console/LiveBadge";
import { ZoneScopedPage } from "@/components/console/ZoneScope";
import { Badge, Button, ConfirmDialog, Skeleton, useToast, type Column } from "@/components/ui";
import { cx } from "@/lib/cx";
import { ConsoleApiError } from "@/platform/api/client";
import {
  useAgentChildren,
  useAgentEffectiveAuthority,
  useAgentLifecycle,
  useAgents,
  useConsoleStatus,
} from "@/platform/api/hooks";
import type { Agent, AgentStatus } from "@/platform/api/types";

export const Route = createFileRoute("/app/agents")({
  component: AgentsRoute,
});

function AgentsRoute() {
  return (
    <ZoneScopedPage
      title="Agents"
      description="Live agent sessions and their delegation lineage in this zone."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Agents" }]}
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
  const status = useConsoleStatus();
  const coordinatorReady = status.data?.coordinatorConfigured && status.data?.coordinatorReachable;

  if (status.isLoading) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (!coordinatorReady) {
    return <CoordinatorOffline status={status.data} onRetry={() => status.refetch()} />;
  }
  return <AgentsPage zoneId={zoneId} />;
}

function CoordinatorOffline({
  status,
  onRetry,
}: {
  status: { coordinatorConfigured?: boolean; coordinatorUrl?: string } | undefined;
  onRetry: () => void;
}) {
  const configured = status?.coordinatorConfigured;
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
            Agent sessions are served by the Caracal Coordinator runtime
            {status?.coordinatorUrl ? (
              <>
                {" "}
                at <Mono>{status.coordinatorUrl}</Mono>
              </>
            ) : null}
            .{" "}
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

type StatusFilter = "all" | AgentStatus;

function statusTone(status: AgentStatus): "success" | "warning" | "muted" {
  if (status === "active") return "success";
  if (status === "suspended") return "warning";
  return "muted";
}

function AgentsPage({ zoneId }: { zoneId: string }) {
  const toast = useToast();
  const query = useAgents(zoneId);
  const lifecycle = useAgentLifecycle(zoneId);

  const [filter, setFilter] = useState<StatusFilter>("all");
  const [confirm, setConfirm] = useState<{ agent: Agent; action: "terminate" } | null>(null);

  const allRows = useMemo(() => query.data ?? [], [query.data]);
  const counts = useMemo(() => {
    const c = { active: 0, suspended: 0, terminated: 0 };
    for (const a of allRows) c[a.status] += 1;
    return c;
  }, [allRows]);

  const rows = useMemo(
    () => (filter === "all" ? allRows : allRows.filter((a) => a.status === filter)),
    [allRows, filter],
  );

  async function runLifecycle(agent: Agent, action: "suspend" | "resume" | "terminate") {
    try {
      await lifecycle.mutateAsync({ id: agent.agent_session_id, action });
      const label =
        action === "suspend" ? "suspended" : action === "resume" ? "resumed" : "terminated";
      toast({ tone: action === "terminate" ? "info" : "success", title: `Agent ${label}` });
    } catch (err) {
      toast({ tone: "error", title: "Action failed", description: errorMessage(err) });
    }
  }

  const columns: Column<Agent>[] = [
    {
      id: "agent",
      header: "Agent session",
      cell: (a) => (
        <div className="min-w-0">
          <div className="truncate font-mono text-xs text-foreground">{a.agent_session_id}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            {a.labels.slice(0, 3).map((label) => (
              <span
                key={label}
                className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                {label}
              </span>
            ))}
            {a.labels.length > 3 ? (
              <span className="text-[10px] text-muted-foreground">+{a.labels.length - 3}</span>
            ) : null}
          </div>
        </div>
      ),
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
      id: "spawned",
      header: "Spawned",
      sortable: true,
      align: "right",
      cell: (a) => (
        <span className="text-xs text-muted-foreground">
          {new Date(a.spawned_at).toLocaleString()}
        </span>
      ),
    },
  ];

  return (
    <>
      <ResourceWorkspace
        title="Agents"
        description="Live agent sessions and their delegation lineage in this zone."
        breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Agents" }]}
        headerExtra={
          <div className="flex flex-wrap items-center justify-between gap-3">
            <StatusFilterBar
              filter={filter}
              total={allRows.length}
              counts={counts}
              onSelect={setFilter}
            />
            <LiveBadge label="Live · refreshes every 10s" />
          </div>
        }
        rows={rows}
        loading={query.isLoading}
        columns={columns}
        rowKey={(a) => a.agent_session_id}
        pageSize={12}
        search={{
          placeholder: "Search by session, label, or lifecycle…",
          match: (a, q) =>
            a.agent_session_id.toLowerCase().includes(q) ||
            a.lifecycle.toLowerCase().includes(q) ||
            a.labels.some((l) => l.toLowerCase().includes(q)),
        }}
        sortOptions={[{ id: "recent", label: "Most recent" }]}
        empty={{
          title: query.isError ? "Could not load agents" : "No agent sessions",
          description: query.isError
            ? errorMessage(query.error)
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
              onSuspend={() => runLifecycle(a, "suspend")}
              onResume={() => runLifecycle(a, "resume")}
              onTerminate={() => setConfirm({ agent: a, action: "terminate" })}
            />
          ),
        }}
      />

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title="Terminate agent session"
        description={`Terminating this agent session ends it and revokes its authority immediately. Child sessions are cascaded. This cannot be undone.`}
        confirmLabel="Terminate"
        tone="danger"
        onConfirm={async () => {
          if (confirm) await runLifecycle(confirm.agent, "terminate");
        }}
      />
    </>
  );
}

function StatusFilterBar({
  filter,
  total,
  counts,
  onSelect,
}: {
  filter: StatusFilter;
  total: number;
  counts: { active: number; suspended: number; terminated: number };
  onSelect: (filter: StatusFilter) => void;
}) {
  const chips: { id: StatusFilter; label: string; count: number }[] = [
    { id: "all", label: "All", count: total },
    { id: "active", label: "Active", count: counts.active },
    { id: "suspended", label: "Suspended", count: counts.suspended },
    { id: "terminated", label: "Terminated", count: counts.terminated },
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((chip) => (
        <button
          key={chip.id}
          onClick={() => onSelect(chip.id)}
          className={cx(
            "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
            filter === chip.id
              ? "border-foreground/20 bg-accent text-foreground"
              : "border-border text-muted-foreground hover:bg-surface hover:text-foreground",
          )}
        >
          {chip.label}
          <span className="font-mono text-[10px] text-muted-foreground">{chip.count}</span>
        </button>
      ))}
    </div>
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

      <DetailGroup title="Identity">
        <DetailField label="Agent session">
          <Mono>{agent.agent_session_id}</Mono>
        </DetailField>
        <DetailField label="Application">
          <Mono>{agent.application_id}</Mono>
        </DetailField>
        {agent.parent_id ? (
          <DetailField label="Parent session">
            <Mono>{agent.parent_id}</Mono>
          </DetailField>
        ) : null}
        {agent.subject_session_id ? (
          <DetailField label="Subject session">
            <Mono>{agent.subject_session_id}</Mono>
          </DetailField>
        ) : null}
      </DetailGroup>

      <DetailGroup title="Lifecycle">
        <DetailField label="Spawned">{new Date(agent.spawned_at).toLocaleString()}</DetailField>
        {agent.ttl_seconds != null ? (
          <DetailField label="TTL">{agent.ttl_seconds}s</DetailField>
        ) : null}
        {agent.last_heartbeat_at ? (
          <DetailField label="Last heartbeat">
            {new Date(agent.last_heartbeat_at).toLocaleString()}
          </DetailField>
        ) : null}
        {agent.terminated_at ? (
          <DetailField label="Terminated">
            {new Date(agent.terminated_at).toLocaleString()}
          </DetailField>
        ) : null}
      </DetailGroup>

      {agent.labels.length > 0 ? (
        <section className="border-t border-border pt-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Labels
          </h3>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {agent.labels.map((label) => (
              <span
                key={label}
                className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
              >
                {label}
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
          <div className="mt-3 overflow-hidden border border-border">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border">
                {Object.entries(metadata).map(([key, value]) => (
                  <tr key={key}>
                    <td className="w-2/5 px-3 py-2 font-mono text-xs text-muted-foreground">
                      {key}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-foreground">{String(value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="border-t border-border pt-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Effective authority
        </h3>
        {authority.isLoading ? (
          <Skeleton className="mt-3 h-16 w-full" />
        ) : authority.isError ? (
          <p className="mt-2 text-sm text-muted-foreground">{errorMessage(authority.error)}</p>
        ) : authority.data ? (
          <div className="mt-3 flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-px border border-border bg-border [&>*]:bg-background">
              <Metric label="Inbound edges" value={authority.data.inbound_edges.length} />
              <Metric label="Max hops" value={authority.data.effective_max_hops} />
            </div>
            <div>
              <span className="text-xs text-muted-foreground">Scopes</span>
              {authority.data.effective_scopes.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {authority.data.effective_scopes.map((scope) => (
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
                  No delegated scopes — this agent acts only under its own application authority.
                </p>
              )}
            </div>
          </div>
        ) : null}
      </section>

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
                <Badge tone={statusTone(child.status)}>{child.status}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">No child sessions.</p>
        )}
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="p-3">
      <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold tracking-tight text-foreground">{value}</div>
    </div>
  );
}
