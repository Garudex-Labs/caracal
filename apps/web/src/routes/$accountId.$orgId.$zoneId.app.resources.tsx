/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Resources route.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { ResourceFormModal } from "@/components/console/ResourceForm";
import {
  CopyValue,
  DangerZone,
  DetailField,
  DetailGroup,
  DetailHeader,
  DetailSection,
  Mono,
  ResourceWorkspace,
} from "@/components/console/ResourceWorkspace";
import { ZoneScopedPage } from "@/components/console/ZoneScope";
import {
  Badge,
  Button,
  ConfirmDialog,
  IdentityAvatar,
  useToast,
  type Column,
  type FilterGroup,
} from "@/components/ui";
import { ConsoleApiError } from "@/platform/api/client";
import {
  useApplications,
  useCreateResource,
  useDeleteResource,
  useProviders,
  useResources,
  useUpdateResource,
} from "@/platform/api/hooks";
import { useCreateDeepLink } from "@/platform/nav/createDeepLink";
import type { Application, Provider, Resource, ResourceInput } from "@/platform/api/types";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/resources")({
  component: ResourcesRoute,
  validateSearch: (search: Record<string, unknown>): { create?: string; focus?: string } => ({
    create: typeof search.create === "string" ? search.create : undefined,
    focus: typeof search.focus === "string" ? search.focus : undefined,
  }),
});

function ResourcesRoute() {
  return (
    <ZoneScopedPage
      title="Resources"
      description="Protected upstreams the Gateway authorizes in this zone."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Resources" }]}
    >
      {(zone) => <ResourcesPage zoneId={zone.id} />}
    </ZoneScopedPage>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ConsoleApiError) {
    if (error.notConfigured) return "Control plane not connected.";
    if (error.unreachable) return "Control plane unreachable.";
    return error.code.replace(/_/g, " ");
  }
  return "Unexpected error.";
}

type EnforcementFilter = "all" | "enforced" | "transport_uniform";

function ResourcesPage({ zoneId }: { zoneId: string }) {
  const toast = useToast();
  const query = useResources(zoneId);
  const appsQuery = useApplications(zoneId);
  const providersQuery = useProviders(zoneId);
  const createResource = useCreateResource(zoneId);
  const updateResource = useUpdateResource(zoneId);
  const deleteResource = useDeleteResource(zoneId);

  const [createOpen, setCreateOpen] = useState(false);
  useCreateDeepLink({
    to: "/app/resources",
    value: Route.useSearch().create,
    open: () => setCreateOpen(true),
  });
  const [editTarget, setEditTarget] = useState<Resource | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Resource | null>(null);
  const [filter, setFilter] = useState<EnforcementFilter>("all");

  const allRows = useMemo(() => query.data ?? [], [query.data]);
  const apps = useMemo(() => appsQuery.data ?? [], [appsQuery.data]);
  const providers = useMemo(() => providersQuery.data ?? [], [providersQuery.data]);

  const appById = useMemo(() => new Map(apps.map((a) => [a.id, a])), [apps]);
  const providerById = useMemo(() => new Map(providers.map((p) => [p.id, p])), [providers]);

  const rows = useMemo(
    () => (filter === "all" ? allRows : allRows.filter((r) => r.operation_enforcement === filter)),
    [allRows, filter],
  );

  const counts = useMemo(() => {
    let enforced = 0;
    let uniform = 0;
    for (const r of allRows) {
      if (r.operation_enforcement === "enforced") enforced += 1;
      else uniform += 1;
    }
    return { enforced, uniform };
  }, [allRows]);

  const filters: FilterGroup[] = [
    {
      id: "enforcement",
      label: "Authority",
      value: filter,
      onChange: (v) => setFilter(v as EnforcementFilter),
      options: [
        { id: "all", label: "All resources", count: allRows.length },
        { id: "enforced", label: "Operation enforced", count: counts.enforced },
        { id: "transport_uniform", label: "Transport uniform", count: counts.uniform },
      ],
    },
  ];

  const columns: Column<Resource>[] = [
    {
      id: "name",
      header: "Resource",
      sortable: true,
      truncate: true,
      cell: (r) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-foreground">{r.name}</div>
          <div className="truncate font-mono text-xs text-muted-foreground">{r.identifier}</div>
        </div>
      ),
    },
    {
      id: "upstream",
      header: "Upstream",
      truncate: true,
      cell: (r) => (
        <span className="block truncate font-mono text-xs text-muted-foreground">
          {r.upstream_url ? hostOf(r.upstream_url) : "-"}
        </span>
      ),
    },
    {
      id: "binding",
      header: "Binding",
      truncate: true,
      cell: (r) => (
        <div className="flex min-w-0 flex-col gap-0.5 text-xs">
          <RelationCell
            label="app"
            value={r.gateway_application_id ? appById.get(r.gateway_application_id)?.name : null}
            unresolved={Boolean(r.gateway_application_id)}
          />
          <RelationCell
            label="cred"
            value={
              r.credential_provider_id ? providerById.get(r.credential_provider_id)?.name : null
            }
            unresolved={Boolean(r.credential_provider_id)}
          />
        </div>
      ),
    },
    {
      id: "enforcement",
      header: "Authority",
      cell: (r) =>
        r.operation_enforcement === "enforced" ? (
          <Badge tone="success">{(r.operations ?? []).length} ops enforced</Badge>
        ) : (
          <Badge tone="muted">Transport</Badge>
        ),
    },
    {
      id: "scopes",
      header: "Scopes",
      align: "right",
      sortable: true,
      cell: (r) => (
        <span className="font-mono text-xs text-muted-foreground">{(r.scopes ?? []).length}</span>
      ),
    },
  ];

  return (
    <>
      <ResourceWorkspace
        title="Resources"
        description="Protected upstreams the Gateway authorizes in this zone."
        breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Resources" }]}
        primaryAction={{ label: "New resource", onClick: () => setCreateOpen(true) }}
        rows={rows}
        loading={query.isLoading}
        columns={columns}
        rowKey={(r) => r.id}
        filters={allRows.length > 0 ? filters : undefined}
        search={{
          placeholder: "Search resources, scopes, upstreams…",
          match: (r, q) =>
            r.name.toLowerCase().includes(q) ||
            r.identifier.toLowerCase().includes(q) ||
            (r.upstream_url ?? "").toLowerCase().includes(q) ||
            (r.scopes ?? []).some((s) => s.toLowerCase().includes(q)),
        }}
        initialSort={{ column: "name", direction: "asc" }}
        sortValues={{
          name: (r) => r.name.toLowerCase(),
          scopes: (r) => (r.scopes ?? []).length,
        }}
        empty={{
          title: query.isError ? "Could not load resources" : "No resources yet",
          description: query.isError
            ? errorMessage(query.error)
            : "Register a protected upstream so the Gateway can authorize requests to it.",
        }}
        detail={{
          title: (r) => r.name,
          description: (r) => r.identifier,
          width: "max-w-xl",
          icon: (r) => <IdentityAvatar seed={r.id || r.identifier} size="lg" />,
          render: (r) => (
            <ResourceDetail
              resource={r}
              gatewayApp={
                r.gateway_application_id ? appById.get(r.gateway_application_id) : undefined
              }
              provider={
                r.credential_provider_id ? providerById.get(r.credential_provider_id) : undefined
              }
              onEdit={() => setEditTarget(r)}
              onDelete={() => setDeleteTarget(r)}
            />
          ),
        }}
      />

      <ResourceFormModal
        open={createOpen}
        mode="create"
        applications={apps}
        providers={providers}
        busy={createResource.isPending}
        onClose={() => setCreateOpen(false)}
        onSubmit={async (input) => {
          try {
            const created = await createResource.mutateAsync(input);
            setCreateOpen(false);
            toast({ tone: "success", title: "Resource created", description: created.name });
          } catch (err) {
            toast({ tone: "error", title: "Create failed", description: errorMessage(err) });
          }
        }}
      />

      <ResourceFormModal
        open={editTarget !== null}
        mode="edit"
        resource={editTarget ?? undefined}
        applications={apps}
        providers={providers}
        busy={updateResource.isPending}
        onClose={() => setEditTarget(null)}
        onSubmit={async (input: ResourceInput) => {
          if (!editTarget) return;
          try {
            await updateResource.mutateAsync({ id: editTarget.id, input });
            setEditTarget(null);
            toast({
              tone: "success",
              title: "Resource updated",
              description: input.name ?? editTarget.name,
            });
          } catch (err) {
            toast({ tone: "error", title: "Update failed", description: errorMessage(err) });
          }
        }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete resource"
        description={`Archiving "${deleteTarget?.name ?? ""}" removes its Gateway route and authorization, so agents lose access to this upstream. The record is retained for audit.`}
        confirmLabel="Delete resource"
        tone="danger"
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await deleteResource.mutateAsync(deleteTarget.id);
            toast({ tone: "info", title: "Resource deleted", description: deleteTarget.name });
          } catch (err) {
            toast({ tone: "error", title: "Delete failed", description: errorMessage(err) });
          }
        }}
      />
    </>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function RelationCell({
  label,
  value,
  unresolved,
}: {
  label: string;
  value: string | null | undefined;
  unresolved: boolean;
}) {
  if (value) {
    return (
      <span className="flex items-center gap-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground/70">
          {label}
        </span>
        <span className="truncate text-foreground">{value}</span>
      </span>
    );
  }
  if (unresolved) {
    return (
      <span className="flex items-center gap-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground/70">
          {label}
        </span>
        <span className="truncate text-muted-foreground">linked</span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground/70">
        {label}
      </span>
      <span className="text-muted-foreground/50">-</span>
    </span>
  );
}

function ResourceDetail({
  resource,
  gatewayApp,
  provider,
  onEdit,
  onDelete,
}: {
  resource: Resource;
  gatewayApp?: Application;
  provider?: Provider;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const scopes = resource.scopes ?? [];
  const operations = resource.operations ?? [];
  return (
    <div className="flex flex-col gap-6">
      <DetailHeader
        action={
          <Button variant="secondary" size="sm" onClick={onEdit}>
            Edit
          </Button>
        }
      >
        {resource.operation_enforcement === "enforced" ? (
          <Badge tone="success">Operation enforced</Badge>
        ) : (
          <Badge tone="muted">Transport uniform</Badge>
        )}
      </DetailHeader>

      <DetailGroup title="Routing">
        <DetailField label="Identifier">
          <CopyValue value={resource.identifier} />
        </DetailField>
        <DetailField label="Upstream URL">
          {resource.upstream_url ? <CopyValue value={resource.upstream_url} /> : <Mono>-</Mono>}
        </DetailField>
        <DetailField label="Created">{new Date(resource.created_at).toLocaleString()}</DetailField>
        {resource.updated_at && resource.updated_at !== resource.created_at ? (
          <DetailField label="Updated">
            {new Date(resource.updated_at).toLocaleString()}
          </DetailField>
        ) : null}
      </DetailGroup>

      <DetailSection title="Bindings">
        <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 [&>*]:bg-card">
          <BindingCell
            label="Gateway application"
            value={gatewayApp?.name}
            id={resource.gateway_application_id}
            to="/app/applications"
          />
          <BindingCell
            label="Credential provider"
            value={provider?.name}
            id={resource.credential_provider_id}
            to="/app/providers"
          />
        </div>
      </DetailSection>

      <DetailSection title="Scopes">
        {scopes.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {scopes.map((scope) => (
              <span
                key={scope}
                className="max-w-full break-all rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
              >
                {scope}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No scopes declared.</p>
        )}
      </DetailSection>

      <DetailSection title="Operations">
        {resource.operation_enforcement === "transport_uniform" ? (
          <p className="text-sm text-muted-foreground">
            Authorization is uniform across the transport. Individual operations are not listed.
          </p>
        ) : operations.length > 0 ? (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border">
                {operations.map((op) => (
                  <tr key={`${op.method}-${op.path}`}>
                    <td className="px-3 py-2 align-top">
                      <Badge tone="neutral">{op.method}</Badge>
                    </td>
                    <td className="break-all px-3 py-2 align-top font-mono text-xs text-foreground">
                      {op.path}
                    </td>
                    <td className="break-all px-3 py-2 text-right align-top font-mono text-xs text-muted-foreground">
                      {op.scope}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No declared operations. The Gateway denies every operation until you add some.
          </p>
        )}
      </DetailSection>

      <DangerZone
        description="Remove this resource and its Gateway route."
        actionLabel="Delete"
        onAction={onDelete}
      />
    </div>
  );
}

function BindingCell({
  label,
  value,
  id,
  to,
}: {
  label: string;
  value: string | undefined;
  id: string | null;
  to: string;
}) {
  return (
    <div className="p-3">
      <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </div>
      {id ? (
        <a href={to} className="mt-1 block truncate text-sm text-foreground hover:underline">
          {value ?? "Linked"}
        </a>
      ) : (
        <div className="mt-1 text-sm text-muted-foreground">Not bound</div>
      )}
    </div>
  );
}
