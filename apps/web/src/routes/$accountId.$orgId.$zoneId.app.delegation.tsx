/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Delegation workspace for authority relationships, chains, and impact.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";

import { DelegationInspector } from "@/components/console/DelegationInspector";
import {
  delegationErrorMessage,
  edgeStatusLabel,
  edgeStatusTone,
  shortId,
} from "@/components/console/delegationFormat";
import { FeedToolbar } from "@/components/console/FeedToolbar";
import { Mono, ResourceWorkspace } from "@/components/console/ResourceWorkspace";
import { ZoneScopedPage } from "@/components/console/ZoneScope";
import { Badge, Button, type Column } from "@/components/ui";
import { ConsoleApiError } from "@/platform/api/client";
import { useDelegationsFeed } from "@/platform/api/hooks";
import type { DelegationEdge } from "@/platform/api/types";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/delegation")({
  component: DelegationRoute,
  validateSearch: (search: Record<string, unknown>): { focus?: string } => ({
    focus: typeof search.focus === "string" ? search.focus : undefined,
  }),
});

function DelegationRoute() {
  return (
    <ZoneScopedPage
      title="Delegation"
      description="The graph of delegated authority between agent sessions in this zone."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Delegation" }]}
    >
      {(zone) => <DelegationPage zoneId={zone.id} />}
    </ZoneScopedPage>
  );
}

function DelegationPage({ zoneId }: { zoneId: string }) {
  const feed = useDelegationsFeed(zoneId);

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
      title="Delegation"
      description="Active delegation edges. Each edge grants one agent session authority to act on another's behalf within scope."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Delegation" }]}
      toolbarExtra={
        <FeedToolbar
          loaded={rows.length}
          noun="edge"
          hasMore={Boolean(feed.hasNextPage)}
          fetchingMore={feed.isFetchingNextPage}
          onLoadMore={() => feed.fetchNextPage()}
        />
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
          ? delegationErrorMessage(feed.error)
          : "When agent sessions delegate authority to one another, the active edges appear here with their chains and impact.",
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
