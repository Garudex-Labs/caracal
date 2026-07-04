/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders the Run page where workloads are created, bound to resource credentials, and launched with caracal run.
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
import { SecretModal, type RevealedSecret } from "@/components/console/SecretModal";
import { ZoneScopedPage } from "@/components/console/ZoneScope";
import {
  Badge,
  Button,
  ConfirmDialog,
  Field,
  IdentityAvatar,
  Modal,
  Select,
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
  useSaveRunManifest,
} from "@/platform/api/hooks";
import { useCreateDeepLink } from "@/platform/nav/createDeepLink";
import type { Application, RunManifest, RunManifestCredential } from "@/platform/api/types";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/services/run")({
  component: RunRoute,
  validateSearch: (search: Record<string, unknown>): { create?: string; focus?: string } => ({
    create: typeof search.create === "string" ? search.create : undefined,
    focus: typeof search.focus === "string" ? search.focus : undefined,
  }),
});

function RunRoute() {
  return (
    <ZoneScopedPage
      title="Run"
      description="Workloads that caracal run launches with injected credentials."
      breadcrumbs={[
        { label: "Console", to: "/app" },
        { label: "Services", to: "/app/services" },
        { label: "Run" },
      ]}
    >
      {(zone) => <RunPage zoneId={zone.id} zoneName={zone.name} />}
    </ZoneScopedPage>
  );
}

function isWorkload(app: Application): boolean {
  return app.registration_method !== "dcr";
}

function bindings(app: Application): RunManifestCredential[] {
  return app.run_manifest?.credentials ?? [];
}

function gatewayNeeded(app: Application): boolean {
  return bindings(app).some((cred) => cred.credential_type === "caracal_mandate");
}

type StateFilter = "all" | "ready" | "unconfigured";

function errorMessage(error: unknown): string {
  if (error instanceof ConsoleApiError) {
    if (error.notConfigured) return "Control plane not connected.";
    if (error.unreachable) return "Control plane unreachable.";
    if (error.code === "application_name_taken")
      return "A workload with this name already exists in this zone.";
    return error.code;
  }
  return "Unexpected error.";
}

function RunPage({ zoneId, zoneName }: { zoneId: string; zoneName: string }) {
  const toast = useToast();
  const query = useApplications(zoneId);
  const createApp = useCreateApplication(zoneId);
  const rotateSecret = useRotateApplicationSecret(zoneId);
  const deleteApp = useDeleteApplication(zoneId);

  const [createOpen, setCreateOpen] = useState(false);
  useCreateDeepLink({
    to: "/app/services/run",
    value: Route.useSearch().create,
    open: () => setCreateOpen(true),
  });
  const [secret, setSecret] = useState<RevealedSecret | null>(null);
  const [rotateTarget, setRotateTarget] = useState<Application | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Application | null>(null);
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");

  const allRows = useMemo(() => (query.data ?? []).filter(isWorkload), [query.data]);

  const counts = useMemo(() => {
    let ready = 0;
    for (const app of allRows) if (bindings(app).length > 0) ready += 1;
    return { ready, unconfigured: allRows.length - ready };
  }, [allRows]);

  const rows = useMemo(
    () =>
      allRows.filter((app) => {
        if (stateFilter === "ready") return bindings(app).length > 0;
        if (stateFilter === "unconfigured") return bindings(app).length === 0;
        return true;
      }),
    [allRows, stateFilter],
  );

  const filters: FilterGroup[] = [
    {
      id: "state",
      label: "State",
      value: stateFilter,
      onChange: (v) => setStateFilter(v as StateFilter),
      options: [
        { id: "all", label: "All workloads", count: allRows.length },
        { id: "ready", label: "Ready to run", count: counts.ready },
        { id: "unconfigured", label: "Not configured", count: counts.unconfigured },
      ],
    },
  ];

  const columns: Column<Application>[] = [
    {
      id: "name",
      header: "Workload",
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
      id: "bindings",
      header: "Bindings",
      sortable: true,
      cell: (app) => {
        const count = bindings(app).length;
        return count > 0 ? (
          <span className="text-xs text-foreground">
            {count} {count === 1 ? "credential" : "credentials"}
          </span>
        ) : (
          <Badge tone="muted">Not configured</Badge>
        );
      },
    },
    {
      id: "gateway",
      header: "Gateway",
      sortable: true,
      cell: (app) => {
        if (bindings(app).length === 0)
          return <span className="text-xs text-muted-foreground">—</span>;
        return gatewayNeeded(app) ? (
          <Badge tone="warning">Required</Badge>
        ) : (
          <Badge tone="success">Direct</Badge>
        );
      },
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
        title="Run"
        description="Workloads that caracal run launches with injected credentials."
        breadcrumbs={[
          { label: "Console", to: "/app" },
          { label: "Services", to: "/app/services" },
          { label: "Run" },
        ]}
        primaryAction={{ label: "New workload", onClick: () => setCreateOpen(true) }}
        rows={rows}
        loading={query.isLoading}
        columns={columns}
        rowKey={(app) => app.id}
        filters={allRows.length > 0 ? filters : undefined}
        search={{
          placeholder: "Search workloads…",
          match: (app, q) => app.name.toLowerCase().includes(q) || app.id.toLowerCase().includes(q),
        }}
        initialSort={{ column: "created", direction: "desc" }}
        sortValues={{
          name: (app) => app.name.toLowerCase(),
          bindings: (app) => bindings(app).length,
          gateway: (app) => (bindings(app).length === 0 ? 0 : gatewayNeeded(app) ? 1 : 2),
          created: (app) => Date.parse(app.created_at) || 0,
        }}
        empty={{
          title: query.isError ? "Could not load workloads" : "No workloads yet",
          description: query.isError
            ? errorMessage(query.error)
            : "Create a workload to get its identity and secret, bind the credentials it needs, and launch it with caracal run.",
        }}
        detail={{
          title: (app) => app.name,
          description: (app) => app.id,
          width: "max-w-xl",
          icon: (app) => <IdentityAvatar seed={app.id || app.name} size="lg" />,
          render: (app) => (
            <WorkloadDetail
              app={app}
              zoneId={zoneId}
              onRotate={() => setRotateTarget(app)}
              onDelete={() => setDeleteTarget(app)}
            />
          ),
        }}
      />

      <CreateWorkloadModal
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
              toast({ tone: "success", title: "Workload created", description: app.name });
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
        description={`This immediately invalidates the current secret for "${rotateTarget?.name ?? ""}". Update the workload's secret before its next launch.`}
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
        title="Remove workload"
        description={`Removing "${deleteTarget?.name ?? ""}" revokes its identity: caracal run can no longer authenticate as it and no credentials will be injected. The record is retained for audit.`}
        confirmLabel="Remove workload"
        tone="danger"
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await deleteApp.mutateAsync(deleteTarget.id);
            toast({ tone: "info", title: "Workload removed", description: deleteTarget.name });
          } catch (err) {
            toast({ tone: "error", title: "Remove failed", description: errorMessage(err) });
          }
        }}
      />
    </>
  );
}

/* --------------------------- management drawer --------------------------- */

function WorkloadDetail({
  app,
  zoneId,
  onRotate,
  onDelete,
}: {
  app: Application;
  zoneId: string;
  onRotate: () => void;
  onDelete: () => void;
}) {
  const configured = bindings(app).length > 0;

  return (
    <div className="flex flex-col gap-6">
      <DetailHeader>
        {configured ? (
          gatewayNeeded(app) ? (
            <Badge tone="warning">Gateway required</Badge>
          ) : (
            <Badge tone="success">Direct</Badge>
          )
        ) : (
          <Badge tone="muted">Not configured</Badge>
        )}
        <Badge tone="neutral">
          {bindings(app).length} {bindings(app).length === 1 ? "binding" : "bindings"}
        </Badge>
      </DetailHeader>

      <DetailGroup title="Identity">
        <DetailField label="Workload ID">
          <CopyValue value={app.id} />
        </DetailField>
        <DetailField label="Created">{new Date(app.created_at).toLocaleString()}</DetailField>
        {app.run_manifest_updated_by ? (
          <DetailField label="Configured by">
            {app.run_manifest_updated_by}
            {app.run_manifest_updated_at
              ? ` · ${new Date(app.run_manifest_updated_at).toLocaleString()}`
              : ""}
          </DetailField>
        ) : null}
      </DetailGroup>

      <BindingsSection app={app} zoneId={zoneId} />

      {configured ? <LaunchSection app={app} /> : null}

      <DetailSection title="Secret">
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-3">
          <p className="min-w-0 text-xs text-muted-foreground">
            The client secret is shown only once. Rotate to issue a new secret and invalidate the
            old one immediately.
          </p>
          <Button
            variant="secondary"
            size="sm"
            mutating
            onClick={onRotate}
            className="flex-shrink-0"
          >
            Rotate secret
          </Button>
        </div>
      </DetailSection>

      <DangerZone
        description="Permanently revoke this workload's identity. This cannot be undone."
        actionLabel="Remove"
        onAction={onDelete}
      />
    </div>
  );
}

/* ------------------------------- bindings ------------------------------- */

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

function BindingsSection({ app, zoneId }: { app: Application; zoneId: string }) {
  const toast = useToast();
  const saveManifest = useSaveRunManifest(zoneId);
  const resourcesQuery = useResources(zoneId);

  const saved = app.run_manifest ?? null;
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
        title: credentials.length > 0 ? "Bindings saved" : "Bindings cleared",
        description: app.name,
      });
    } catch (err) {
      toast({ tone: "error", title: "Save failed", description: errorMessage(err) });
    }
  }

  if (editing) {
    return (
      <DetailSection
        title="Bindings"
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
                info="The protected resource this credential grants access to. Policy decides whether this workload may reach it."
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
        title="Bindings"
        action={
          <Button variant="secondary" size="sm" mutating onClick={openEditor}>
            Configure launch
          </Button>
        }
      >
        <p className="rounded-lg border border-border bg-card px-3 py-3 text-xs text-muted-foreground">
          Define which credentials <code className="font-mono">caracal run</code> injects into this
          workload's environment. Once configured, the workload launches with only its ID and client
          secret; the zone, resources, and variable names all live here.
        </p>
      </DetailSection>
    );
  }

  const gateway = gatewayNeeded(app);

  return (
    <DetailSection
      title="Bindings"
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
            gateway
              ? "rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground"
              : "rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-muted-foreground"
          }
        >
          {gateway ? (
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
      </div>
    </DetailSection>
  );
}

/* -------------------------------- launch -------------------------------- */

function LaunchSection({ app }: { app: Application }) {
  return (
    <DetailSection title="Launch">
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-3">
        <p className="text-xs font-medium text-foreground">Launch this workload</p>
        <CopyValue value={`export CARACAL_APPLICATION_ID=${app.id}`} />
        <CopyValue value="caracal run -- <your command>" />
        <p className="text-xs text-muted-foreground">
          Provide the client secret via <code className="font-mono">CARACAL_APP_CLIENT_SECRET</code>
          , <code className="font-mono">CARACAL_APP_CLIENT_SECRET_FILE</code>, or the owner-only
          file at{" "}
          <code className="break-all font-mono">{`<Caracal config dir>/runtime/${app.id}/client-secret`}</code>
          .
        </p>
      </div>
    </DetailSection>
  );
}

/* ------------------------------- modals -------------------------------- */

function CreateWorkloadModal({
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
      title="New workload"
      description={`Give a workload an identity and secret in ${zoneName}.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={!name.trim()}>
            Create workload
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Name"
          info="Human-readable name for this workload, shown across the console. Use a short operational name, not an internal ID."
          placeholder="Son of Anton"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          autoFocus
        />
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Creates the workload's identity and reveals its client secret once. Bind the credentials
          it needs next, then launch it anywhere with <code className="font-mono">caracal run</code>
          .
        </p>
      </div>
    </Modal>
  );
}
