/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Resources route.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { ResourceFormModal } from "@/components/console/ResourceForm";
import {
  DetailField,
  DetailGroup,
  Mono,
  ResourceWorkspace,
} from "@/components/console/ResourceWorkspace";
import { ZoneScopedPage } from "@/components/console/ZoneScope";
import { Badge, Button, ConfirmDialog, useToast, type Column } from "@/components/ui";
import { cx } from "@/lib/cx";
import { ConsoleApiError } from "@/platform/api/client";
import {
  useApplications,
  useCreateResource,
  useDeleteResource,
  useProviders,
  useResources,
  useUpdateResource,
} from "@/platform/api/hooks";
import type { Application, Provider, Resource, ResourceInput } from "@/platform/api/types";

export const Route = createFileRoute("/app/resources")({
  component: ResourcesRoute,
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

  const columns: Column<Resource>[] = [
    {
      id: "name",
      header: "Resource",
      sortable: true,
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
      cell: (r) => (
        <span className="truncate font-mono text-xs text-muted-foreground">
          {r.upstream_url ? hostOf(r.upstream_url) : "—"}
        </span>
      ),
    },
    {
      id: "binding",
      header: "Binding",
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
        headerExtra={
          allRows.length > 0 ? (
            <EnforcementFilterBar
              filter={filter}
              total={allRows.length}
              enforced={counts.enforced}
              uniform={counts.uniform}
              onSelect={setFilter}
            />
          ) : undefined
        }
        search={{
          placeholder: "Search resources, scopes, upstreams…",
          match: (r, q) =>
            r.name.toLowerCase().includes(q) ||
            r.identifier.toLowerCase().includes(q) ||
            (r.upstream_url ?? "").toLowerCase().includes(q) ||
            (r.scopes ?? []).some((s) => s.toLowerCase().includes(q)),
        }}
        sortOptions={[
          { id: "name", label: "Name" },
          { id: "recent", label: "Newest" },
        ]}
        empty={{
          title: query.isError ? "Could not load resources" : "No resources yet",
          description: query.isError
            ? errorMessage(query.error)
            : "Register a protected upstream so the Gateway can authorize requests to it.",
          actionLabel: query.isError ? undefined : "New resource",
          onAction: query.isError ? undefined : () => setCreateOpen(true),
        }}
        detail={{
          title: (r) => r.name,
          description: (r) => r.identifier,
          width: "max-w-xl",
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
      <span className="text-muted-foreground/50">—</span>
    </span>
  );
}

function EnforcementFilterBar({
  filter,
  total,
  enforced,
  uniform,
  onSelect,
}: {
  filter: EnforcementFilter;
  total: number;
  enforced: number;
  uniform: number;
  onSelect: (filter: EnforcementFilter) => void;
}) {
  const chips: { id: EnforcementFilter; label: string; count: number }[] = [
    { id: "all", label: "All", count: total },
    { id: "enforced", label: "Enforced", count: enforced },
    { id: "transport_uniform", label: "Transport", count: uniform },
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
      <div className="flex flex-wrap items-center gap-2">
        {resource.operation_enforcement === "enforced" ? (
          <Badge tone="success">Operation enforced</Badge>
        ) : (
          <Badge tone="muted">Transport uniform</Badge>
        )}
        <div className="ml-auto">
          <Button variant="secondary" size="sm" onClick={onEdit}>
            Edit
          </Button>
        </div>
      </div>

      <DetailGroup title="Routing">
        <DetailField label="Identifier">
          <Mono>{resource.identifier}</Mono>
        </DetailField>
        <DetailField label="Upstream URL">
          <Mono>{resource.upstream_url ?? "—"}</Mono>
        </DetailField>
        <DetailField label="Created">{new Date(resource.created_at).toLocaleString()}</DetailField>
      </DetailGroup>

      <section className="border-t border-border pt-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Bindings
        </h3>
        <div className="mt-3 grid gap-px border border-border bg-border sm:grid-cols-2 [&>*]:bg-background">
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
      </section>

      <section className="border-t border-border pt-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Scopes
        </h3>
        {scopes.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {scopes.map((scope) => (
              <span
                key={scope}
                className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
              >
                {scope}
              </span>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">No scopes declared.</p>
        )}
      </section>

      <section className="border-t border-border pt-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Operations
        </h3>
        {resource.operation_enforcement === "transport_uniform" ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Authorization is uniform across the transport. Individual operations are not listed.
          </p>
        ) : operations.length > 0 ? (
          <div className="mt-3 overflow-hidden border border-border">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border">
                {operations.map((op) => (
                  <tr key={`${op.method}-${op.path}`}>
                    <td className="px-3 py-2">
                      <Badge tone="neutral">{op.method}</Badge>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-foreground">{op.path}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">
                      {op.scope}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            No declared operations. The Gateway denies every operation until you add some.
          </p>
        )}
      </section>

      <section className="border-t border-border pt-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-destructive">
          Danger zone
        </h3>
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Remove this resource and its Gateway route.
          </p>
          <Button variant="danger" size="sm" onClick={onDelete}>
            Delete
          </Button>
        </div>
      </section>
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
