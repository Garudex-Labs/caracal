/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Providers route.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { ProviderFormModal } from "@/components/console/ProviderForm";
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
  Select,
  Spinner,
  useToast,
  type Column,
  type FilterGroup,
} from "@/components/ui";
import { ConsoleApiError } from "@/platform/api/client";
import {
  useAuthorizeProviderGrant,
  useCreateProvider,
  useDeleteProvider,
  useProviderGrants,
  useProviders,
  useResources,
  useRevokeProviderGrant,
  useUpdateProvider,
} from "@/platform/api/hooks";
import { useCreateDeepLink } from "@/platform/nav/createDeepLink";
import type {
  Provider,
  ProviderGrant,
  ProviderInput,
  ProviderKind,
  Resource,
} from "@/platform/api/types";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/providers")({
  component: ProvidersRoute,
  validateSearch: (search: Record<string, unknown>): { create?: string; focus?: string } => ({
    create: typeof search.create === "string" ? search.create : undefined,
    focus: typeof search.focus === "string" ? search.focus : undefined,
  }),
});

const KIND_LABEL: Record<ProviderKind, string> = {
  none: "None",
  caracal_mandate: "Caracal mandate",
  oauth2_authorization_code: "OAuth 2.0 (auth code)",
  oauth2_client_credentials: "OAuth 2.0 (client creds)",
  api_key: "API key",
  bearer_token: "Bearer token",
};

const KIND_SHORT: Record<ProviderKind, string> = {
  none: "None",
  caracal_mandate: "Mandate",
  oauth2_authorization_code: "OAuth · auth code",
  oauth2_client_credentials: "OAuth · client creds",
  api_key: "API key",
  bearer_token: "Bearer",
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

function errorMessage(error: unknown): string {
  if (error instanceof ConsoleApiError) {
    if (error.notConfigured) return "Control plane not connected.";
    if (error.unreachable) return "Control plane unreachable.";
    return error.code.replace(/_/g, " ");
  }
  return "Unexpected error.";
}

// Surfaces the concrete blast radius of deleting a provider: the resources bound to it as
// their credential source will lose upstream access the moment it is removed.
function deleteProviderDescription(provider: Provider | null, resources: Resource[]): string {
  if (!provider) return "";
  const bound = resources.filter((r) => r.credential_provider_id === provider.id);
  if (bound.length === 0) {
    return `Deleting "${provider.name}" removes its credential routing. No resources are bound to it. This cannot be undone.`;
  }
  const names = bound
    .slice(0, 3)
    .map((r) => r.name)
    .join(", ");
  const more = bound.length > 3 ? ` and ${bound.length - 3} more` : "";
  return `Deleting "${provider.name}" will break upstream access for ${bound.length} bound resource${bound.length === 1 ? "" : "s"} (${names}${more}). They will fail until rebound to another provider. This cannot be undone.`;
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
  if (Array.isArray(config.allowed_token_hosts) && config.allowed_token_hosts.length > 0) {
    return String(config.allowed_token_hosts[0]);
  }
  return "-";
}

function ProvidersPage({ zoneId, zoneName }: { zoneId: string; zoneName: string }) {
  const toast = useToast();
  const query = useProviders(zoneId);
  const resourcesQuery = useResources(zoneId);
  const createProvider = useCreateProvider(zoneId);
  const updateProvider = useUpdateProvider(zoneId);
  const deleteProvider = useDeleteProvider(zoneId);

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
          <div className="truncate font-medium text-foreground">{p.name}</div>
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
        filters={allRows.length > 0 ? filters : undefined}
        search={{
          placeholder: "Search providers…",
          match: (p, q) =>
            p.name.toLowerCase().includes(q) ||
            p.identifier.toLowerCase().includes(q) ||
            KIND_LABEL[p.kind].toLowerCase().includes(q),
        }}
        initialSort={{ column: "created", direction: "desc" }}
        sortValues={{
          name: (p) => p.name.toLowerCase(),
          created: (p) => Date.parse(p.created_at) || 0,
        }}
        empty={{
          title: query.isError ? "Could not load providers" : "No providers configured",
          description: query.isError
            ? errorMessage(query.error)
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
        onClose={() => setCreateOpen(false)}
        onSubmit={async (input) => {
          try {
            const created = await createProvider.mutateAsync(input);
            setCreateOpen(false);
            toast({ tone: "success", title: "Provider created", description: created.name });
          } catch (err) {
            toast({ tone: "error", title: "Create failed", description: errorMessage(err) });
          }
        }}
      />

      <ProviderFormModal
        open={editTarget !== null}
        mode="edit"
        provider={editTarget ?? undefined}
        busy={updateProvider.isPending}
        onClose={() => setEditTarget(null)}
        onSubmit={async (input: ProviderInput) => {
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
        title="Delete provider"
        description={deleteProviderDescription(deleteTarget, resourcesQuery.data ?? [])}
        confirmLabel="Delete provider"
        tone="danger"
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await deleteProvider.mutateAsync(deleteTarget.id);
            toast({ tone: "info", title: "Provider deleted", description: deleteTarget.name });
          } catch (err) {
            toast({ tone: "error", title: "Delete failed", description: errorMessage(err) });
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
  const toast = useToast();
  const secretKeys = new Set(provider.secret_config_keys);
  const configEntries = Object.entries(provider.config_json ?? {}).filter(
    ([key]) => !secretKeys.has(key as never),
  );
  const credentialKind = provider.kind !== "none" && provider.kind !== "caracal_mandate";

  return (
    <div className="flex flex-col gap-6">
      <DetailHeader
        action={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(JSON.stringify(provider, null, 2));
                toast({ tone: "success", title: "Provider JSON copied" });
              }}
            >
              Copy JSON
            </Button>
            <Button variant="secondary" size="sm" onClick={onEdit}>
              Edit
            </Button>
          </>
        }
      >
        <Badge tone="neutral">{KIND_LABEL[provider.kind]}</Badge>
        {provider.secret_config_keys.length > 0 ? (
          <Badge tone="warning">Secrets sealed</Badge>
        ) : credentialKind ? (
          <Badge tone="muted">No secret stored</Badge>
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
        <DetailField label="Created">{new Date(provider.created_at).toLocaleString()}</DetailField>
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

      <ProviderConnections provider={provider} zoneId={zoneId} />

      <DangerZone
        description="Remove this provider and its credential routing."
        actionLabel="Delete"
        onAction={onDelete}
      />
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

/* ------------------------------ Provider grants ----------------------------- */

// Provider grants only apply to delegated OAuth (authorization_code). For every other
// kind the upstream credential is sealed on the provider itself, so there is nothing
// per-user to connect.
function ProviderConnections({ provider, zoneId }: { provider: Provider; zoneId: string }) {
  const isDelegatedOAuth = provider.kind === "oauth2_authorization_code";
  const toast = useToast();
  const grants = useProviderGrants(zoneId, isDelegatedOAuth ? provider.id : null);
  const revoke = useRevokeProviderGrant(zoneId);
  const [connectOpen, setConnectOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ProviderGrant | null>(null);

  if (!isDelegatedOAuth) {
    return (
      <DetailSection title="Connections">
        <p className="text-xs text-muted-foreground">
          {provider.kind === "none" || provider.kind === "caracal_mandate"
            ? "This provider issues no upstream credential, so there is nothing to connect per user."
            : "This provider seals a single shared upstream credential. Per-user OAuth connections apply only to authorization-code providers."}
        </p>
      </DetailSection>
    );
  }

  const rows = grants.data ?? [];

  return (
    <DetailSection
      title={`Connected users (${rows.length})`}
      action={
        <Button variant="secondary" size="sm" mutating onClick={() => setConnectOpen(true)}>
          Connect user
        </Button>
      }
    >
      {grants.isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="h-3.5 w-3.5" /> Loading connections…
        </div>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No users connected yet. Use “Connect user” to start the OAuth authorization flow for a
          subject and resource.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-border">
              {rows.map((grant) => (
                <tr key={grant.id}>
                  <td className="px-3 py-2 align-top">
                    <div className="break-all font-mono text-xs text-foreground">
                      {grant.user_id}
                    </div>
                    <div className="mt-0.5 break-words font-mono text-[11px] text-muted-foreground">
                      {grant.scopes.join(" · ") || "no scopes"}
                    </div>
                  </td>
                  <td className="px-3 py-2 align-top text-right">
                    <Badge tone={grant.status === "active" ? "success" : "muted"}>
                      {grant.status}
                    </Badge>
                  </td>
                  <td className="w-20 px-3 py-2 text-right align-top">
                    {grant.status === "active" ? (
                      <button
                        onClick={() => setRevokeTarget(grant)}
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
        onConnected={() => grants.refetch()}
      />

      <ConfirmDialog
        open={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        title="Revoke connection"
        description={`Revoking ${provider.name} for "${revokeTarget?.user_id ?? ""}" immediately invalidates the stored upstream tokens. The user must reconnect to regain access.`}
        confirmLabel="Revoke connection"
        tone="danger"
        onConfirm={async () => {
          if (!revokeTarget) return;
          try {
            await revoke.mutateAsync({
              user_id: revokeTarget.user_id,
              resource_id: revokeTarget.resource_id,
              provider_id: revokeTarget.provider_id,
            });
            toast({ tone: "info", title: "Connection revoked", description: revokeTarget.user_id });
          } catch (err) {
            toast({ tone: "error", title: "Revoke failed", description: errorMessage(err) });
          }
        }}
      />
    </DetailSection>
  );
}

// Drives the per-user OAuth authorize flow. The web improves on the TUI here: the
// resource picker is bound to providers that route through this OAuth provider, scopes
// are pre-filled from the chosen resource, and the resulting authorization URL is
// presented with copy + open actions and a live expiry so operators can hand it off.
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
  const toast = useToast();
  const resourcesQuery = useResources(zoneId);
  const authorize = useAuthorizeProviderGrant(zoneId);
  const [userId, setUserId] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [scopes, setScopes] = useState("");
  const [result, setResult] = useState<{ url: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const boundResources = useMemo<Resource[]>(
    () => (resourcesQuery.data ?? []).filter((r) => r.credential_provider_id === provider.id),
    [resourcesQuery.data, provider.id],
  );

  function reset() {
    setUserId("");
    setResourceId("");
    setScopes("");
    setResult(null);
    setError(null);
  }

  function handleClose() {
    reset();
    onClose();
  }

  function selectResource(id: string) {
    setResourceId(id);
    const resource = boundResources.find((r) => r.id === id);
    setScopes(resource ? resource.scopes.join(", ") : "");
  }

  async function submit() {
    setError(null);
    const parsedScopes = scopes
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!userId.trim()) return setError("A subject (user ID) is required.");
    if (!resourceId) return setError("Choose the resource this connection authorizes.");
    if (parsedScopes.length === 0) return setError("At least one scope is required.");
    try {
      const res = await authorize.mutateAsync({
        user_id: userId.trim(),
        resource_id: resourceId,
        provider_id: provider.id,
        scopes: parsedScopes,
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
      title={`Connect a user to ${provider.name}`}
      description="Generate an OAuth authorization link for a subject and resource."
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
            Send this authorization link to the user. After they approve, Caracal stores the
            provider grant automatically. The link expires{" "}
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
              onClick={() => {
                void navigator.clipboard?.writeText(result.url);
                toast({ tone: "success", title: "Link copied" });
              }}
            >
              Copy
            </Button>
            <a href={result.url} target="_blank" rel="noreferrer">
              <Button size="sm">Open</Button>
            </a>
          </div>
        </div>
      ) : boundResources.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No resources route through this provider yet. Bind a resource to{" "}
          <span className="text-foreground">{provider.name}</span> as its credential provider before
          connecting users.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <Field
            label="Subject (user ID)"
            info="The end user this connection authorizes. Their approval binds upstream tokens to this subject for the selected resource."
            placeholder="user@example.com"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            autoFocus
          />
          <Select
            label="Resource"
            info="The protected resource this connection grants the user access to. Only resources routed through this provider are listed."
            value={resourceId}
            onChange={(e) => selectResource(e.target.value)}
          >
            <option value="">Select a resource…</option>
            {boundResources.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} ({r.identifier})
              </option>
            ))}
          </Select>
          <Field
            label="Scopes"
            info="The upstream permissions requested during authorization. Pre-filled from the resource; trim to request least privilege."
            hint="Comma-separated. Pre-filled from the resource; trim to request least privilege."
            placeholder="invoices:read, invoices:write"
            value={scopes}
            onChange={(e) => setScopes(e.target.value)}
          />
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
      )}
    </Modal>
  );
}
