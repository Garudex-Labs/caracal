/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Resources route.
*/
import { Link, createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { ResourceFormModal } from "@/components/console/ResourceForm";
import { CreatedBy } from "@/components/console/CreatedBy";
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
import { errorMessage } from "@/platform/api/errors";
import {
  useCreateResource,
  useDeleteResource,
  useProviders,
  useResources,
  useTestResource,
  useUpdateResource,
} from "@/platform/api/hooks";
import { appLink } from "@/platform/nav/appLink";
import { useCreateDeepLink } from "@/platform/nav/createDeepLink";
import type { Provider, Resource, ResourceInput, ResourceTestResult } from "@/platform/api/types";

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

type EnforcementFilter = "all" | "enforced" | "transport_uniform";

function ResourcesPage({ zoneId }: { zoneId: string }) {
  const toast = useToast();
  const [view, setView] = useState<"active" | "archived">("active");
  const query = useResources(zoneId, view);
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
  const providers = useMemo(() => providersQuery.data ?? [], [providersQuery.data]);

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
      id: "lifecycle",
      label: "Lifecycle",
      value: view,
      onChange: (v) => setView(v as "active" | "archived"),
      options: [
        { id: "active", label: "Active" },
        { id: "archived", label: "Archived" },
      ],
    },
    {
      id: "enforcement",
      label: "Enforcement",
      value: filter,
      onChange: (v) => setFilter(v as EnforcementFilter),
      options: [
        { id: "all", label: "All resources", count: allRows.length },
        { id: "enforced", label: "Listed operations only", count: counts.enforced },
        { id: "transport_uniform", label: "Any operation", count: counts.uniform },
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
      id: "provider",
      header: "Provider",
      truncate: true,
      cell: (r) => {
        const name = r.credential_provider_id
          ? providerById.get(r.credential_provider_id)?.name
          : null;
        if (name) return <span className="block truncate text-xs text-foreground">{name}</span>;
        if (r.credential_provider_id)
          return <span className="block truncate text-xs text-muted-foreground">Unavailable</span>;
        return <span className="text-xs text-muted-foreground/50">-</span>;
      },
    },
    {
      id: "enforcement",
      header: "Enforcement",
      cell: (r) =>
        r.operation_enforcement === "enforced" ? (
          <Badge tone="success">{(r.operations ?? []).length} ops enforced</Badge>
        ) : (
          <Badge tone="muted">Any operation</Badge>
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
    ...(view === "archived"
      ? [
          {
            id: "archived",
            header: "Archived",
            sortable: true,
            align: "right",
            cell: (r) => (
              <span className="text-xs text-muted-foreground">
                {r.archived_at ? new Date(r.archived_at).toLocaleDateString() : "-"}
              </span>
            ),
          } satisfies Column<Resource>,
        ]
      : []),
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
        filters={allRows.length > 0 || view === "archived" ? filters : undefined}
        search={{
          placeholder: "Search resources, scopes, upstreams…",
          match: (r, q) =>
            r.name.toLowerCase().includes(q) ||
            r.identifier.toLowerCase().includes(q) ||
            r.id.toLowerCase().includes(q) ||
            (r.upstream_url ?? "").toLowerCase().includes(q) ||
            (r.scopes ?? []).some((s) => s.toLowerCase().includes(q)),
        }}
        initialSort={{ column: "name", direction: "asc" }}
        sortValues={{
          name: (r) => r.name.toLowerCase(),
          scopes: (r) => (r.scopes ?? []).length,
          archived: (r) => (r.archived_at ? Date.parse(r.archived_at) : 0),
        }}
        empty={{
          title: query.isError
            ? "Could not load resources"
            : view === "archived"
              ? "No archived resources"
              : "No resources yet",
          description: query.isError
            ? errorMessage(query.error)
            : view === "archived"
              ? "Resources you archive keep their record here for audit."
              : "Register a protected upstream so the Gateway can authorize requests to it.",
        }}
        detail={{
          title: (r) => r.name,
          description: (r) => r.identifier,
          width: "max-w-xl",
          icon: (r) => <IdentityAvatar seed={r.id || r.identifier} size="lg" />,
          render: (r) => (
            <ResourceDetail
              zoneId={zoneId}
              resource={r}
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
        providers={providers}
        busy={createResource.isPending}
        onClose={() => setCreateOpen(false)}
        onSubmit={async (input): Promise<ResourceTestResult | undefined> => {
          try {
            const created = await createResource.mutateAsync(input);
            setCreateOpen(false);
            toast({ tone: "success", title: "Resource created", description: created.name });
            return undefined;
          } catch (err) {
            if (err instanceof ConsoleApiError && err.code === "resource_check_failed") {
              const check = (err.detail as { details?: { check?: ResourceTestResult } } | undefined)
                ?.details?.check;
              if (check) return check;
            }
            toast({
              tone: "error",
              title: "Create failed",
              description:
                err instanceof ConsoleApiError && err.code === "resource_test_rate_limited"
                  ? "Too many connectivity checks. Wait a minute and try again."
                  : errorMessage(err),
            });
            return undefined;
          }
        }}
      />

      <ResourceFormModal
        open={editTarget !== null}
        mode="edit"
        resource={editTarget ?? undefined}
        providers={providers}
        busy={updateResource.isPending}
        onClose={() => setEditTarget(null)}
        onSubmit={async (input: ResourceInput): Promise<ResourceTestResult | undefined> => {
          if (!editTarget) return undefined;
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
          return undefined;
        }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Archive resource"
        description={`Archiving "${deleteTarget?.name ?? ""}" removes its Gateway route and authorization, so Applications lose access to this upstream. The record stays visible under Archived for audit.`}
        confirmLabel="Archive resource"
        tone="danger"
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await deleteResource.mutateAsync(deleteTarget.id);
            toast({ tone: "info", title: "Resource archived", description: deleteTarget.name });
          } catch (err) {
            toast({ tone: "error", title: "Archive failed", description: errorMessage(err) });
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

// The verification probe reports one of four outcomes: a guarded upstream (rejected the
// invalid mandate) is a success; an unverified upstream (accepted it) is a hard failure; an
// unreachable or unexpected response is a cautionary amber.
function verificationTone(status: ResourceTestResult["status"]): string {
  const base = "rounded-lg border px-3 py-2 text-xs";
  if (status === "guarded")
    return `${base} border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400`;
  if (status === "unverified")
    return `${base} border-destructive/30 bg-destructive/10 text-destructive`;
  return `${base} border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400`;
}

function ResourceDetail({
  zoneId,
  resource,
  provider,
  onEdit,
  onDelete,
}: {
  zoneId: string;
  resource: Resource;
  provider?: Provider;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const scopes = resource.scopes ?? [];
  const operations = resource.operations ?? [];
  const archived = Boolean(resource.archived_at);
  const testResource = useTestResource(zoneId);
  const [verifyResult, setVerifyResult] = useState<ResourceTestResult | null>(null);
  const canVerify =
    provider?.kind === "caracal_mandate" && Boolean(resource.upstream_url) && !archived;
  return (
    <div className="flex flex-col gap-6">
      <DetailHeader
        action={
          archived ? undefined : (
            <Button variant="secondary" size="sm" onClick={onEdit}>
              Edit
            </Button>
          )
        }
      >
        {resource.operation_enforcement === "enforced" ? (
          <Badge tone="success">Listed operations only</Badge>
        ) : (
          <Badge tone="muted">Any operation</Badge>
        )}
        {archived && resource.archived_at ? (
          <span className="text-xs text-muted-foreground">
            Archived {new Date(resource.archived_at).toLocaleString()}
          </span>
        ) : null}
      </DetailHeader>

      <DetailGroup title="Routing">
        <DetailField label="Resource ID">
          <CopyValue value={resource.id} />
        </DetailField>
        <DetailField label="Identifier">
          <CopyValue value={resource.identifier} />
        </DetailField>
        <DetailField label="Upstream URL">
          {resource.upstream_url ? <CopyValue value={resource.upstream_url} /> : <Mono>-</Mono>}
        </DetailField>
        {resource.created_by ? (
          <DetailField label="Created by">
            <CreatedBy id={resource.created_by} coAuthored={resource.created_via_operator} />
          </DetailField>
        ) : null}
        <DetailField label="Created">{new Date(resource.created_at).toLocaleString()}</DetailField>
        {resource.updated_by ? (
          <DetailField label="Updated by">
            <CreatedBy id={resource.updated_by} coAuthored={resource.updated_via_operator} />
          </DetailField>
        ) : null}
        {resource.updated_at && resource.updated_at !== resource.created_at ? (
          <DetailField label="Updated">
            {new Date(resource.updated_at).toLocaleString()}
          </DetailField>
        ) : null}
      </DetailGroup>

      <DetailSection title="Bindings">
        <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border [&>*]:bg-card">
          <BindingCell
            label="Credential provider"
            value={provider?.name}
            id={resource.credential_provider_id}
            to={appLink("/providers")}
          />
        </div>
      </DetailSection>

      {canVerify ? (
        <DetailSection title="Verification">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                loading={testResource.isPending}
                onClick={() =>
                  testResource.mutate(resource.id, {
                    onSuccess: (result) => setVerifyResult(result),
                    onError: () => setVerifyResult(null),
                  })
                }
              >
                Test connection
              </Button>
              <span className="text-xs text-muted-foreground">
                Sends a deliberately invalid Caracal mandate and confirms the upstream rejects it.
                No valid mandate is sent, so nothing reaches the upstream&apos;s tools.
              </span>
            </div>
            {verifyResult ? (
              <div className={verificationTone(verifyResult.status)} role="status">
                {verifyResult.detail}
              </div>
            ) : testResource.isError ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                The verification check could not run.
              </div>
            ) : null}
          </div>
        </DetailSection>
      ) : null}

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
            Any operation: one decision covers every call, so no operation list applies.
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

      {archived ? (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          This resource is archived: its Gateway route and authorization are removed and the record
          is retained for audit.
        </p>
      ) : (
        <DangerZone
          description="Archive this resource and remove its Gateway route. Applications lose access to this upstream."
          actionLabel="Archive"
          onAction={onDelete}
        />
      )}
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
        value ? (
          <Link
            to={to}
            search={{ focus: id }}
            className="mt-1 block truncate text-sm text-foreground hover:underline"
          >
            {value}
          </Link>
        ) : (
          <div className="mt-1 text-sm text-muted-foreground">Unavailable</div>
        )
      ) : (
        <div className="mt-1 text-sm text-muted-foreground">Not bound</div>
      )}
    </div>
  );
}
