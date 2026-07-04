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
  useCreateWorkload,
  useDeleteWorkload,
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
        <DetailField label="Created">{new Date(workload.created_at).toLocaleString()}</DetailField>
        {workload.updated_by ? (
          <DetailField label="Configured by">
            {workload.updated_by}
            {workload.updated_at ? ` · ${new Date(workload.updated_at).toLocaleString()}` : ""}
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

const EMPTY_BINDING: WorkloadBinding = { env: "", resource: "", scopes: [] };

function BindingsSection({ workload, zoneId }: { workload: Workload; zoneId: string }) {
  const toast = useToast();
  const updateWorkload = useUpdateWorkload(zoneId);
  const resourcesQuery = useResources(zoneId);

  const saved = workload.bindings;
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<WorkloadBinding[]>([]);

  useEffect(() => {
    setEditing(false);
  }, [workload.id]);

  function openEditor() {
    setRows(saved.length > 0 ? saved.map((binding) => ({ ...binding })) : [{ ...EMPTY_BINDING }]);
    setEditing(true);
  }

  function setRow(index: number, row: WorkloadBinding) {
    setRows((current) => current.map((existing, i) => (i === index ? row : existing)));
  }

  const incomplete = rows.some((row) => !row.env.trim() || !row.resource);
  const duplicateEnv = new Set(rows.map((row) => row.env.trim())).size !== rows.length;

  async function submit(bindings: WorkloadBinding[]) {
    try {
      await updateWorkload.mutateAsync({
        id: workload.id,
        input: { bindings: bindings.map((binding) => ({ ...binding, env: binding.env.trim() })) },
      });
      setEditing(false);
      toast({
        tone: "success",
        title: bindings.length > 0 ? "Bindings saved" : "Bindings cleared",
        description: workload.name,
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
            {saved.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                mutating
                loading={updateWorkload.isPending}
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
              loading={updateWorkload.isPending}
              disabled={rows.length === 0 || incomplete || duplicateEnv}
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
                  info="The variable name the workload reads its credential from. caracal run injects the minted credential under this exact name at launch."
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
                onChange={(e) => setRow(index, { ...row, resource: e.target.value, scopes: [] })}
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
              <ScopePicker
                resource={(resourcesQuery.data ?? []).find((r) => r.identifier === row.resource)}
                selected={row.scopes ?? []}
                onChange={(scopes) => setRow(index, { ...row, scopes })}
              />
              <Select
                label="If unavailable"
                info="What happens at launch when this credential cannot be minted, for example when policy denies it or the provider is down."
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
          ))}
          <div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setRows((current) => [...current, { ...EMPTY_BINDING }])}
            >
              Add binding
            </Button>
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

  if (saved.length === 0) {
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
          workload's environment. Once configured, the workload launches with only its ID and
          secret; the resources, scopes, and variable names all live here.
        </p>
      </DetailSection>
    );
  }

  return (
    <DetailSection
      title="Bindings"
      action={
        <Button variant="secondary" size="sm" mutating onClick={openEditor}>
          Edit bindings
        </Button>
      }
    >
      <dl className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {saved.map((binding) => (
          <div
            key={binding.env}
            className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5"
          >
            <div className="min-w-0">
              <div className="truncate font-mono text-xs text-foreground">{binding.env}</div>
              <div className="truncate font-mono text-[11px] text-muted-foreground">
                {binding.resource}
              </div>
            </div>
            <div className="flex flex-shrink-0 items-center gap-1.5">
              {(binding.scopes ?? []).map((scope) => (
                <Badge key={scope} tone="neutral">
                  {scope}
                </Badge>
              ))}
              {binding.optional ? <Badge tone="muted">Optional</Badge> : null}
            </div>
          </div>
        ))}
      </dl>
    </DetailSection>
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

/* -------------------------------- launch -------------------------------- */

function LaunchSection({ workload }: { workload: Workload }) {
  return (
    <DetailSection title="Launch">
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-3">
        <p className="text-xs font-medium text-foreground">Launch this workload</p>
        <CopyValue value={`export CARACAL_WORKLOAD_ID=${workload.id}`} />
        <CopyValue value="caracal run -- <your command>" />
        <p className="text-xs text-muted-foreground">
          Provide the workload secret via <code className="font-mono">CARACAL_WORKLOAD_SECRET</code>
          , <code className="font-mono">CARACAL_WORKLOAD_SECRET_FILE</code>, or the owner-only file
          at{" "}
          <code className="break-all font-mono">{`<Caracal config dir>/runtime/${workload.id}/secret`}</code>
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
          Creates the workload's identity and reveals its secret once. Bind the credentials it needs
          next, then launch it anywhere with <code className="font-mono">caracal run</code>.
        </p>
      </div>
    </Modal>
  );
}
