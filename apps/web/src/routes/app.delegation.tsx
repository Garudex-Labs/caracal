/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Delegation workspace for authority relationships, chains, and impact.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { LiveBadge } from "@/components/console/LiveBadge";
import {
  DetailField,
  DetailGroup,
  Mono,
  ResourceWorkspace,
} from "@/components/console/ResourceWorkspace";
import { ZoneScopedPage } from "@/components/console/ZoneScope";
import { Badge, Button, ConfirmDialog, Skeleton, useToast, type Column } from "@/components/ui";
import { consoleApi, ConsoleApiError } from "@/platform/api/client";
import { useActiveDelegations, useConsoleStatus, useRevokeDelegation } from "@/platform/api/hooks";
import type { DelegationEdge, DelegationHop, DelegationImpactRow } from "@/platform/api/types";

export const Route = createFileRoute("/app/delegation")({
  component: DelegationRoute,
});

function DelegationRoute() {
  return (
    <ZoneScopedPage
      title="Delegation"
      description="The graph of delegated authority between agent sessions in this zone."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Delegation" }]}
    >
      {(zone) => <DelegationGate zoneId={zone.id} />}
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

function short(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function DelegationGate({ zoneId }: { zoneId: string }) {
  const status = useConsoleStatus();
  const coordinatorReady = status.data?.coordinatorConfigured && status.data?.coordinatorReachable;

  if (status.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!coordinatorReady) {
    return (
      <div className="border border-border p-6">
        <h2 className="text-base font-semibold tracking-tight text-foreground">
          {status.data?.coordinatorConfigured
            ? "Coordinator unreachable"
            : "Coordinator not connected"}
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Delegation edges are maintained by the Caracal Coordinator runtime. Start the local stack
          with <Mono>caracal up</Mono> and confirm the runtime is running, then retry.
        </p>
        <div className="mt-5">
          <Button variant="secondary" size="sm" onClick={() => status.refetch()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }
  return <DelegationPage zoneId={zoneId} />;
}

function DelegationPage({ zoneId }: { zoneId: string }) {
  const toast = useToast();
  const query = useActiveDelegations(zoneId);
  const revoke = useRevokeDelegation(zoneId);
  const [revokeTarget, setRevokeTarget] = useState<DelegationEdge | null>(null);

  const rows = useMemo(() => query.data ?? [], [query.data]);

  const columns: Column<DelegationEdge>[] = [
    {
      id: "edge",
      header: "Delegation",
      cell: (e) => (
        <div className="flex items-center gap-2 font-mono text-xs">
          <span className="text-foreground">{short(e.source_session_id)}</span>
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
          <span className="text-foreground">{short(e.target_session_id)}</span>
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
          {e.scopes.length === 0 ? <span className="text-xs text-muted-foreground">—</span> : null}
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: (e) => <Badge tone="success">{e.status}</Badge>,
    },
    {
      id: "expires",
      header: "Expires",
      align: "right",
      cell: (e) => (
        <span className="text-xs text-muted-foreground">
          {e.expires_at ? new Date(e.expires_at).toLocaleString() : "—"}
        </span>
      ),
    },
  ];

  return (
    <>
      <ResourceWorkspace
        title="Delegation"
        description="Active delegation edges. Each edge grants one agent session authority to act on another's behalf within scope."
        breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Delegation" }]}
        headerExtra={<LiveBadge label="Live · refreshes every 10s" />}
        rows={rows}
        loading={query.isLoading}
        columns={columns}
        rowKey={(e) => e.id}
        pageSize={12}
        search={{
          placeholder: "Search by session or scope…",
          match: (e, q) =>
            e.source_session_id.toLowerCase().includes(q) ||
            e.target_session_id.toLowerCase().includes(q) ||
            e.scopes.some((s) => s.toLowerCase().includes(q)),
        }}
        sortOptions={[{ id: "recent", label: "Most recent" }]}
        empty={{
          title: query.isError ? "Could not load delegations" : "No active delegations",
          description: query.isError
            ? errorMessage(query.error)
            : "When agent sessions delegate authority to one another, the active edges appear here with their chains and impact.",
        }}
        detail={{
          title: (e) => `${short(e.source_session_id)} → ${short(e.target_session_id)}`,
          description: (e) => e.id,
          width: "max-w-2xl",
          render: (e) => (
            <DelegationInspector zoneId={zoneId} edge={e} onRevoke={() => setRevokeTarget(e)} />
          ),
        }}
      />

      <ConfirmDialog
        open={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        title="Revoke delegation"
        description="Revoking this edge immediately removes the delegated authority and cascades to every session downstream in its chain. This cannot be undone."
        confirmLabel="Revoke delegation"
        tone="danger"
        onConfirm={async () => {
          if (!revokeTarget) return;
          try {
            await revoke.mutateAsync(revokeTarget.id);
            toast({ tone: "info", title: "Delegation revoked" });
          } catch (err) {
            toast({ tone: "error", title: "Revoke failed", description: errorMessage(err) });
          }
        }}
      />
    </>
  );
}

function DelegationInspector({
  zoneId,
  edge,
  onRevoke,
}: {
  zoneId: string;
  edge: DelegationEdge;
  onRevoke: () => void;
}) {
  const [tab, setTab] = useState<"chain" | "impact">("chain");
  const [chain, setChain] = useState<DelegationHop[] | null>(null);
  const [impact, setImpact] = useState<DelegationImpactRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seed, setSeed] = useState("");

  if (seed !== edge.id) {
    setSeed(edge.id);
    setChain(null);
    setImpact(null);
    setError(null);
    setLoading(true);
    Promise.all([
      consoleApi.delegations.traverse(zoneId, edge.id),
      consoleApi.delegations.impact(zoneId, edge.id),
    ])
      .then(([traverseRows, impactRows]) => {
        setChain(traverseRows);
        setImpact(impactRows);
      })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setLoading(false));
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="success">{edge.status}</Badge>
        {edge.resource_id ? <Badge tone="neutral">resource-bound</Badge> : null}
        <div className="ml-auto">
          <Button variant="danger" size="sm" onClick={onRevoke}>
            Revoke
          </Button>
        </div>
      </div>

      <DetailGroup title="Edge">
        <DetailField label="Edge ID">
          <Mono>{edge.id}</Mono>
        </DetailField>
        <DetailField label="Source session">
          <Mono>{edge.source_session_id}</Mono>
        </DetailField>
        <DetailField label="Target session">
          <Mono>{edge.target_session_id}</Mono>
        </DetailField>
        {edge.parent_edge_id ? (
          <DetailField label="Parent edge">
            <Mono>{edge.parent_edge_id}</Mono>
          </DetailField>
        ) : null}
        <DetailField label="Created">{new Date(edge.created_at).toLocaleString()}</DetailField>
        {edge.expires_at ? (
          <DetailField label="Expires">{new Date(edge.expires_at).toLocaleString()}</DetailField>
        ) : null}
      </DetailGroup>

      <section className="border-t border-border pt-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Delegated scopes
        </h3>
        {edge.scopes.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {edge.scopes.map((scope) => (
              <span
                key={scope}
                className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
              >
                {scope}
              </span>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">No scopes on this edge.</p>
        )}
      </section>

      <section className="border-t border-border pt-4">
        <div className="flex items-center gap-4 border-b border-border">
          <TabButton active={tab === "chain"} onClick={() => setTab("chain")}>
            Authority chain {chain ? `(${chain.length})` : ""}
          </TabButton>
          <TabButton active={tab === "impact"} onClick={() => setTab("impact")}>
            Revocation impact {impact ? `(${impact.length})` : ""}
          </TabButton>
        </div>

        {loading ? (
          <Skeleton className="mt-4 h-24 w-full" />
        ) : error ? (
          <p className="mt-3 text-sm text-muted-foreground">{error}</p>
        ) : tab === "chain" ? (
          <ChainView hops={chain ?? []} />
        ) : (
          <ImpactView rows={impact ?? []} />
        )}
      </section>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative -mb-px pb-2.5 text-xs font-medium transition-colors ${
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
      {active ? <span className="absolute inset-x-0 -bottom-px h-px bg-foreground" /> : null}
    </button>
  );
}

function ChainView({ hops }: { hops: DelegationHop[] }) {
  if (hops.length === 0) {
    return <p className="mt-3 text-sm text-muted-foreground">No further delegation downstream.</p>;
  }
  return (
    <ol className="mt-4 flex flex-col gap-2">
      {hops.map((hop) => (
        <li key={hop.id} className="flex items-center gap-3">
          <span className="grid h-6 w-6 shrink-0 place-items-center border border-border bg-card font-mono text-[10px] text-muted-foreground">
            {hop.depth}
          </span>
          <div className="flex min-w-0 items-center gap-2 font-mono text-xs">
            <span className="truncate text-foreground">{short(hop.source_session_id)}</span>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="shrink-0 text-muted-foreground"
            >
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
            <span className="truncate text-foreground">{short(hop.target_session_id)}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

function ImpactView({ rows }: { rows: DelegationImpactRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="mt-3 text-sm text-muted-foreground">
        Revoking this edge affects only the target session.
      </p>
    );
  }
  return (
    <div className="mt-4">
      <p className="mb-3 text-xs text-muted-foreground">
        Revoking this delegation cascades to {rows.length} downstream session
        {rows.length === 1 ? "" : "s"}.
      </p>
      <div className="overflow-hidden border border-border">
        <table className="w-full text-sm">
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="px-3 py-2 font-mono text-xs text-foreground">
                  {short(row.target_session_id)}
                </td>
                <td className="px-3 py-2 text-right font-mono text-[11px] text-muted-foreground">
                  depth {row.depth}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
