/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Applications route.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import {
  CopyValue,
  DangerZone,
  DetailField,
  DetailGroup,
  DetailHeader,
  DetailSection,
  ResourceWorkspace,
} from "@/components/console/ResourceWorkspace";
import type { FilterGroup } from "@/components/ui";
import { ZoneScopedPage } from "@/components/console/ZoneScope";
import {
  Badge,
  Button,
  ConfirmDialog,
  Field,
  IdentityAvatar,
  Modal,
  Select,
  useCopyToClipboard,
  useToast,
  type Column,
} from "@/components/ui";
import { ConsoleApiError } from "@/platform/api/client";
import {
  useApplications,
  useCreateApplication,
  useDeleteApplication,
  useResources,
  useRotateApplicationSecret,
  useRunManifest,
  useSaveRunManifest,
  useUpdateApplication,
} from "@/platform/api/hooks";
import { useCreateDeepLink } from "@/platform/nav/createDeepLink";
import type { Application, RunManifest, RunManifestCredential } from "@/platform/api/types";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/applications")({
  component: ApplicationsRoute,
  validateSearch: (search: Record<string, unknown>): { create?: string; focus?: string } => ({
    create: typeof search.create === "string" ? search.create : undefined,
    focus: typeof search.focus === "string" ? search.focus : undefined,
  }),
});

function ApplicationsRoute() {
  return (
    <ZoneScopedPage
      title="Applications"
      description="Agent identities that can request authority in this zone."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Applications" }]}
    >
      {(zone) => <ApplicationsPage zoneId={zone.id} zoneName={zone.name} />}
    </ZoneScopedPage>
  );
}

type CredentialState = "active" | "expiring" | "expired";

function credentialState(app: Application): CredentialState {
  if (!app.expires_at) return "active";
  const at = Date.parse(app.expires_at);
  const now = Date.now();
  if (at < now) return "expired";
  if (at < now + 7 * 24 * 60 * 60 * 1000) return "expiring";
  return "active";
}

function isManaged(app: Application): boolean {
  return app.registration_method !== "dcr";
}

type TypeFilter = "all" | "managed" | "dynamic";
type CredentialFilter = "all" | "active" | "expiring" | "expired";

// Ranks credential states for sorting so the most urgent (expired) sorts to one end and
// healthy identities to the other.
function credentialRank(app: Application): number {
  const state = credentialState(app);
  return state === "expired" ? 0 : state === "expiring" ? 1 : 2;
}

function errorMessage(error: unknown): string {
  if (error instanceof ConsoleApiError) {
    if (error.notConfigured) return "Control plane not connected.";
    if (error.unreachable) return "Control plane unreachable.";
    if (error.code === "application_name_taken")
      return "An application with this name already exists in this zone.";
    return error.code;
  }
  return "Unexpected error.";
}

function ApplicationsPage({ zoneId, zoneName }: { zoneId: string; zoneName: string }) {
  const toast = useToast();
  const query = useApplications(zoneId);
  const createApp = useCreateApplication(zoneId);
  const updateApp = useUpdateApplication(zoneId);
  const rotateSecret = useRotateApplicationSecret(zoneId);
  const deleteApp = useDeleteApplication(zoneId);

  const [createOpen, setCreateOpen] = useState(false);
  useCreateDeepLink({
    to: "/app/applications",
    value: Route.useSearch().create,
    open: () => setCreateOpen(true),
  });
  const [secret, setSecret] = useState<{
    name: string;
    appId: string;
    clientSecret: string;
    rotated: boolean;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Application | null>(null);
  const [rotateTarget, setRotateTarget] = useState<Application | null>(null);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [credentialFilter, setCredentialFilter] = useState<CredentialFilter>("all");

  const allRows = useMemo(() => query.data ?? [], [query.data]);

  const counts = useMemo(() => {
    let managed = 0;
    let dynamic = 0;
    let active = 0;
    let expiring = 0;
    let expired = 0;
    for (const app of allRows) {
      if (isManaged(app)) managed += 1;
      else dynamic += 1;
      const state = credentialState(app);
      if (state === "active") active += 1;
      else if (state === "expiring") expiring += 1;
      else expired += 1;
    }
    return { managed, dynamic, active, expiring, expired };
  }, [allRows]);

  const rows = useMemo(
    () =>
      allRows.filter((app) => {
        if (typeFilter === "managed" && !isManaged(app)) return false;
        if (typeFilter === "dynamic" && isManaged(app)) return false;
        if (credentialFilter !== "all" && credentialState(app) !== credentialFilter) return false;
        return true;
      }),
    [allRows, typeFilter, credentialFilter],
  );

  const filters: FilterGroup[] = [
    {
      id: "type",
      label: "Type",
      value: typeFilter,
      onChange: (v) => setTypeFilter(v as TypeFilter),
      options: [
        { id: "all", label: "All types", count: allRows.length },
        { id: "managed", label: "Managed", count: counts.managed },
        { id: "dynamic", label: "Dynamic (DCR)", count: counts.dynamic },
      ],
    },
    {
      id: "credential",
      label: "Credential",
      value: credentialFilter,
      onChange: (v) => setCredentialFilter(v as CredentialFilter),
      options: [
        { id: "all", label: "Any credential", count: allRows.length },
        { id: "active", label: "Active", count: counts.active },
        { id: "expiring", label: "Expiring", count: counts.expiring },
        { id: "expired", label: "Expired", count: counts.expired },
      ],
    },
  ];

  const columns: Column<Application>[] = [
    {
      id: "name",
      header: "Application",
      sortable: true,
      truncate: true,
      cell: (app) => (
        <div className="flex items-center gap-3">
          <IdentityAvatar seed={app.id || app.name} />
          <div className="min-w-0">
            <div className="truncate font-medium text-foreground">{app.name}</div>
            <div className="truncate font-mono text-xs text-muted-foreground">{app.id}</div>
          </div>
        </div>
      ),
    },
    {
      id: "type",
      header: "Type",
      sortable: true,
      cell: (app) => <Badge tone="neutral">{isManaged(app) ? "Managed" : "Dynamic (DCR)"}</Badge>,
    },
    {
      id: "credential",
      header: "Credential",
      sortable: true,
      cell: (app) => <CredentialBadge app={app} />,
    },
    {
      id: "created",
      header: "Created",
      sortable: true,
      align: "right",
      cell: (app) => (
        <span className="text-xs text-muted-foreground">
          {new Date(app.created_at).toLocaleDateString()}
        </span>
      ),
    },
  ];

  return (
    <>
      <ResourceWorkspace
        title="Applications"
        description="Agent identities that can request authority in this zone."
        breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Applications" }]}
        primaryAction={{ label: "New application", onClick: () => setCreateOpen(true) }}
        rows={rows}
        loading={query.isLoading}
        columns={columns}
        rowKey={(app) => app.id}
        filters={allRows.length > 0 ? filters : undefined}
        search={{
          placeholder: "Search applications…",
          match: (app, q) => app.name.toLowerCase().includes(q) || app.id.toLowerCase().includes(q),
        }}
        initialSort={{ column: "created", direction: "desc" }}
        sortValues={{
          name: (app) => app.name.toLowerCase(),
          type: (app) => (isManaged(app) ? "0" : "1"),
          credential: (app) => credentialRank(app),
          created: (app) => Date.parse(app.created_at) || 0,
        }}
        empty={{
          title: query.isError ? "Could not load applications" : "No applications yet",
          description: query.isError
            ? errorMessage(query.error)
            : "Create an application to give an agent a scoped identity in this zone.",
        }}
        detail={{
          title: (app) => app.name,
          description: (app) => app.id,
          width: "max-w-xl",
          icon: (app) => <IdentityAvatar seed={app.id || app.name} size="lg" />,
          render: (app) => (
            <ApplicationDetail
              app={app}
              zoneId={zoneId}
              busy={updateApp.isPending}
              onRename={async (name) => {
                try {
                  await updateApp.mutateAsync({ id: app.id, input: { name } });
                  toast({ tone: "success", title: "Application renamed", description: name });
                } catch (err) {
                  toast({ tone: "error", title: "Rename failed", description: errorMessage(err) });
                  throw err;
                }
              }}
              onRotate={() => setRotateTarget(app)}
              onDelete={() => setDeleteTarget(app)}
            />
          ),
        }}
      />

      <CreateApplicationModal
        open={createOpen}
        zoneName={zoneName}
        busy={createApp.isPending}
        onClose={() => setCreateOpen(false)}
        onSubmit={async (name) => {
          try {
            const app = await createApp.mutateAsync({
              name,
              registration_method: "managed",
            });
            setCreateOpen(false);
            if (app.client_secret) {
              setSecret({
                name: app.name,
                appId: app.id,
                clientSecret: app.client_secret,
                rotated: false,
              });
            } else {
              toast({ tone: "success", title: "Application created", description: app.name });
            }
          } catch (err) {
            toast({ tone: "error", title: "Create failed", description: errorMessage(err) });
          }
        }}
      />

      <SecretModal
        secret={secret}
        onClose={() => setSecret(null)}
        onCopied={() => toast({ tone: "success", title: "Client secret copied" })}
      />

      <ConfirmDialog
        open={rotateTarget !== null}
        onClose={() => setRotateTarget(null)}
        title="Rotate client secret"
        description={`This immediately invalidates the current secret for "${rotateTarget?.name ?? ""}". Any agent using the old secret will fail to authenticate until updated.`}
        confirmLabel="Rotate secret"
        tone="danger"
        onConfirm={async () => {
          if (!rotateTarget) return;
          try {
            const rotated = await rotateSecret.mutateAsync(rotateTarget.id);
            if (rotated.client_secret) {
              setSecret({
                name: rotateTarget.name,
                appId: rotateTarget.id,
                clientSecret: rotated.client_secret,
                rotated: true,
              });
            }
          } catch (err) {
            toast({ tone: "error", title: "Rotation failed", description: errorMessage(err) });
          }
        }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete application"
        description={`Archiving "${deleteTarget?.name ?? ""}" revokes its identity: it can no longer obtain tokens, any agent using its credentials stops authenticating, and any resource bound to it as a Gateway application loses that route. The record is retained for audit.`}
        confirmLabel="Delete application"
        tone="danger"
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await deleteApp.mutateAsync(deleteTarget.id);
            toast({ tone: "info", title: "Application deleted", description: deleteTarget.name });
          } catch (err) {
            toast({ tone: "error", title: "Delete failed", description: errorMessage(err) });
          }
        }}
      />
    </>
  );
}

/* ------------------------------ list cells ------------------------------ */

function CredentialBadge({ app }: { app: Application }) {
  const state = credentialState(app);
  if (state === "expired") return <Badge tone="danger">Expired</Badge>;
  if (state === "expiring") return <Badge tone="warning">Expiring</Badge>;
  return <Badge tone="success">Active</Badge>;
}

/* --------------------------- management drawer --------------------------- */

function ApplicationDetail({
  app,
  zoneId,
  busy,
  onRename,
  onRotate,
  onDelete,
}: {
  app: Application;
  zoneId: string;
  busy: boolean;
  onRename: (name: string) => Promise<void>;
  onRotate: () => void;
  onDelete: () => void;
}) {
  const managed = isManaged(app);
  const state = credentialState(app);

  return (
    <div className="flex flex-col gap-6">
      <DetailHeader>
        <CredentialBadge app={app} />
        <Badge tone="neutral">{managed ? "Managed" : "Dynamic (DCR)"}</Badge>
        {app.expires_at ? (
          <span className="text-xs text-muted-foreground">
            {state === "expired" ? "Expired " : "Expires "}
            {new Date(app.expires_at).toLocaleString()}
          </span>
        ) : null}
      </DetailHeader>

      <IdentitySection app={app} busy={busy} onRename={onRename} />

      {managed ? (
        <CredentialsSection onRotate={onRotate} />
      ) : (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Dynamic clients are registered programmatically and expire automatically. Their client
          secret is issued by the registering system and cannot be rotated here.
        </p>
      )}

      {managed ? <RunSection app={app} zoneId={zoneId} /> : null}

      <DangerZone
        description={
          managed
            ? "Permanently revoke this identity. This cannot be undone."
            : "Revoke this dynamic client now instead of waiting for it to expire. This cannot be undone."
        }
        actionLabel="Delete"
        onAction={onDelete}
      />
    </div>
  );
}

function IdentitySection({
  app,
  busy,
  onRename,
}: {
  app: Application;
  busy: boolean;
  onRename: (name: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(app.name);

  useEffect(() => {
    setName(app.name);
    setEditing(false);
  }, [app.id, app.name]);

  return (
    <DetailGroup title="Identity">
      <div className="grid grid-cols-1 gap-0.5 px-3 py-2.5 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-3">
        <dt className="text-xs font-medium text-muted-foreground sm:pt-2">Name</dt>
        <dd className="min-w-0">
          {editing ? (
            <div className="flex items-center gap-2">
              <Field
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="flex-1"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && name.trim() && name.trim() !== app.name) {
                    void onRename(name.trim()).then(() => setEditing(false));
                  } else if (e.key === "Escape") {
                    setName(app.name);
                    setEditing(false);
                  }
                }}
              />
              <Button
                size="sm"
                loading={busy}
                mutating
                disabled={!name.trim() || name.trim() === app.name}
                onClick={() => void onRename(name.trim()).then(() => setEditing(false))}
              >
                Save
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setName(app.name);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex min-h-9 items-center justify-between gap-2">
              <span className="min-w-0 break-words text-sm text-foreground">{app.name}</span>
              <Button variant="ghost" size="sm" mutating onClick={() => setEditing(true)}>
                Rename
              </Button>
            </div>
          )}
        </dd>
      </div>
      <DetailField label="Application ID">
        <CopyValue value={app.id} />
      </DetailField>
      <DetailField label="Created">{new Date(app.created_at).toLocaleString()}</DetailField>
      {(app.traits ?? []).length > 0 ? (
        <DetailField label="Traits">
          <span className="flex flex-wrap gap-1.5">
            {(app.traits ?? []).map((trait) => (
              <span
                key={trait}
                className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
              >
                {trait}
              </span>
            ))}
          </span>
        </DetailField>
      ) : null}
    </DetailGroup>
  );
}

function CredentialsSection({ onRotate }: { onRotate: () => void }) {
  return (
    <DetailSection title="Credentials">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-3">
        <p className="min-w-0 text-xs text-muted-foreground">
          The client secret is shown only once. Rotate to issue a new secret and invalidate the old
          one immediately.
        </p>
        <Button variant="secondary" size="sm" mutating onClick={onRotate} className="flex-shrink-0">
          Rotate secret
        </Button>
      </div>
    </DetailSection>
  );
}

/* ------------------------------ run manifest ----------------------------- */

type BindingBehavior = "required" | "optional_warn" | "optional_error";

function bindingBehavior(cred: RunManifestCredential): BindingBehavior {
  if (!cred.optional) return "required";
  return cred.on_failure === "error" ? "optional_error" : "optional_warn";
}

function applyBehavior(
  cred: RunManifestCredential,
  behavior: BindingBehavior,
): RunManifestCredential {
  if (behavior === "required") return { ...cred, optional: false, on_failure: undefined };
  return { ...cred, optional: true, on_failure: behavior === "optional_warn" ? "warn" : "error" };
}

const EMPTY_BINDING: RunManifestCredential = {
  env: "",
  resource: "",
  credential_type: "provider_token",
  optional: false,
};

function RunSection({ app, zoneId }: { app: Application; zoneId: string }) {
  const toast = useToast();
  const manifestQuery = useRunManifest(zoneId, app.id);
  const saveManifest = useSaveRunManifest(zoneId);
  const resourcesQuery = useResources(zoneId);

  const saved = manifestQuery.data?.run_manifest ?? null;
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<RunManifestCredential[]>([]);
  const [ttl, setTtl] = useState("");

  useEffect(() => {
    setEditing(false);
  }, [app.id]);

  function openEditor() {
    setRows(saved && saved.credentials.length > 0 ? saved.credentials : [{ ...EMPTY_BINDING }]);
    setTtl(saved?.ttl_seconds !== undefined ? String(saved.ttl_seconds) : "");
    setEditing(true);
  }

  function setRow(index: number, row: RunManifestCredential) {
    setRows((current) => current.map((existing, i) => (i === index ? row : existing)));
  }

  const ttlValue = ttl.trim() === "" ? undefined : Number(ttl);
  const ttlInvalid =
    ttlValue !== undefined && (!Number.isInteger(ttlValue) || ttlValue < 1 || ttlValue > 900);
  const incomplete = rows.some((row) => !row.env.trim() || !row.resource);
  const duplicateEnv = new Set(rows.map((row) => row.env.trim())).size !== rows.length;

  async function submit(credentials: RunManifestCredential[]) {
    const input: RunManifest = { credentials };
    if (credentials.length > 0 && ttlValue !== undefined) input.ttl_seconds = ttlValue;
    try {
      await saveManifest.mutateAsync({ id: app.id, input });
      setEditing(false);
      toast({
        tone: "success",
        title: credentials.length > 0 ? "Launch bindings saved" : "Launch bindings cleared",
        description: app.name,
      });
    } catch (err) {
      toast({ tone: "error", title: "Save failed", description: errorMessage(err) });
    }
  }

  if (manifestQuery.isLoading) {
    return (
      <DetailSection title="Run">
        <p className="rounded-lg border border-border bg-card px-3 py-3 text-xs text-muted-foreground">
          Loading launch bindings…
        </p>
      </DetailSection>
    );
  }

  if (editing) {
    return (
      <DetailSection
        title="Run"
        action={
          <div className="flex items-center gap-2">
            {saved && saved.credentials.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                mutating
                loading={saveManifest.isPending}
                onClick={() => void submit([])}
              >
                Clear
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              mutating
              loading={saveManifest.isPending}
              disabled={rows.length === 0 || incomplete || duplicateEnv || ttlInvalid}
              onClick={() => void submit(rows)}
            >
              Save
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          {rows.map((row, index) => (
            <div
              key={index}
              className="flex flex-col gap-3 rounded-lg border border-border bg-card px-3 py-3"
            >
              <div className="flex items-end gap-2">
                <Field
                  label="Environment variable"
                  info="The variable name the workload reads its credential from. caracal run injects the exchanged credential under this exact name at launch."
                  placeholder="CARACAL_RESOURCE_PIPERNET_TOKEN"
                  className="font-mono text-xs"
                  value={row.env}
                  onChange={(e) => setRow(index, { ...row, env: e.target.value })}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Remove binding"
                  onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                >
                  Remove
                </Button>
              </div>
              <Select
                label="Resource"
                info="The protected resource this credential grants access to. Policy decides whether this application may reach it."
                value={row.resource}
                onChange={(e) => setRow(index, { ...row, resource: e.target.value })}
              >
                <option value="" disabled>
                  Select a resource…
                </option>
                {(resourcesQuery.data ?? []).map((resource) => (
                  <option key={resource.id} value={resource.identifier}>
                    {resource.name} ({resource.identifier})
                  </option>
                ))}
              </Select>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Select
                  label="Credential"
                  info="Provider token injects the upstream provider's own credential for direct calls. Caracal mandate injects a Caracal token for workloads that call through the Gateway."
                  value={row.credential_type}
                  onChange={(e) =>
                    setRow(index, {
                      ...row,
                      credential_type: e.target.value as RunManifestCredential["credential_type"],
                    })
                  }
                >
                  <option value="provider_token">Provider token (direct call)</option>
                  <option value="caracal_mandate">Caracal mandate (via Gateway)</option>
                </Select>
                <Select
                  label="If unavailable"
                  info="What happens at launch when this credential cannot be issued, for example when policy denies it or the provider is down."
                  value={bindingBehavior(row)}
                  onChange={(e) =>
                    setRow(index, applyBehavior(row, e.target.value as BindingBehavior))
                  }
                >
                  <option value="required">Fail the launch</option>
                  <option value="optional_warn">Warn and launch without it</option>
                  <option value="optional_error">Optional, but fail the launch</option>
                </Select>
              </div>
            </div>
          ))}
          <div className="flex items-center justify-between gap-3">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setRows((current) => [...current, { ...EMPTY_BINDING }])}
            >
              Add binding
            </Button>
            <Field
              label="Credential TTL (seconds)"
              info="Lifetime of each injected credential, up to the 900-second platform maximum. Leave empty for the default."
              placeholder="900"
              inputMode="numeric"
              className="w-40"
              value={ttl}
              error={ttlInvalid ? "1–900" : undefined}
              onChange={(e) => setTtl(e.target.value)}
            />
          </div>
          {duplicateEnv ? (
            <p className="text-xs text-destructive">
              Each binding must use a unique environment variable name.
            </p>
          ) : null}
        </div>
      </DetailSection>
    );
  }

  if (!saved || saved.credentials.length === 0) {
    return (
      <DetailSection
        title="Run"
        action={
          <Button variant="secondary" size="sm" mutating onClick={openEditor}>
            Configure launch
          </Button>
        }
      >
        <p className="rounded-lg border border-border bg-card px-3 py-3 text-xs text-muted-foreground">
          Define which credentials <code className="font-mono">caracal run</code> injects into this
          workload's environment. Once configured, the workload launches with only its application
          ID and client secret; the zone, resources, and variable names all live here.
        </p>
      </DetailSection>
    );
  }

  const gatewayNeeded = saved.credentials.some(
    (cred) => cred.credential_type === "caracal_mandate",
  );

  return (
    <DetailSection
      title="Run"
      action={
        <Button variant="secondary" size="sm" mutating onClick={openEditor}>
          Edit bindings
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <dl className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {saved.credentials.map((cred) => (
            <div
              key={cred.env}
              className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5"
            >
              <div className="min-w-0">
                <div className="truncate font-mono text-xs text-foreground">{cred.env}</div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {cred.resource}
                </div>
              </div>
              <div className="flex flex-shrink-0 items-center gap-1.5">
                <Badge tone="neutral">
                  {cred.credential_type === "caracal_mandate" ? "Mandate" : "Provider token"}
                </Badge>
                {cred.optional ? <Badge tone="muted">Optional</Badge> : null}
              </div>
            </div>
          ))}
          {saved.ttl_seconds !== undefined ? (
            <DetailField label="Credential TTL">{saved.ttl_seconds}s</DetailField>
          ) : null}
        </dl>

        <div
          className={
            gatewayNeeded
              ? "rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground"
              : "rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-muted-foreground"
          }
        >
          {gatewayNeeded ? (
            <>
              <span className="font-medium text-foreground">Gateway required.</span> At least one
              binding injects a Caracal mandate, so point the workload's base URL for those
              resources at the Caracal Gateway (default{" "}
              <code className="font-mono">http://localhost:8081</code>). The Gateway authorizes each
              call and forwards it upstream.
            </>
          ) : (
            <>
              <span className="font-medium text-foreground">No gateway required.</span> Every
              binding injects the provider's own credential, so the workload calls each provider
              directly.
            </>
          )}
        </div>

        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-3">
          <p className="text-xs font-medium text-foreground">Launch this workload</p>
          <CopyValue value={`export CARACAL_APPLICATION_ID=${app.id}`} />
          <CopyValue value="caracal run -- <your command>" />
          <p className="text-xs text-muted-foreground">
            Provide the client secret via{" "}
            <code className="font-mono">CARACAL_APP_CLIENT_SECRET</code>,{" "}
            <code className="font-mono">CARACAL_APP_CLIENT_SECRET_FILE</code>, or the owner-only
            file at{" "}
            <code className="break-all font-mono">{`<Caracal config dir>/runtime/${app.id}/client-secret`}</code>
            .
          </p>
        </div>
      </div>
    </DetailSection>
  );
}

/* ------------------------------- modals -------------------------------- */

function CreateApplicationModal({
  open,
  zoneName,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  zoneName: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState("");

  useEffect(() => {
    if (open) setName("");
  }, [open]);

  function submit() {
    if (!name.trim()) return;
    onSubmit(name.trim());
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New application"
      description={`Give an agent a managed identity in ${zoneName}.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={!name.trim()}>
            Create application
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Name"
          info="Human-readable name for this managed application identity, shown across the console. Use a short operational name, not an internal ID."
          placeholder="Son of Anton"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          autoFocus
        />
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Creates a managed identity and reveals its client secret once. The application gains
          authority only when a policy grants it scopes on a resource.
        </p>
      </div>
    </Modal>
  );
}

function SecretModal({
  secret,
  onClose,
  onCopied,
}: {
  secret: { name: string; appId: string; clientSecret: string; rotated: boolean } | null;
  onClose: () => void;
  onCopied: () => void;
}) {
  const copy = useCopyToClipboard();

  return (
    <Modal
      open={secret !== null}
      onClose={onClose}
      title={secret?.rotated ? "Store the new client secret now" : "Store the client secret now"}
      description="This secret is shown once and cannot be retrieved later. Copy it before closing."
      footer={<Button onClick={onClose}>Done</Button>}
    >
      {secret ? (
        <div className="flex flex-col gap-3">
          <div className="text-sm text-muted-foreground">{secret.name}</div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs">
              {secret.clientSecret}
            </code>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void copy(secret.clientSecret, { onSuccess: onCopied })}
            >
              Copy
            </Button>
          </div>
          <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            For <code className="font-mono">caracal run</code> workloads, set it as the{" "}
            <code className="font-mono">CARACAL_APP_CLIENT_SECRET</code> environment variable or
            store it owner-only (chmod 600) at{" "}
            <code className="break-all font-mono">
              {`<Caracal config dir>/runtime/${secret.appId}/client-secret`}
            </code>
            , where <code className="font-mono">caracal run</code> finds it automatically. For cloud
            or custom deployments, keep it in your secret store and point{" "}
            <code className="font-mono">CARACAL_APP_CLIENT_SECRET_FILE</code> at the mounted file.
          </p>
        </div>
      ) : null}
    </Modal>
  );
}
