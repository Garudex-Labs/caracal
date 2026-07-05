/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders the Launcher page where workloads are created, bound to resource credentials, and launched with caracal run.
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
import { CreatedBy } from "@/components/console/CreatedBy";
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
  SearchInput,
  Select,
  useToast,
  type Column,
} from "@/components/ui";
import { ConsoleApiError } from "@/platform/api/client";
import {
  useCreateWorkload,
  useDeleteWorkload,
  useProviders,
  useResources,
  useRotateWorkloadSecret,
  useUpdateWorkload,
  useWorkloads,
} from "@/platform/api/hooks";
import { useCreateDeepLink } from "@/platform/nav/createDeepLink";
import type { Resource, Workload, WorkloadBinding } from "@/platform/api/types";

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
      title="Launcher"
      description="Workloads that caracal run launches with injected credentials."
      breadcrumbs={[
        { label: "Console", to: "/app" },
        { label: "Services", to: "/app/services" },
        { label: "Launcher" },
      ]}
    >
      {(zone) => <RunPage zoneId={zone.id} zoneName={zone.name} />}
    </ZoneScopedPage>
  );
}

type StateFilter = "all" | "ready" | "unconfigured";

function errorMessage(error: unknown): string {
  if (error instanceof ConsoleApiError) {
    if (error.notConfigured) return "Control plane not connected.";
    if (error.unreachable) return "Control plane unreachable.";
    if (error.code === "workload_name_taken")
      return "A workload with this name already exists in this zone.";
    if (error.code === "invalid_credential_env")
      return "That environment variable name is reserved or invalid.";
    if (error.code === "duplicate_credential_env")
      return "Each binding must use a unique environment variable name.";
    return error.code;
  }
  return "Unexpected error.";
}

function RunPage({ zoneId, zoneName }: { zoneId: string; zoneName: string }) {
  const toast = useToast();
  const query = useWorkloads(zoneId);
  const createWorkload = useCreateWorkload(zoneId);
  const rotateSecret = useRotateWorkloadSecret(zoneId);
  const deleteWorkload = useDeleteWorkload(zoneId);

  const [createOpen, setCreateOpen] = useState(false);
  useCreateDeepLink({
    to: "/app/services/run",
    value: Route.useSearch().create,
    open: () => setCreateOpen(true),
  });
  const [secret, setSecret] = useState<RevealedSecret | null>(null);
  const [rotateTarget, setRotateTarget] = useState<Workload | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Workload | null>(null);
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");

  const allRows = useMemo(() => query.data ?? [], [query.data]);

  const counts = useMemo(() => {
    let ready = 0;
    for (const workload of allRows) if (workload.bindings.length > 0) ready += 1;
    return { ready, unconfigured: allRows.length - ready };
  }, [allRows]);

  const rows = useMemo(
    () =>
      allRows.filter((workload) => {
        if (stateFilter === "ready") return workload.bindings.length > 0;
        if (stateFilter === "unconfigured") return workload.bindings.length === 0;
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

  const columns: Column<Workload>[] = [
    {
      id: "name",
      header: "Workload",
      sortable: true,
      truncate: true,
      cell: (workload) => (
        <div className="flex items-center gap-3">
          <IdentityAvatar seed={workload.id || workload.name} />
          <div className="min-w-0">
            <div className="truncate font-medium text-foreground">{workload.name}</div>
            <div className="truncate font-mono text-xs text-muted-foreground">{workload.id}</div>
          </div>
        </div>
      ),
    },
    {
      id: "bindings",
      header: "Bindings",
      sortable: true,
      cell: (workload) =>
        workload.bindings.length > 0 ? (
          <span className="text-xs text-foreground">
            {workload.bindings.length}{" "}
            {workload.bindings.length === 1 ? "credential" : "credentials"}
          </span>
        ) : (
          <Badge tone="muted">Not configured</Badge>
        ),
    },
    {
      id: "created",
      header: "Created",
      sortable: true,
      align: "right",
      cell: (workload) => (
        <span className="text-xs text-muted-foreground">
          {new Date(workload.created_at).toLocaleDateString()}
        </span>
      ),
    },
  ];

  return (
    <>
      <ResourceWorkspace
        title="Launcher"
        description="Workloads that caracal run launches with injected credentials."
        breadcrumbs={[
          { label: "Console", to: "/app" },
          { label: "Services", to: "/app/services" },
          { label: "Launcher" },
        ]}
        primaryAction={{ label: "New workload", onClick: () => setCreateOpen(true) }}
        rows={rows}
        loading={query.isLoading}
        columns={columns}
        rowKey={(workload) => workload.id}
        filters={allRows.length > 0 ? filters : undefined}
        search={{
          placeholder: "Search workloads…",
          match: (workload, q) =>
            workload.name.toLowerCase().includes(q) || workload.id.toLowerCase().includes(q),
        }}
        initialSort={{ column: "created", direction: "desc" }}
        sortValues={{
          name: (workload) => workload.name.toLowerCase(),
          bindings: (workload) => workload.bindings.length,
          created: (workload) => Date.parse(workload.created_at) || 0,
        }}
        empty={{
          title: query.isError ? "Could not load workloads" : "No workloads yet",
          description: query.isError
            ? errorMessage(query.error)
            : "Create a workload to get its identity and secret, bind the credentials it needs, and launch it with caracal run.",
        }}
        detail={{
          title: (workload) => workload.name,
          description: (workload) => workload.id,
          width: "max-w-xl",
          icon: (workload) => <IdentityAvatar seed={workload.id || workload.name} size="lg" />,
          render: (workload) => (
            <WorkloadDetail
              workload={workload}
              zoneId={zoneId}
              onRotate={() => setRotateTarget(workload)}
              onDelete={() => setDeleteTarget(workload)}
            />
          ),
        }}
      />

      <CreateWorkloadModal
        open={createOpen}
        zoneName={zoneName}
        busy={createWorkload.isPending}
        onClose={() => setCreateOpen(false)}
        onSubmit={async (name) => {
          try {
            const workload = await createWorkload.mutateAsync({ name });
            setCreateOpen(false);
            if (workload.secret) {
              setSecret({
                kind: "workload",
                name: workload.name,
                id: workload.id,
                value: workload.secret,
                rotated: false,
              });
            } else {
              toast({ tone: "success", title: "Workload created", description: workload.name });
            }
          } catch (err) {
            toast({ tone: "error", title: "Create failed", description: errorMessage(err) });
          }
        }}
      />

      <SecretModal
        secret={secret}
        onClose={() => setSecret(null)}
        onCopied={() => toast({ tone: "success", title: "Workload secret copied" })}
      />

      <ConfirmDialog
        open={rotateTarget !== null}
        onClose={() => setRotateTarget(null)}
        title="Rotate workload secret"
        description={`This immediately invalidates the current secret for "${rotateTarget?.name ?? ""}". Update the workload's secret before its next launch.`}
        confirmLabel="Rotate secret"
        tone="danger"
        onConfirm={async () => {
          if (!rotateTarget) return;
          try {
            const rotated = await rotateSecret.mutateAsync(rotateTarget.id);
            if (rotated.secret) {
              setSecret({
                kind: "workload",
                name: rotateTarget.name,
                id: rotateTarget.id,
                value: rotated.secret,
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
        title="Delete workload"
        description={`Deleting "${deleteTarget?.name ?? ""}" permanently removes its identity: caracal run can no longer authenticate as it and no credentials will be injected.`}
        confirmLabel="Delete workload"
        tone="danger"
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await deleteWorkload.mutateAsync(deleteTarget.id);
            toast({ tone: "info", title: "Workload deleted", description: deleteTarget.name });
          } catch (err) {
            toast({ tone: "error", title: "Delete failed", description: errorMessage(err) });
          }
        }}
      />
    </>
  );
}

/* --------------------------- management drawer --------------------------- */

function WorkloadDetail({
  workload,
  zoneId,
  onRotate,
  onDelete,
}: {
  workload: Workload;
  zoneId: string;
  onRotate: () => void;
  onDelete: () => void;
}) {
  const configured = workload.bindings.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <DetailHeader>
        {configured ? (
          <Badge tone="success">Ready to run</Badge>
        ) : (
          <Badge tone="muted">Not configured</Badge>
        )}
        <Badge tone="neutral">
          {workload.bindings.length} {workload.bindings.length === 1 ? "binding" : "bindings"}
        </Badge>
      </DetailHeader>

      <DetailGroup title="Identity">
        <DetailField label="Workload ID">
          <CopyValue value={workload.id} />
        </DetailField>
        {workload.created_by ? (
          <DetailField label="Created by">
            <CreatedBy name={workload.created_by} coAuthored={workload.created_via_operator} />
          </DetailField>
        ) : null}
        <DetailField label="Created">{new Date(workload.created_at).toLocaleString()}</DetailField>
        {workload.updated_by ? (
          <DetailField label="Configured by">
            <CreatedBy name={workload.updated_by} coAuthored={workload.updated_via_operator} />
            {workload.updated_at ? (
              <span className="text-muted-foreground">
                {" "}
                · {new Date(workload.updated_at).toLocaleString()}
              </span>
            ) : null}
          </DetailField>
        ) : null}
      </DetailGroup>

      <BindingsSection workload={workload} zoneId={zoneId} />

      {configured ? <LaunchSection workload={workload} /> : null}

      <DetailSection title="Secret">
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-3">
          <p className="min-w-0 text-xs text-muted-foreground">
            The workload secret is shown only once. Rotate to issue a new secret and invalidate the
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
        description="Permanently delete this workload's identity. This cannot be undone."
        actionLabel="Delete"
        onAction={onDelete}
      />
    </div>
  );
}

/* ------------------------------- bindings ------------------------------- */

type BindingBehavior = "required" | "optional_warn" | "optional_error";

function bindingBehavior(binding: WorkloadBinding): BindingBehavior {
  if (!binding.optional) return "required";
  return binding.on_failure === "error" ? "optional_error" : "optional_warn";
}

function applyBehavior(binding: WorkloadBinding, behavior: BindingBehavior): WorkloadBinding {
  if (behavior === "required") return { ...binding, optional: false, on_failure: undefined };
  return {
    ...binding,
    optional: true,
    on_failure: behavior === "optional_warn" ? "warn" : "error",
  };
}

const BINDINGS_MAX = 64;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function scopeSummary(binding: WorkloadBinding): string {
  const count = binding.scopes?.length ?? 0;
  if (count === 0) return "All scopes";
  return count === 1 ? "1 scope" : `${count} scopes`;
}

function suggestEnv(identifier: string): string {
  const slug = identifier
    .replace(/^resource:\/\//, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return slug ? `CARACAL_RESOURCE_${slug}_TOKEN` : "";
}

function BindingsSection({ workload, zoneId }: { workload: Workload; zoneId: string }) {
  const toast = useToast();
  const updateWorkload = useUpdateWorkload(zoneId);

  const saved = workload.bindings;
  const [dialogIndex, setDialogIndex] = useState<number | "add" | null>(null);

  useEffect(() => {
    setDialogIndex(null);
  }, [workload.id]);

  async function submit(bindings: WorkloadBinding[], title: string): Promise<boolean> {
    try {
      await updateWorkload.mutateAsync({ id: workload.id, input: { bindings } });
      toast({ tone: "success", title, description: workload.name });
      return true;
    } catch (err) {
      toast({ tone: "error", title: "Save failed", description: errorMessage(err) });
      return false;
    }
  }

  return (
    <>
      <DetailSection
        title="Bindings"
        action={
          <Button
            variant="secondary"
            size="sm"
            mutating
            disabled={saved.length >= BINDINGS_MAX}
            onClick={() => setDialogIndex("add")}
          >
            Add binding
          </Button>
        }
      >
        {saved.length === 0 ? (
          <p className="rounded-lg border border-border bg-card px-3 py-3 text-xs text-muted-foreground">
            No credentials are injected yet. Add a binding to pick a resource and name the
            environment variable <code className="font-mono">caracal run</code> delivers its
            credential under.
          </p>
        ) : (
          <div className="scrollbar-thin max-h-72 divide-y divide-border overflow-y-auto rounded-lg border border-border bg-card">
            {saved.map((binding, index) => (
              <div key={binding.env} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-xs text-foreground">{binding.env}</div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">
                    {binding.resource}
                  </div>
                </div>
                <div className="flex flex-shrink-0 items-center gap-1.5">
                  <Badge tone="neutral">{scopeSummary(binding)}</Badge>
                  {binding.optional ? <Badge tone="muted">Optional</Badge> : null}
                </div>
                <div className="flex flex-shrink-0 items-center">
                  <Button
                    variant="ghost"
                    size="sm"
                    mutating
                    disabled={updateWorkload.isPending}
                    onClick={() => setDialogIndex(index)}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    mutating
                    disabled={updateWorkload.isPending}
                    onClick={() =>
                      void submit(
                        saved.filter((_, i) => i !== index),
                        "Binding removed",
                      )
                    }
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </DetailSection>

      <BindingDialog
        open={dialogIndex !== null}
        zoneId={zoneId}
        bindings={saved}
        editIndex={typeof dialogIndex === "number" ? dialogIndex : null}
        busy={updateWorkload.isPending}
        onClose={() => setDialogIndex(null)}
        onSubmit={async (binding, editIndex) => {
          const next =
            editIndex === null
              ? [...saved, binding]
              : saved.map((existing, i) => (i === editIndex ? binding : existing));
          const ok = await submit(next, editIndex === null ? "Binding added" : "Binding saved");
          if (ok) setDialogIndex(null);
        }}
      />
    </>
  );
}

function ScopePicker({
  resource,
  selected,
  onChange,
}: {
  resource: Resource | undefined;
  selected: string[];
  onChange: (scopes: string[]) => void;
}) {
  if (!resource) return null;
  if (resource.scopes.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        This resource defines no scopes; the credential is minted without scope narrowing.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">Scopes</span>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {resource.scopes.map((scope) => {
          const checked = selected.includes(scope);
          return (
            <label key={scope} className="flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={checked}
                onChange={() =>
                  onChange(checked ? selected.filter((s) => s !== scope) : [...selected, scope])
                }
                className="h-4 w-4 flex-shrink-0 accent-primary"
              />
              <span className="font-mono text-xs text-foreground">{scope}</span>
            </label>
          );
        })}
      </div>
      <p className="text-[11px] text-muted-foreground">
        The credential is minted with only the selected scopes. Leave all unchecked to request the
        resource's full scope set.
      </p>
    </div>
  );
}

function BindingDialog({
  open,
  zoneId,
  bindings,
  editIndex,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  zoneId: string;
  bindings: WorkloadBinding[];
  editIndex: number | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (binding: WorkloadBinding, editIndex: number | null) => void;
}) {
  const resourcesQuery = useResources(zoneId);
  const providersQuery = useProviders(zoneId);
  const resources = useMemo(() => resourcesQuery.data ?? [], [resourcesQuery.data]);
  const providers = useMemo(() => providersQuery.data ?? [], [providersQuery.data]);

  const [step, setStep] = useState<"select" | "configure">("select");
  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");
  const [resource, setResource] = useState("");
  const [env, setEnv] = useState("");
  const [envTouched, setEnvTouched] = useState(false);
  const [scopes, setScopes] = useState<string[]>([]);
  const [behavior, setBehavior] = useState<BindingBehavior>("required");

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setProviderFilter("all");
    const editing = editIndex !== null ? bindings[editIndex] : undefined;
    if (editing) {
      setStep("configure");
      setResource(editing.resource);
      setEnv(editing.env);
      setEnvTouched(true);
      setScopes(editing.scopes ?? []);
      setBehavior(bindingBehavior(editing));
    } else {
      setStep("select");
      setResource("");
      setEnv("");
      setEnvTouched(false);
      setScopes([]);
      setBehavior("required");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const providersById = useMemo(() => {
    const map = new Map<string, string>();
    for (const provider of providers) map.set(provider.id, provider.name);
    return map;
  }, [providers]);

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const byProvider = new Map<string, { name: string; items: Resource[] }>();
    for (const item of resources) {
      if (providerFilter !== "all" && item.credential_provider_id !== providerFilter) continue;
      const providerName = item.credential_provider_id
        ? (providersById.get(item.credential_provider_id) ?? "Unknown provider")
        : "No credential provider";
      if (
        q &&
        !item.name.toLowerCase().includes(q) &&
        !item.identifier.toLowerCase().includes(q) &&
        !providerName.toLowerCase().includes(q)
      )
        continue;
      const key = item.credential_provider_id ?? "";
      const group = byProvider.get(key) ?? { name: providerName, items: [] };
      group.items.push(item);
      byProvider.set(key, group);
    }
    return [...byProvider.values()]
      .map((group) => ({
        ...group,
        items: [...group.items].sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [resources, providersById, providerFilter, search]);

  const selectedResource = resources.find((item) => item.identifier === resource);

  function choose(item: Resource) {
    if (item.identifier !== resource) setScopes([]);
    setResource(item.identifier);
    if (!envTouched) setEnv(suggestEnv(item.identifier));
    setStep("configure");
  }

  const trimmedEnv = env.trim();
  const duplicate = bindings.some((binding, i) => i !== editIndex && binding.env === trimmedEnv);
  const envError = !trimmedEnv
    ? undefined
    : !ENV_NAME.test(trimmedEnv)
      ? "Use letters, digits, and underscores; the name cannot start with a digit."
      : duplicate
        ? "Another binding already uses this variable name."
        : undefined;
  const valid = Boolean(trimmedEnv) && !envError && Boolean(resource);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editIndex !== null ? "Edit binding" : "Add binding"}
      description={
        step === "select"
          ? "Choose the resource this workload needs a credential for."
          : "Name the environment variable and narrow the credential's scope."
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {step === "configure" ? (
            <Button
              mutating
              loading={busy}
              disabled={!valid}
              onClick={() =>
                onSubmit(applyBehavior({ env: trimmedEnv, resource, scopes }, behavior), editIndex)
              }
            >
              {editIndex !== null ? "Save binding" : "Add binding"}
            </Button>
          ) : null}
        </>
      }
    >
      {step === "select" ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <SearchInput
              autoFocus
              placeholder="Search resources…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="min-w-0 flex-1"
            />
            {providers.length > 1 ? (
              <Select
                aria-label="Filter by provider"
                value={providerFilter}
                onChange={(e) => setProviderFilter(e.target.value)}
                className="w-44 flex-shrink-0"
              >
                <option value="all">All providers</option>
                {[...providers]
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                    </option>
                  ))}
              </Select>
            ) : null}
          </div>
          <div className="scrollbar-thin h-80 overflow-y-auto rounded-lg border border-border">
            {resourcesQuery.isLoading ? (
              <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                Loading resources…
              </p>
            ) : groups.length === 0 ? (
              <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                {resources.length === 0
                  ? "No resources in this zone yet. Create the resource first, then bind it here."
                  : "No resources match your search."}
              </p>
            ) : (
              groups.map((group) => (
                <div key={group.name}>
                  <div className="sticky top-0 z-10 border-b border-border bg-muted px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    {group.name}
                  </div>
                  {group.items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => choose(item)}
                      className="flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left outline-none transition-colors last:border-b-0 hover:bg-accent/40 focus-visible:bg-accent/40"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-foreground">
                          {item.name}
                        </div>
                        <div className="truncate font-mono text-[11px] text-muted-foreground">
                          {item.identifier}
                        </div>
                      </div>
                      <span className="flex-shrink-0 text-[11px] text-muted-foreground">
                        {item.scopes.length > 0
                          ? `${item.scopes.length} ${item.scopes.length === 1 ? "scope" : "scopes"}`
                          : "No scopes"}
                      </span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-foreground">
                {selectedResource?.name ?? resource}
              </div>
              <div className="truncate font-mono text-[11px] text-muted-foreground">{resource}</div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setStep("select")}>
              Change
            </Button>
          </div>
          <Field
            label="Environment variable"
            info="The variable name the workload reads its credential from. caracal run injects the minted credential under this exact name at launch."
            placeholder="CARACAL_RESOURCE_PIPERNET_TOKEN"
            className="font-mono text-xs"
            value={env}
            error={envError}
            onChange={(e) => {
              setEnv(e.target.value);
              setEnvTouched(true);
            }}
          />
          <ScopePicker resource={selectedResource} selected={scopes} onChange={setScopes} />
          <Select
            label="If unavailable"
            info="What happens at launch when this credential cannot be minted, for example when policy denies it or the provider is down."
            value={behavior}
            onChange={(e) => setBehavior(e.target.value as BindingBehavior)}
          >
            <option value="required">Fail the launch</option>
            <option value="optional_warn">Warn and launch without it</option>
            <option value="optional_error">Optional, but fail the launch</option>
          </Select>
        </div>
      )}
    </Modal>
  );
}

/* -------------------------------- launch -------------------------------- */

function LaunchSection({ workload }: { workload: Workload }) {
  return (
    <DetailSection title="Launch">
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-3">
        <CopyValue value={`export CARACAL_WORKLOAD_ID=${workload.id}`} />
        <CopyValue value="caracal run -- <your command>" />
        <p className="text-xs text-muted-foreground">
          <code className="font-mono">caracal run</code> authenticates with the workload secret from{" "}
          <code className="font-mono">CARACAL_WORKLOAD_SECRET</code> and injects each bound
          credential before your command starts.
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
      </div>
    </Modal>
  );
}
