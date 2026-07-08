/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides the shared delegation edge inspector with chain, impact, and revocation.
*/
import { useMemo, useState } from "react";

import {
  delegationErrorMessage,
  edgeStatusLabel,
  edgeStatusTone,
  shortId,
} from "@/components/console/delegationFormat";
import { DetailField, DetailGroup, Mono } from "@/components/console/ResourceWorkspace";
import { Badge, Button, ConfirmDialog, Skeleton, useToast } from "@/components/ui";
import { consoleApi } from "@/platform/api/client";
import { useApplications, useResources, useRevokeDelegation } from "@/platform/api/hooks";
import type { DelegationEdge, DelegationHop, DelegationImpact } from "@/platform/api/types";

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

export function DelegationInspector({
  zoneId,
  edge,
  onRevoked,
}: {
  zoneId: string;
  edge: DelegationEdge;
  onRevoked?: () => void;
}) {
  const toast = useToast();
  const revoke = useRevokeDelegation(zoneId);
  const resources = useResources(zoneId);
  const apps = useApplications(zoneId);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [tab, setTab] = useState<"chain" | "impact">("chain");
  const [chain, setChain] = useState<DelegationHop[] | null>(null);
  const [impact, setImpact] = useState<DelegationImpact | null>(null);
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
      .then(([traverseRows, impactRes]) => {
        setChain(traverseRows);
        setImpact(impactRes);
      })
      .catch((err) => setError(delegationErrorMessage(err)))
      .finally(() => setLoading(false));
  }

  const constraints = useMemo(
    () => decodeConstraints(edge.constraints_json),
    [edge.constraints_json],
  );

  const resourceName = useMemo(() => {
    if (!edge.resource_id) return null;
    const match = (resources.data ?? []).find((r) => r.id === edge.resource_id);
    return match?.name ?? null;
  }, [edge.resource_id, resources.data]);

  const appName = (id: string): string | null =>
    (apps.data ?? []).find((app) => app.id === id)?.name ?? null;

  const applicationField = (label: string, id: string) => {
    const name = appName(id);
    return (
      <DetailField label={label}>
        {name ? (
          <span className="flex flex-col gap-0.5">
            <span className="text-foreground">{name}</span>
            <Mono>{id}</Mono>
          </span>
        ) : (
          <Mono>{id}</Mono>
        )}
      </DetailField>
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={edgeStatusTone(edge)}>{edgeStatusLabel(edge)}</Badge>
        {edge.resource_id ? <Badge tone="neutral">resource-bound</Badge> : null}
        {edge.parent_edge_id ? <Badge tone="muted">inherited</Badge> : null}
        <div className="ml-auto">
          <Button
            variant="danger"
            size="sm"
            onClick={() => setConfirmRevoke(true)}
            disabled={edge.status !== "active"}
          >
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
        {edge.resource_id ? (
          <DetailField label="Resource">
            {resourceName ? (
              <span className="flex flex-col gap-0.5">
                <span className="text-foreground">{resourceName}</span>
                <Mono>{edge.resource_id}</Mono>
              </span>
            ) : (
              <Mono>{edge.resource_id}</Mono>
            )}
          </DetailField>
        ) : null}
        {edge.issuer_application_id
          ? applicationField("Issuer application", edge.issuer_application_id)
          : null}
        {edge.receiver_application_id
          ? applicationField("Receiver application", edge.receiver_application_id)
          : null}
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
            Revocation impact {impact ? `(${impact.affected_edges.length})` : ""}
          </TabButton>
        </div>

        {loading ? (
          <Skeleton className="mt-4 h-24 w-full" />
        ) : error ? (
          <p className="mt-3 text-sm text-muted-foreground">{error}</p>
        ) : tab === "chain" ? (
          <ChainView hops={chain ?? []} />
        ) : (
          <ImpactView impact={impact} />
        )}
      </section>

      <ConfirmDialog
        open={confirmRevoke}
        onClose={() => setConfirmRevoke(false)}
        title="Revoke delegation"
        description="Revoking this edge immediately removes the delegated authority and cascades to every session downstream in its chain. This cannot be undone."
        confirmLabel="Revoke delegation"
        tone="danger"
        onConfirm={async () => {
          try {
            await revoke.mutateAsync(edge.id);
            toast({ tone: "info", title: "Delegation revoked" });
            onRevoked?.();
          } catch (err) {
            toast({
              tone: "error",
              title: "Revoke failed",
              description: delegationErrorMessage(err),
            });
          }
        }}
      />
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
            <span className="truncate text-foreground">{shortId(hop.source_session_id)}</span>
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
            <span className="truncate text-foreground">{shortId(hop.target_session_id)}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

function ImpactView({ impact }: { impact: DelegationImpact | null }) {
  const rows = impact?.affected_edges ?? [];
  if (rows.length === 0) {
    return (
      <p className="mt-3 text-sm text-muted-foreground">
        Revoking this edge affects only the target session.
      </p>
    );
  }
  const subjects = impact?.affected_subject_sessions ?? [];
  return (
    <div className="mt-4">
      <p className="mb-3 text-xs text-muted-foreground">
        Revoking this delegation cascades to {rows.length} downstream edge
        {rows.length === 1 ? "" : "s"}. Each row shows the agent session that loses authority.
      </p>
      <div className="overflow-hidden border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-left">
              <th className="px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Agent session
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
                  {shortId(row.target_session_id)}
                </td>
                <td className="px-3 py-2 text-right font-mono text-[11px] text-muted-foreground">
                  depth {row.depth}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {subjects.length > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Subject sessions losing access:{" "}
          <span className="font-mono">{subjects.map((s) => shortId(s)).join(", ")}</span>
        </p>
      ) : null}
    </div>
  );
}
