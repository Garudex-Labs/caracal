/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Policy Sets route.
*/
import { createFileRoute } from "@tanstack/react-router";

import {
  DetailField,
  DetailGroup,
  Mono,
  ResourceWorkspace,
} from "@/components/console/ResourceWorkspace";
import { ZoneScopedPage } from "@/components/console/ZoneScope";
import { Badge, type Column } from "@/components/ui";
import { ConsoleApiError } from "@/platform/api/client";
import { usePolicySets } from "@/platform/api/hooks";
import type { PolicySet } from "@/platform/api/types";

export const Route = createFileRoute("/app/policy-sets")({
  component: PolicySetsRoute,
});

function PolicySetsRoute() {
  return (
    <ZoneScopedPage
      title="Policy Sets"
      description="Bundles of policies activated together. The active set governs every decision in this zone."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Policy Sets" }]}
    >
      {(zone) => <PolicySetsPage zoneId={zone.id} />}
    </ZoneScopedPage>
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

function PolicySetsPage({ zoneId }: { zoneId: string }) {
  const query = usePolicySets(zoneId);
  const rows = query.data ?? [];

  const columns: Column<PolicySet>[] = [
    {
      id: "name",
      header: "Policy set",
      sortable: true,
      cell: (ps) => (
        <div>
          <div className="font-medium text-foreground">{ps.name}</div>
          {ps.description ? (
            <div className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
              {ps.description}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: (ps) =>
        ps.active_version_id ? (
          <Badge tone="success">Active</Badge>
        ) : (
          <Badge tone="warning">Inactive</Badge>
        ),
    },
    {
      id: "created",
      header: "Created",
      sortable: true,
      align: "right",
      cell: (ps) => (
        <span className="text-xs text-muted-foreground">
          {new Date(ps.created_at).toLocaleDateString()}
        </span>
      ),
    },
  ];

  return (
    <ResourceWorkspace
      title="Policy Sets"
      description="Bundles of policies activated together. The active set governs every decision in this zone."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Policy Sets" }]}
      rows={rows}
      loading={query.isLoading}
      columns={columns}
      rowKey={(ps) => ps.id}
      search={{
        placeholder: "Search policy sets…",
        match: (ps, q) =>
          ps.name.toLowerCase().includes(q) || (ps.description ?? "").toLowerCase().includes(q),
      }}
      sortOptions={[
        { id: "name", label: "Name" },
        { id: "recent", label: "Newest" },
      ]}
      empty={{
        title: query.isError ? "Could not load policy sets" : "No policy sets yet",
        description: query.isError
          ? errorMessage(query.error)
          : "Without an active policy set, requests in this zone fall back to deny. Create and activate one to authorize traffic.",
      }}
      detail={{
        title: (ps) => ps.name,
        description: (ps) => ps.id,
        width: "max-w-lg",
        render: (ps) => <PolicySetDetail policySet={ps} />,
      }}
    />
  );
}

function PolicySetDetail({ policySet }: { policySet: PolicySet }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2">
        {policySet.active_version_id ? (
          <Badge tone="success">Active</Badge>
        ) : (
          <Badge tone="warning">Inactive</Badge>
        )}
      </div>

      <DetailGroup title="Metadata">
        <DetailField label="Name">{policySet.name}</DetailField>
        <DetailField label="Description">{policySet.description ?? "—"}</DetailField>
        <DetailField label="Created">{new Date(policySet.created_at).toLocaleString()}</DetailField>
      </DetailGroup>

      <DetailGroup title="Activation">
        <DetailField label="Active version">
          {policySet.active_version_id ? (
            <Mono>{policySet.active_version_id}</Mono>
          ) : (
            "None — decisions fall back to deny"
          )}
        </DetailField>
      </DetailGroup>

      {!policySet.active_version_id ? (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          This policy set has no active version. Activate a version to enforce its rules.
        </p>
      ) : null}
    </div>
  );
}
