/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Providers route.
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
import { useProviders } from "@/platform/api/hooks";
import type { Provider, ProviderKind } from "@/platform/api/types";

export const Route = createFileRoute("/app/providers")({
  component: ProvidersRoute,
});

const KIND_LABEL: Record<ProviderKind, string> = {
  none: "None",
  caracal_mandate: "Caracal mandate",
  oauth2_authorization_code: "OAuth 2.0 (auth code)",
  oauth2_client_credentials: "OAuth 2.0 (client creds)",
  api_key: "API key",
  bearer_token: "Bearer token",
};

function ProvidersRoute() {
  return (
    <ZoneScopedPage
      title="Providers"
      description="Credential sources that issue upstream access for this zone."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Providers" }]}
    >
      {(zone) => <ProvidersPage zoneId={zone.id} />}
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

function ProvidersPage({ zoneId }: { zoneId: string }) {
  const query = useProviders(zoneId);
  const rows = query.data ?? [];

  const columns: Column<Provider>[] = [
    {
      id: "name",
      header: "Provider",
      sortable: true,
      cell: (p) => (
        <div>
          <div className="font-medium text-foreground">{p.name}</div>
          <div className="font-mono text-xs text-muted-foreground">{p.identifier}</div>
        </div>
      ),
    },
    {
      id: "kind",
      header: "Type",
      cell: (p) => <Badge tone="neutral">{KIND_LABEL[p.kind]}</Badge>,
    },
    {
      id: "secrets",
      header: "Secrets",
      cell: (p) =>
        p.secret_config_keys.length > 0 ? (
          <Badge tone="warning">{p.secret_config_keys.length} stored</Badge>
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
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
    <ResourceWorkspace
      title="Providers"
      description="Credential sources that issue upstream access for this zone."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Providers" }]}
      rows={rows}
      loading={query.isLoading}
      columns={columns}
      rowKey={(p) => p.id}
      search={{
        placeholder: "Search providers…",
        match: (p, q) => p.name.toLowerCase().includes(q) || p.identifier.toLowerCase().includes(q),
      }}
      sortOptions={[
        { id: "name", label: "Name" },
        { id: "recent", label: "Newest" },
      ]}
      empty={{
        title: query.isError ? "Could not load providers" : "No providers configured",
        description: query.isError
          ? errorMessage(query.error)
          : "Add an identity provider so applications can obtain mandates and upstream credentials.",
      }}
      detail={{
        title: (p) => p.name,
        description: (p) => p.identifier,
        width: "max-w-lg",
        render: (p) => <ProviderDetail provider={p} />,
      }}
    />
  );
}

function ProviderDetail({ provider }: { provider: Provider }) {
  const secretKeys = new Set(provider.secret_config_keys);
  const configEntries = Object.entries(provider.config_json ?? {});

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <Badge tone="neutral">{KIND_LABEL[provider.kind]}</Badge>
        {provider.secret_config_keys.length > 0 ? (
          <Badge tone="warning">Secrets stored</Badge>
        ) : null}
      </div>

      <DetailGroup title="Identity">
        <DetailField label="Identifier">
          <Mono>{provider.identifier}</Mono>
        </DetailField>
        <DetailField label="Type">{KIND_LABEL[provider.kind]}</DetailField>
        <DetailField label="Created">{new Date(provider.created_at).toLocaleString()}</DetailField>
      </DetailGroup>

      <DetailGroup title="Configuration">
        {configEntries.length > 0 ? (
          <div className="mt-2 flex flex-col gap-2">
            {configEntries.map(([key, value]) => (
              <div key={key} className="flex items-start justify-between gap-3 text-sm">
                <span className="font-mono text-xs text-muted-foreground">{key}</span>
                <span className="min-w-0 flex-1 truncate text-right font-mono text-xs text-foreground">
                  {secretKeys.has(key as never) ? "••••••••" : formatValue(value)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="pt-2 text-sm text-muted-foreground">No configuration fields.</p>
        )}
      </DetailGroup>

      {provider.secret_config_keys.length > 0 ? (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Stored secrets are masked. They are write-only and never returned by the control plane.
        </p>
      ) : null}
    </div>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
