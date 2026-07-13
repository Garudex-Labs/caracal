/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Providers route.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { ProviderFormModal, TEST_STATUS } from "@/components/console/ProviderForm";
import { CreatedBy } from "@/components/console/CreatedBy";
import {
  CopyValue,
  DangerZone,
  DetailField,
  DetailGroup,
  DetailHeader,
  DetailSection,
  ResourceWorkspace,
} from "@/components/console/ResourceWorkspace";
import { ZoneScopedPage } from "@/components/console/ZoneScope";
import {
  Badge,
  Button,
  ConfirmDialog,
  Field,
  IdentityAvatar,
  Modal,
  Spinner,
  useCopyToClipboard,
  useToast,
  type Column,
  type FilterGroup,
} from "@/components/ui";
import { ConsoleApiError } from "@/platform/api/client";
import { errorMessage } from "@/platform/api/errors";
import {
  useApplications,
  useAuthorizeProviderConnection,
  useCreateProvider,
  useDeleteProvider,
  useDiscoverProvider,
  useProviderConnections,
  useProviders,
  useResources,
  useRevokeProviderConnection,
  useTestProvider,
  useUpdateProvider,
} from "@/platform/api/hooks";
import { useCreateDeepLink } from "@/platform/nav/createDeepLink";
import { PROVIDER_KIND_LABEL } from "@/platform/api/types";
import type {
  Provider,
  ProviderConnection,
  ProviderInput,
  ProviderKind,
  ProviderTestResult,
  Resource,
} from "@/platform/api/types";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/providers")({
  component: ProvidersRoute,
  validateSearch: (search: Record<string, unknown>): { create?: string; focus?: string } => ({
    create: typeof search.create === "string" ? search.create : undefined,
    focus: typeof search.focus === "string" ? search.focus : undefined,
  }),
});

const KIND_LABEL = PROVIDER_KIND_LABEL;

const KIND_SHORT: Record<ProviderKind, string> = {
  none: "None",
  caracal_mandate: "Mandate",
  oauth2_authorization_code: "OAuth · auth code",
  oauth2_client_credentials: "OAuth · client creds",
  api_key: "API key",
  bearer_token: "Bearer",
  http_basic: "Basic",
};

function ProvidersRoute() {
  return (
    <ZoneScopedPage
      title="Providers"
      description="Credential sources that issue upstream access for this zone."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Providers" }]}
    >
      {(zone) => <ProvidersPage zoneId={zone.id} zoneName={zone.name} />}
    </ZoneScopedPage>
  );
}

// Surfaces the concrete blast radius of archiving a provider: the resources bound to it as
// their credential source will lose upstream access the moment it is removed from active use.
function archiveProviderDescription(provider: Provider | null, resources: Resource[]): string {
  if (!provider) return "";
  const bound = resources.filter((r) => r.credential_provider_id === provider.id);
  if (bound.length === 0) {
    return `Archiving "${provider.name}" removes its credential routing. No resources are bound to it. This cannot be undone; the record stays visible under Archived for audit.`;
  }
  const names = bound
    .slice(0, 3)
    .map((r) => r.name)
    .join(", ");
  const more = bound.length > 3 ? ` and ${bound.length - 3} more` : "";
  return `Archiving "${provider.name}" will break upstream access for ${bound.length} bound resource${bound.length === 1 ? "" : "s"} (${names}${more}). They will fail until rebound to another provider. This cannot be undone; the record stays visible under Archived for audit.`;
}

function routingSummary(provider: Provider): string {
  const config = provider.config_json ?? {};
  const endpoint = config.token_endpoint ?? config.authorization_endpoint;
  if (typeof endpoint === "string") {
    try {
      return new URL(endpoint).host;
    } catch {
      return endpoint;
    }
  }
  if (typeof config.header_name === "string") return `header ${config.header_name}`;
  if (typeof config.query_param_name === "string") return `query ${config.query_param_name}`;
  if (typeof config.username === "string") return `user ${config.username}`;
  if (Array.isArray(config.allowed_token_hosts) && config.allowed_token_hosts.length > 0) {
    return String(config.allowed_token_hosts[0]);
  }
  return "-";
}

function ProvidersPage({ zoneId, zoneName }: { zoneId: string; zoneName: string }) {
  const toast = useToast();
  const [view, setView] = useState<"active" | "archived">("active");
  const query = useProviders(zoneId, view);
  const resourcesQuery = useResources(zoneId);
  const createProvider = useCreateProvider(zoneId);
  const updateProvider = useUpdateProvider(zoneId);
  const deleteProvider = useDeleteProvider(zoneId);
  const discoverProvider = useDiscoverProvider(zoneId);

  const [createOpen, setCreateOpen] = useState(false);
  useCreateDeepLink({
    to: "/app/providers",
    value: Route.useSearch().create,
    open: () => setCreateOpen(true),
  });
  const [editTarget, setEditTarget] = useState<Provider | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Provider | null>(null);
  const [kindFilter, setKindFilter] = useState<ProviderKind | "all">("all");

  const allRows = useMemo(() => query.data ?? [], [query.data]);

  const kindCounts = useMemo(() => {
    const counts = new Map<ProviderKind, number>();
    for (const provider of allRows) counts.set(provider.kind, (counts.get(provider.kind) ?? 0) + 1);
    return counts;
  }, [allRows]);

  const rows = useMemo(
    () => (kindFilter === "all" ? allRows : allRows.filter((p) => p.kind === kindFilter)),
    [allRows, kindFilter],
  );

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
      id: "kind",
      label: "Type",
      value: kindFilter,
      onChange: (v) => setKindFilter(v as ProviderKind | "all"),
      options: [
        { id: "all", label: "All types", count: allRows.length },
        ...(Object.keys(KIND_LABEL) as ProviderKind[])
          .filter((k) => kindCounts.has(k))
          .map((k) => ({ id: k, label: KIND_LABEL[k], count: kindCounts.get(k) ?? 0 })),
      ],
    },
  ];

  const columns: Column<Provider>[] = [
    {
      id: "name",
      header: "Provider",
      sortable: true,
      truncate: true,
      cell: (p) => (
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium text-foreground">{p.name}</span>
            {p.connectivity_failed_at ? (
              <Badge tone="danger" title="Connectivity check failed">
                Failed
              </Badge>
            ) : null}
          </div>
          <div className="truncate font-mono text-xs text-muted-foreground">{p.identifier}</div>
        </div>
      ),
    },
    {
      id: "kind",
      header: "Type",
      cell: (p) => <Badge tone="neutral">{KIND_SHORT[p.kind]}</Badge>,
    },
    {
      id: "routing",
      header: "Routing",
      truncate: true,
      cell: (p) => (
        <span className="block truncate font-mono text-xs text-muted-foreground">
          {routingSummary(p)}
        </span>
      ),
    },
    {
      id: "secrets",
      header: "Credentials",
      cell: (p) =>
        p.secret_config_keys.length > 0 ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-amber-600 dark:text-amber-400"
            >
              <rect x="5" y="11" width="14" height="9" rx="2" />
              <path d="M8 11V8a4 4 0 0 1 8 0v3" />
            </svg>
            {p.secret_config_keys.length} sealed
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">-</span>
        ),
    },
    {
      id: "created",
      header: "Created",
      sortable: true,
      align: "right",
      cell: (p) => (
        <span className="text-xs text-muted-foreground">
          {new Date(p.created_at).toLocaleDateString()}
        </span>
      ),
    },
    ...(view === "archived"
      ? [
          {
            id: "archived",
            header: "Archived",
            sortable: true,
            align: "right",
            cell: (p) => (
              <span className="text-xs text-muted-foreground">
                {p.archived_at ? new Date(p.archived_at).toLocaleDateString() : "-"}
              </span>
            ),
          } satisfies Column<Provider>,
        ]
      : []),
  ];

  return (
    <>
      <ResourceWorkspace
        title="Providers"
        description="Credential sources that issue upstream access for this zone."
        breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Providers" }]}
        primaryAction={{ label: "New provider", onClick: () => setCreateOpen(true) }}
        rows={rows}
        loading={query.isLoading}
        columns={columns}
        rowKey={(p) => p.id}
        filters={allRows.length > 0 || view === "archived" ? filters : undefined}
        search={{
          placeholder: "Search providers…",
          match: (p, q) =>
            p.name.toLowerCase().includes(q) ||
            p.identifier.toLowerCase().includes(q) ||
            p.id.toLowerCase().includes(q) ||
            KIND_LABEL[p.kind].toLowerCase().includes(q),
        }}
        initialSort={{ column: "created", direction: "desc" }}
        sortValues={{
          name: (p) => p.name.toLowerCase(),
          created: (p) => Date.parse(p.created_at) || 0,
          archived: (p) => (p.archived_at ? Date.parse(p.archived_at) : 0),
        }}
        empty={{
          title: query.isError
            ? "Could not load providers"
            : view === "archived"
              ? "No archived providers"
              : "No providers configured",
          description: query.isError
            ? errorMessage(query.error)
            : view === "archived"
              ? "Providers you archive keep their record here for audit."
              : "Add a provider so applications can obtain mandates and upstream credentials.",
        }}
        detail={{
          title: (p) => p.name,
          description: (p) => p.identifier,
          width: "max-w-xl",
          icon: (p) => <IdentityAvatar seed={p.id || p.identifier} size="lg" />,
          render: (p) => (
            <ProviderDetail
              provider={p}
              zoneId={zoneId}
              onEdit={() => setEditTarget(p)}
              onDelete={() => setDeleteTarget(p)}
            />
          ),
        }}
      />

      <ProviderFormModal
        open={createOpen}
        mode="create"
        busy={createProvider.isPending}
        zoneId={zoneId}
        onClose={() => setCreateOpen(false)}
        onDiscover={(issuer) => discoverProvider.mutateAsync(issuer)}
        onSubmit={async (input): Promise<ProviderTestResult | undefined> => {
          try {
            const created = await createProvider.mutateAsync(input);
            setCreateOpen(false);
            if (input.check) {
              toast({ tone: "success", title: "Provider connected", description: created.name });
            } else if (created.connectivity_failed_at) {
              toast({
                tone: "info",
                title: "Provider created without a connectivity check",
                description: `${created.name} is marked Failed until a check passes.`,
              });
            } else {
              toast({ tone: "success", title: "Provider created", description: created.name });
            }
          } catch (err) {
            if (err instanceof ConsoleApiError && err.code === "provider_check_failed") {
              const check = (err.detail as { details?: { check?: ProviderTestResult } } | undefined)
                ?.details?.check;
              if (check) return check;
            }
            toast({
              tone: "error",
              title: "Create failed",
              description:
                err instanceof ConsoleApiError && err.code === "provider_test_rate_limited"
                  ? "Too many connection checks. Wait a minute and try again."
                  : errorMessage(err),
            });
          }
        }}
      />

      <ProviderFormModal
        open={editTarget !== null}
        mode="edit"
        provider={editTarget ?? undefined}
        busy={updateProvider.isPending}
        zoneId={zoneId}
        onClose={() => setEditTarget(null)}
        onDiscover={(issuer) => discoverProvider.mutateAsync(issuer)}
        onSubmit={async (input: ProviderInput): Promise<ProviderTestResult | undefined> => {
          if (!editTarget) return;
          const kindUnchanged = input.kind === editTarget.kind;
          const patch = kindUnchanged
            ? { name: input.name, identifier: input.identifier, config_json: input.config_json }
            : input;
          try {
            await updateProvider.mutateAsync({ id: editTarget.id, input: patch });
            setEditTarget(null);
            toast({
              tone: "success",
              title: "Provider updated",
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
        title="Archive provider"
        description={archiveProviderDescription(deleteTarget, resourcesQuery.data ?? [])}
        confirmLabel="Archive provider"
        tone="danger"
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await deleteProvider.mutateAsync(deleteTarget.id);
            toast({ tone: "info", title: "Provider archived", description: deleteTarget.name });
          } catch (err) {
            toast({ tone: "error", title: "Archive failed", description: errorMessage(err) });
          }
        }}
      />
    </>
  );
}

function ProviderDetail({
  provider,
  onEdit,
  onDelete,
  zoneId,
}: {
  provider: Provider;
  onEdit: () => void;
  onDelete: () => void;
  zoneId: string;
}) {
  const copy = useCopyToClipboard();
  const secretKeys = new Set(provider.secret_config_keys);
  const configEntries = Object.entries(provider.config_json ?? {}).filter(
    ([key]) => !secretKeys.has(key as never),
  );
  const credentialKind = provider.kind !== "none" && provider.kind !== "caracal_mandate";
  const archived = Boolean(provider.archived_at);

  return (
    <div className="flex flex-col gap-6">
      <DetailHeader
        action={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                void copy(JSON.stringify(provider, null, 2), {
                  successTitle: "Provider JSON copied",
                })
              }
            >
              Copy JSON
            </Button>
            {archived ? null : (
              <Button variant="secondary" size="sm" onClick={onEdit}>
                Edit
              </Button>
            )}
          </>
        }
      >
        <Badge tone="neutral">{KIND_LABEL[provider.kind]}</Badge>
        {provider.connectivity_failed_at ? (
          <Badge tone="danger" title="Connectivity check failed">
            Failed
          </Badge>
        ) : null}
        {provider.secret_config_keys.length > 0 ? (
          <Badge tone="warning">Secrets sealed</Badge>
        ) : credentialKind ? (
          <Badge tone="muted">No secret stored</Badge>
        ) : null}
        {archived && provider.archived_at ? (
          <span className="text-xs text-muted-foreground">
            Archived {new Date(provider.archived_at).toLocaleString()}
          </span>
        ) : null}
      </DetailHeader>

      <DetailGroup title="Identity">
        <DetailField label="Name">{provider.name}</DetailField>
        <DetailField label="Identifier">
          <CopyValue value={provider.identifier} />
        </DetailField>
        <DetailField label="Provider ID">
          <CopyValue value={provider.id} />
        </DetailField>
        <DetailField label="Type">{KIND_LABEL[provider.kind]}</DetailField>
        {provider.created_by ? (
          <DetailField label="Created by">
            <CreatedBy id={provider.created_by} coAuthored={provider.created_via_operator} />
          </DetailField>
        ) : null}
        <DetailField label="Created">{new Date(provider.created_at).toLocaleString()}</DetailField>
        {provider.updated_by ? (
          <DetailField label="Updated by">
            <CreatedBy id={provider.updated_by} coAuthored={provider.updated_via_operator} />
          </DetailField>
        ) : null}
        {provider.updated_at && provider.updated_at !== provider.created_at ? (
          <DetailField label="Updated">
            {new Date(provider.updated_at).toLocaleString()}
          </DetailField>
        ) : null}
      </DetailGroup>

      {credentialKind ? (
        <DetailSection title="Credentials">
          {provider.secret_config_keys.length > 0 ? (
            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              {provider.secret_config_keys.map((key) => (
                <div
                  key={key}
                  className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm"
                >
                  <span className="min-w-0 break-all font-mono text-xs text-foreground">{key}</span>
                  <span className="flex flex-shrink-0 items-center gap-1.5 font-mono text-xs text-muted-foreground">
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="text-amber-600 dark:text-amber-400"
                      aria-hidden="true"
                    >
                      <rect x="5" y="11" width="14" height="9" rx="2" />
                      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
                    </svg>
                    sealed
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No secret stored. Edit the provider to add one.
            </p>
          )}
        </DetailSection>
      ) : null}

      <DetailSection title="Configuration">
        {configEntries.length > 0 ? (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border">
                {configEntries.map(([key, value]) => (
                  <tr key={key}>
                    <td className="w-2/5 px-3 py-2 align-top break-all font-mono text-xs text-muted-foreground">
                      {key}
                    </td>
                    <td className="px-3 py-2 break-words font-mono text-xs text-foreground">
                      {formatValue(value)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No configuration fields.</p>
        )}
      </DetailSection>

      {archived ? null : <ProviderConnectivity provider={provider} zoneId={zoneId} />}

      <ProviderConnections provider={provider} zoneId={zoneId} />

      {archived ? (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          This provider is archived: its credential routing is removed and the record is retained
          for audit.
        </p>
      ) : (
        <DangerZone
          description="Archive this provider and remove its credential routing."
          actionLabel="Archive"
          onAction={onDelete}
        />
      )}
    </div>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/* ------------------------------- Connectivity ------------------------------- */

// Runs the OAuth connectivity check from the control plane: a real probe of the
// allowlisted token endpoint. A passing check clears the provider's Failed badge.
// Other kinds have no checkable endpoint, so the section is not shown for them.
function ProviderConnectivity({ provider, zoneId }: { provider: Provider; zoneId: string }) {
  const test = useTestProvider(zoneId);
  const [result, setResult] = useState<ProviderTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testedId, setTestedId] = useState(provider.id);

  if (testedId !== provider.id) {
    setTestedId(provider.id);
    setResult(null);
    setError(null);
  }

  const isOAuth =
    provider.kind === "oauth2_authorization_code" || provider.kind === "oauth2_client_credentials";
  if (!isOAuth) return null;

  async function run() {
    setError(null);
    try {
      setResult(await test.mutateAsync(provider.id));
    } catch (err) {
      setResult(null);
      setError(
        err instanceof ConsoleApiError && err.code === "provider_test_rate_limited"
          ? "Too many connection checks. Wait a minute and try again."
          : errorMessage(err),
      );
    }
  }

  return (
    <DetailSection
      title="Connectivity"
      action={
        <Button variant="secondary" size="sm" loading={test.isPending} onClick={() => void run()}>
          Connect
        </Button>
      }
    >
      {result ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <Badge tone={TEST_STATUS[result.status].tone}>{TEST_STATUS[result.status].label}</Badge>
            <span className="text-xs text-muted-foreground">
              {new Date(result.checked_at).toLocaleTimeString()}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{result.detail}</p>
        </div>
      ) : error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {provider.connectivity_failed_at
            ? "The last connectivity check failed. Connect again after fixing the configuration; a passing check clears the Failed badge."
            : "Verifies that the token endpoint is reachable and accepts this provider's client credentials. Runs from the control plane; no tokens are stored."}
        </p>
      )}
    </DetailSection>
  );
}

/* --------------------------- Provider connections --------------------------- */

// The reserved subject id the STS falls back to for a zone-shared upstream account.
// Kept in sync with SHARED_CONNECTION_SUBJECT (API) and SharedConnectionSubject (STS).
const SHARED_CONNECTION_SUBJECT = "caracal:shared";

// A connection is healthy while its upstream token is live or STS can refresh it on
// use; a lapsed token with no refresh token needs the subject to reconnect.
function ConnectionHealthBadge({ connection }: { connection: ProviderConnection }) {
  if (connection.status !== "active") {
    return (
      <Badge tone={connection.status === "expired" ? "warning" : "muted"}>
        {connection.status}
      </Badge>
    );
  }
  const lapsed = connection.expires_at !== null && new Date(connection.expires_at) < new Date();
  if (lapsed && !connection.renewable) {
    return <Badge tone="warning">needs reconnect</Badge>;
  }
  return <Badge tone="success">active</Badge>;
}

// Connections apply only to delegated OAuth (authorization_code). For every other
// kind the upstream credential is sealed on the provider itself, so there is nothing
// per-subject to connect. One connection serves every resource routed through the
// provider; authorization stays per-resource through policies and grants.
function ProviderConnections({ provider, zoneId }: { provider: Provider; zoneId: string }) {
  const isDelegatedOAuth = provider.kind === "oauth2_authorization_code";
  const toast = useToast();
  const connections = useProviderConnections(zoneId, isDelegatedOAuth ? provider.id : null);
  const revoke = useRevokeProviderConnection(zoneId);
  const [connectOpen, setConnectOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ProviderConnection | null>(null);

  if (!isDelegatedOAuth) {
    return (
      <DetailSection title="Connections">
        <p className="text-xs text-muted-foreground">
          {provider.kind === "none" || provider.kind === "caracal_mandate"
            ? "This provider issues no upstream credential, so there is nothing to connect per subject."
            : "This provider seals a single shared upstream credential. Per-subject OAuth connections apply only to authorization-code providers."}
        </p>
      </DetailSection>
    );
  }

  const rows = connections.data ?? [];

  return (
    <DetailSection
      title={`Connections (${rows.length})`}
      action={
        <Button variant="secondary" size="sm" mutating onClick={() => setConnectOpen(true)}>
          Connect
        </Button>
      }
    >
      {connections.isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="h-3.5 w-3.5" /> Loading connections…
        </div>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Not connected yet. Use “Connect” to authorize one shared upstream account for this
          provider; it then serves every resource and caller that policy routes through it.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-border">
              {rows.map((connection) => (
                <tr key={connection.id}>
                  <td className="px-3 py-2 align-top">
                    <div className="break-all font-mono text-xs text-foreground">
                      {connection.subject_id === SHARED_CONNECTION_SUBJECT
                        ? "Shared account"
                        : connection.subject_id}
                    </div>
                  </td>
                  <td className="px-3 py-2 align-top text-right">
                    <ConnectionHealthBadge connection={connection} />
                    {connection.expires_at ? (
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        {new Date(connection.expires_at) < new Date()
                          ? connection.renewable
                            ? "refreshes on use"
                            : "expired " + new Date(connection.expires_at).toLocaleString()
                          : "expires " + new Date(connection.expires_at).toLocaleString()}
                      </div>
                    ) : (
                      <div className="mt-0.5 text-[11px] text-muted-foreground">non-expiring</div>
                    )}
                  </td>
                  <td className="w-20 px-3 py-2 text-right align-top">
                    {connection.status === "active" ? (
                      <button
                        onClick={() => setRevokeTarget(connection)}
                        className="text-xs font-medium text-destructive hover:underline"
                      >
                        Revoke
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConnectProviderModal
        open={connectOpen}
        provider={provider}
        zoneId={zoneId}
        onClose={() => setConnectOpen(false)}
        onConnected={() => connections.refetch()}
      />

      <ConfirmDialog
        open={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        title="Revoke connection"
        description={`Revoking ${provider.name} for ${revokeTarget?.subject_id === SHARED_CONNECTION_SUBJECT ? "the shared account" : `"${revokeTarget?.subject_id ?? ""}"`} immediately invalidates the stored upstream tokens for every resource routed through this provider. Reconnect to regain access.`}
        confirmLabel="Revoke connection"
        tone="danger"
        onConfirm={async () => {
          if (!revokeTarget) return;
          try {
            const result = await revoke.mutateAsync({
              subject_id: revokeTarget.subject_id,
              provider_id: revokeTarget.provider_id,
            });
            if (result.upstream_revocation === "revoked") {
              toast({
                tone: "info",
                title: "Connection revoked",
                description: `${revokeTarget.subject_id} — the upstream token was also revoked at the provider.`,
              });
            } else if (result.upstream_revocation === "unsupported") {
              toast({
                tone: "info",
                title: "Connection revoked in Caracal",
                description:
                  "This provider does not advertise standards-based token revocation (RFC 7009); the upstream token may stay valid until it expires at the provider.",
              });
            } else {
              toast({
                tone: "info",
                title: "Connection revoked in Caracal",
                description:
                  "Upstream revocation could not be completed at the provider; the upstream token may stay valid until it expires.",
              });
            }
          } catch (err) {
            toast({ tone: "error", title: "Revoke failed", description: errorMessage(err) });
          }
        }}
      />
    </DetailSection>
  );
}

// Drives the OAuth connect flow: one authenticated upstream account per subject and
// provider, reused by every resource routed through the provider. The subject must
// match the runtime session subject exactly - today that is the application identity,
// so the field suggests the zone's applications - and the resulting authorization URL
// is presented with copy + open actions and a live expiry so operators can hand it off
// to whoever owns the upstream account.
function ConnectProviderModal({
  open,
  provider,
  zoneId,
  onClose,
  onConnected,
}: {
  open: boolean;
  provider: Provider;
  zoneId: string;
  onClose: () => void;
  onConnected: () => void;
}) {
  const copy = useCopyToClipboard();
  const applicationsQuery = useApplications(zoneId);
  const authorize = useAuthorizeProviderConnection(zoneId);
  const [subjectId, setSubjectId] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [result, setResult] = useState<{ url: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const upstreamScopes = Array.isArray(provider.config_json?.scopes)
    ? (provider.config_json.scopes as string[])
    : [];

  function reset() {
    setSubjectId("");
    setAdvanced(false);
    setResult(null);
    setError(null);
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function submit() {
    setError(null);
    if (advanced && !subjectId.trim())
      return setError("Enter a subject, or switch back to a shared account.");
    try {
      const res = await authorize.mutateAsync({
        subject_id: advanced ? subjectId.trim() : undefined,
        provider_id: provider.id,
      });
      setResult({ url: res.authorization_url, expiresAt: res.expires_at });
      onConnected();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={`Connect ${provider.name}`}
      description="Authorize one upstream account for this provider. It serves every resource and caller that policy routes through the provider."
      footer={
        result ? (
          <Button onClick={handleClose}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={handleClose}>
              Cancel
            </Button>
            <Button onClick={submit} loading={authorize.isPending}>
              Generate link
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Send this authorization link to whoever owns the upstream account. After they approve,
            Caracal stores the connection automatically. The link expires{" "}
            <span className="text-foreground">{new Date(result.expiresAt).toLocaleString()}</span>.
          </p>
          <div className="flex items-stretch gap-2">
            <input
              readOnly
              value={result.url}
              className="min-w-0 flex-1 border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-foreground"
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void copy(result.url, { successTitle: "Link copied" })}
            >
              Copy
            </Button>
            <a href={result.url} target="_blank" rel="noreferrer">
              <Button size="sm">Open</Button>
            </a>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            {advanced
              ? "This connection is bound to one subject and is used only when that subject makes the call — for per-customer upstream accounts you federate."
              : "This connects one shared upstream account. Every caller that policy authorizes through this provider uses it — no per-caller subject needed."}
          </p>
          {advanced ? (
            <>
              <Field
                label="Subject"
                info="The runtime identity that will use this connection. It must exactly match the Subject of the Sessions making calls; for an Application acting as itself, use the Application ID."
                hint="For an Application acting as itself, use the Application ID."
                placeholder="Select or paste an application ID"
                list="connect-subject-suggestions"
                value={subjectId}
                onChange={(e) => setSubjectId(e.target.value)}
                autoFocus
              />
              <datalist id="connect-subject-suggestions">
                {(applicationsQuery.data ?? []).map((app) => (
                  <option key={app.id} value={app.id}>
                    {app.name}
                  </option>
                ))}
              </datalist>
            </>
          ) : null}
          <button
            type="button"
            className="self-start text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
            onClick={() => {
              setAdvanced((v) => !v);
              setError(null);
            }}
          >
            {advanced ? "Use a shared account instead" : "Bind to a specific subject (advanced)"}
          </button>
          {upstreamScopes.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              The provider will request these upstream scopes during consent:{" "}
              <span className="font-mono">{upstreamScopes.join(" ")}</span>
            </p>
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
      )}
    </Modal>
  );
}
