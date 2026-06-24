/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Delegation workspace for authority relationships, chains, and impact.
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
import { Badge, Button, ConfirmDialog, Skeleton, useToast, type Column } from "@/components/ui";
import { consoleApi, ConsoleApiError } from "@/platform/api/client";
import { useDelegationsFeed, useRevokeDelegation } from "@/platform/api/hooks";
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

// A delegation edge can be active, revoked, or expired; render each with an honest tone so a
// no-longer-usable edge never appears healthy. (The coordinator's active feed returns active
// edges, but the status is authoritative and an edge can expire while loaded.)
function statusTone(edge: DelegationEdge): "success" | "danger" | "muted" {
  if (edge.status === "revoked") return "danger";
  if (edge.status === "expired") return "danger";
  if (edge.expires_at && Date.parse(edge.expires_at) <= Date.now()) return "muted";
  return "success";
}

function statusLabel(edge: DelegationEdge): string {
  if (edge.status === "active" && edge.expires_at && Date.parse(edge.expires_at) <= Date.now()) {
    return "expiring";
  }
  return edge.status;
}

interface DecodedConstraint {
  label: string;
  value: string;
}

// constraints_json carries the typed limits the control plane enforces (max hops, scope
// budget, TTL, resource set, policy approval, hard expiry). Surfacing them lets an operator
// understand WHY an edge's authority is bounded rather than treating the edge as opaque.
function decodeConstraints(raw: Record<string, unknown> | null): DecodedConstraint[] {
  if (!raw) return [];
  const out: DecodedConstraint[] = [];
  const num = (key: string, label: string, suffix = "") => {
    const v = raw[key];
    if (typeof v === "number" && Number.isFinite(v)) out.push({ label, value: `${v}${suffix}` });
  };
  num("max_hops", "Max hops");
  num("max_depth", "Max depth");
  num("budget", "Scope budget");
  num("ttl_seconds", "Max TTL", "s");
  if (typeof raw.expires_at === "string") {
    out.push({ label: "Hard expiry", value: new Date(raw.expires_at).toLocaleString() });
  }
  if (Array.isArray(raw.resources) && raw.resources.length > 0) {
    out.push({ label: "Resource set", value: raw.resources.join(", ") });
  }
  if (typeof raw.policy_approved === "boolean") {
    out.push({ label: "Policy approved", value: raw.policy_approved ? "yes" : "no" });
  }
  if (typeof raw.broad_reason === "string" && raw.broad_reason.trim() !== "") {
    out.push({ label: "Broad reason", value: raw.broad_reason });
  }
  return out;
}

function DelegationGate({ zoneId }: { zoneId: string }) {
  return <DelegationPage zoneId={zoneId} />;
}

function DelegationPage({ zoneId }: { zoneId: string }) {
  const toast = useToast();
  const feed = useDelegationsFeed(zoneId);
  const revoke = useRevokeDelegation(zoneId);
  const [revokeTarget, setRevokeTarget] = useState<DelegationEdge | null>(null);

  const rows = useMemo(() => (feed.data?.pages ?? []).flatMap((p) => p.rows), [feed.data]);

  const coordError = feed.isError && feed.error instanceof ConsoleApiError ? feed.error.code : null;
  const coordinatorDown =
    coordError === "coordinator_not_configured" || coordError === "upstream_unreachable";

  if (coordinatorDown) {
    return (
      <div className="border border-border p-6">
        <h2 className="text-base font-semibold tracking-tight text-foreground">
          {coordError === "coordinator_not_configured"
            ? "Coordinator not connected"
            : "Coordinator unreachable"}
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Delegation edges are maintained by the Caracal Coordinator runtime. Start the local stack
          with <Mono>caracal up</Mono> and confirm the runtime is running, then retry.
        </p>
        <div className="mt-5">
          <Button variant="secondary" size="sm" onClick={() => feed.refetch()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

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
      cell: (e) => <Badge tone={statusTone(e)}>{statusLabel(e)}</Badge>,
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
        headerExtra={
          <div className="flex items-center justify-between gap-3 border border-border bg-muted/20 px-3 py-2.5">
            <span className="text-xs text-muted-foreground">
              {rows.length} active edge{rows.length === 1 ? "" : "s"} loaded
              {feed.hasNextPage ? " · more available" : ""}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => feed.fetchNextPage()}
              disabled={!feed.hasNextPage}
              loading={feed.isFetchingNextPage}
            >
              {feed.hasNextPage ? "Load more" : "All loaded"}
            </Button>
          </div>
        }
        rows={rows}
        loading={feed.isLoading}
        columns={columns}
        rowKey={(e) => e.id}
        pageSize={12}
        search={{
          placeholder: "Search loaded edges by session or scope…",
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
            ? errorMessage(feed.error)
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

  const constraints = useMemo(
    () => decodeConstraints(edge.constraints_json),
    [edge.constraints_json],
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={statusTone(edge)}>{statusLabel(edge)}</Badge>
        {edge.resource_id ? <Badge tone="neutral">resource-bound</Badge> : null}
        {edge.parent_edge_id ? <Badge tone="muted">inherited</Badge> : null}
        <div className="ml-auto">
          <Button variant="danger" size="sm" onClick={onRevoke} disabled={edge.status !== "active"}>
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
        {edge.issuer_application_id ? (
          <DetailField label="Issuer application">
            <Mono>{edge.issuer_application_id}</Mono>
          </DetailField>
        ) : null}
        {edge.receiver_application_id ? (
          <DetailField label="Receiver application">
            <Mono>{edge.receiver_application_id}</Mono>
          </DetailField>
        ) : null}
        {edge.parent_edge_id ? (
          <DetailField label="Parent edge">
            <Mono>{edge.parent_edge_id}</Mono>
          </DetailField>
        ) : null}
        <DetailField label="Edge version">{edge.edge_version}</DetailField>
        <DetailField label="Created">{new Date(edge.created_at).toLocaleString()}</DetailField>
        {edge.expires_at ? (
          <DetailField label="Expires">{new Date(edge.expires_at).toLocaleString()}</DetailField>
        ) : null}
        {edge.revoked_at ? (
          <DetailField label="Revoked">{new Date(edge.revoked_at).toLocaleString()}</DetailField>
        ) : null}
      </DetailGroup>

      {constraints.length > 0 ? (
        <DetailGroup title="Authority constraints">
          {constraints.map((constraint) => (
            <DetailField key={constraint.label} label={constraint.label}>
              {constraint.value}
            </DetailField>
          ))}
        </DetailGroup>
      ) : null}

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
        {rows.length === 1 ? "" : "s"}. Each row shows the agent session that loses authority and
        the subject session whose access is revoked.
      </p>
      <div className="overflow-hidden border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-left">
              <th className="px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Agent session
              </th>
              <th className="px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Subject session
              </th>
              <th className="px-3 py-2 text-right text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Depth
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="px-3 py-2 font-mono text-xs text-foreground">
                  {short(row.target_session_id)}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                  {row.subject_session_id ? short(row.subject_session_id) : "—"}
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
