/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the zones management route.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { DcrField } from "@/components/console/DcrField";
import { ModulePage } from "@/components/console/ModulePage";
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  Field,
  Modal,
  Pagination,
  SearchInput,
  Skeleton,
  Spinner,
  Tooltip,
  useToast,
  type Column,
  type SortState,
} from "@/components/ui";
import { ConsoleApiError, consoleApi } from "@/platform/api/client";
import {
  selectZone,
  useConsoleStatus,
  useCreateZone,
  useDeleteZone,
  useUpdateZone,
  useZones,
} from "@/platform/api/hooks";
import { useSession } from "@/platform/auth";
import { getActiveZoneId } from "@/platform/state/localInstall";
import type { Zone, ZonePatchInput } from "@/platform/api/types";

const PAGE_SIZE = 8;

export const Route = createFileRoute("/app/zones")({
  component: ZonesPage,
});

function errorMessage(error: unknown): string {
  if (error instanceof ConsoleApiError) {
    if (error.notConfigured) return "Control plane not connected.";
    if (error.unreachable) return "Control plane unreachable.";
    if (error.code === "zone_slug_conflict") return "That slug is already taken.";
    return error.code;
  }
  return "Unexpected error.";
}

function ZonesPage() {
  const toast = useToast();
  const session = useSession();
  const status = useConsoleStatus();
  const zonesQuery = useZones();
  const createZone = useCreateZone();
  const updateZone = useUpdateZone();
  const deleteZone = useDeleteZone();

  const owner = session.data?.user?.name || session.data?.user?.email || "You";

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState>({ column: "name", direction: "asc" });
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Zone | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Zone | null>(null);
  const activeId = getActiveZoneId();

  const zones = useMemo(() => zonesQuery.data ?? [], [zonesQuery.data]);

  useEffect(() => {
    setPage(1);
  }, [query, sort]);

  const visible = useMemo(() => {
    const filtered = zones.filter((zone) => {
      if (!query.trim()) return true;
      const q = query.toLowerCase();
      return zone.name.toLowerCase().includes(q) || zone.slug.toLowerCase().includes(q);
    });
    const dir = sort.direction === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sort.column === "slug") return a.slug.localeCompare(b.slug) * dir;
      if (sort.column === "created")
        return (Date.parse(a.created_at) - Date.parse(b.created_at)) * dir;
      return a.name.localeCompare(b.name) * dir;
    });
  }, [zones, query, sort]);

  const paged = useMemo(
    () => visible.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [visible, page],
  );

  function toggleSort(column: string) {
    setSort((prev) =>
      prev.column === column
        ? { column, direction: prev.direction === "asc" ? "desc" : "asc" }
        : { column, direction: "asc" },
    );
  }

  const columns: Column<Zone>[] = [
    {
      id: "name",
      header: "Name",
      sortable: true,
      cell: (zone) => (
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">{zone.name}</span>
          {zone.id === activeId ? <Badge tone="success">Active</Badge> : null}
        </div>
      ),
    },
    {
      id: "slug",
      header: "Slug",
      sortable: true,
      cell: (zone) => <span className="font-mono text-xs text-muted-foreground">{zone.slug}</span>,
    },
    {
      id: "owner",
      header: "Owner",
      cell: () => <span className="text-sm text-muted-foreground">{owner}</span>,
    },
    {
      id: "dcr",
      header: "DCR",
      cell: (zone) =>
        zone.dcr_enabled ? <Badge tone="neutral">Enabled</Badge> : <Badge tone="muted">Off</Badge>,
    },
    {
      id: "created",
      header: "Created",
      sortable: true,
      cell: (zone) => (
        <span className="text-xs text-muted-foreground">
          {new Date(zone.created_at).toLocaleDateString()}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      align: "right",
      width: "1%",
      cell: (zone) => (
        <div className="flex justify-end gap-1">
          <Tooltip label="Make this the active zone">
            <Button
              variant="ghost"
              size="sm"
              disabled={zone.id === activeId}
              onClick={() => {
                selectZone(zone.id);
                toast({ tone: "success", title: "Active zone switched", description: zone.name });
              }}
            >
              Switch
            </Button>
          </Tooltip>
          <Tooltip label="Edit this zone">
            <Button variant="ghost" size="sm" onClick={() => setEditTarget(zone)}>
              Edit
            </Button>
          </Tooltip>
          <Tooltip label="Delete this zone">
            <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(zone)}>
              Delete
            </Button>
          </Tooltip>
        </div>
      ),
    },
  ];

  if (status.isLoading) {
    return (
      <ModulePage
        title="Zones"
        description="Zones are Caracal's primary trust boundary."
        breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Zones" }]}
      >
        <div className="flex flex-col gap-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      </ModulePage>
    );
  }

  const disconnected = status.isError || !status.data?.configured || !status.data?.reachable;
  if (disconnected) {
    const title = !status.data?.configured
      ? "Control plane not connected"
      : "Control plane unreachable";
    const description = !status.data?.configured
      ? "No admin credentials were found. Start the local stack with `caracal up` to provision the control plane, then reload."
      : `The control plane at ${status.data?.apiUrl ?? ""} is not responding. Confirm it is running, then retry.`;
    return (
      <ModulePage
        title="Zones"
        description="Zones are Caracal's primary trust boundary."
        breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Zones" }]}
      >
        <EmptyState
          title={title}
          description={description}
          action={<Button onClick={() => status.refetch()}>Retry</Button>}
        />
      </ModulePage>
    );
  }

  return (
    <ModulePage
      title="Zones"
      description="Zones are Caracal's primary trust boundary. Each zone is owned by your account and isolates its own applications, resources, policies, and audit."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Zones" }]}
      actions={<Button onClick={() => setCreateOpen(true)}>New zone</Button>}
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SearchInput
          placeholder="Search zones…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full sm:w-64"
        />
      </div>

      <DataTable
        columns={columns}
        rows={paged}
        rowKey={(zone) => zone.id}
        loading={zonesQuery.isLoading}
        sort={sort}
        onSortChange={toggleSort}
        empty={
          <EmptyState
            title={
              zonesQuery.isError
                ? "Could not load zones"
                : query
                  ? "No matching zones"
                  : "No zones yet"
            }
            description={
              zonesQuery.isError
                ? errorMessage(zonesQuery.error)
                : query
                  ? "Try a different search term."
                  : "Create your first zone to start managing applications, resources, and policies."
            }
            action={
              !query && !zonesQuery.isError ? (
                <Button onClick={() => setCreateOpen(true)}>Create zone</Button>
              ) : undefined
            }
          />
        }
      />

      {!zonesQuery.isLoading && visible.length > 0 ? (
        <div className="mt-3 overflow-hidden rounded-lg border border-border bg-card">
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={visible.length}
            onPageChange={setPage}
          />
        </div>
      ) : null}

      <ZoneFormModal
        open={createOpen}
        mode="create"
        busy={createZone.isPending}
        onClose={() => setCreateOpen(false)}
        onSubmit={async (values) => {
          try {
            const zone = await createZone.mutateAsync({
              name: values.name,
              slug: values.slug,
              dcr_enabled: values.dcrEnabled,
            });
            setCreateOpen(false);
            toast({ tone: "success", title: "Zone created", description: zone.name });
          } catch (err) {
            toast({ tone: "error", title: "Create failed", description: errorMessage(err) });
          }
        }}
      />

      <ZoneFormModal
        open={editTarget !== null}
        mode="edit"
        zone={editTarget ?? undefined}
        busy={updateZone.isPending}
        onClose={() => setEditTarget(null)}
        onSubmit={async (values) => {
          if (!editTarget) return;
          const input: ZonePatchInput = {
            name: values.name,
            slug: values.slug,
            dcr_enabled: values.dcrEnabled,
          };
          // Disabling DCR on a zone with live dynamic clients keeps them running
          // rather than silently revoking runtime sessions.
          if (editTarget.dcr_enabled && !values.dcrEnabled) {
            input.dcr_shutdown = "keep_live";
          }
          try {
            await updateZone.mutateAsync({ id: editTarget.id, input });
            setEditTarget(null);
            toast({ tone: "success", title: "Zone updated", description: values.name });
          } catch (err) {
            toast({ tone: "error", title: "Update failed", description: errorMessage(err) });
          }
        }}
      />

      <DeleteZoneDialog
        zone={deleteTarget}
        isActive={deleteTarget?.id === activeId}
        busy={deleteZone.isPending}
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await deleteZone.mutateAsync(deleteTarget.id);
            if (deleteTarget.id === activeId) {
              const next = zones.find((z) => z.id !== deleteTarget.id);
              if (next) selectZone(next.id);
            }
            setDeleteTarget(null);
            toast({ tone: "info", title: "Zone deleted", description: deleteTarget.name });
          } catch (err) {
            toast({ tone: "error", title: "Delete failed", description: errorMessage(err) });
          }
        }}
      />
    </ModulePage>
  );
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function ZoneFormModal({
  open,
  mode,
  zone,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  mode: "create" | "edit";
  zone?: Zone;
  busy: boolean;
  onClose: () => void;
  onSubmit: (values: { name: string; slug: string; dcrEnabled: boolean }) => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugDirty, setSlugDirty] = useState(false);
  const [dcrEnabled, setDcrEnabled] = useState(false);

  useEffect(() => {
    if (open) {
      setName(zone?.name ?? "");
      setSlug(zone?.slug ?? "");
      setSlugDirty(mode === "edit");
      setDcrEnabled(zone?.dcr_enabled ?? false);
    }
  }, [open, zone, mode]);

  const effectiveSlug = slugDirty ? slug : slugify(name);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === "create" ? "Create zone" : "Edit zone"}
      description="A zone isolates applications, resources, policies, and audit."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              name.trim() &&
              onSubmit({ name: name.trim(), slug: effectiveSlug.trim(), dcrEnabled })
            }
            loading={busy}
            disabled={!name.trim() || !effectiveSlug.trim()}
          >
            {mode === "create" ? "Create zone" : "Save changes"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Zone name"
          placeholder="Production"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        <Field
          label="Slug"
          hint="Lowercase identifier used in URLs and tokens."
          placeholder="production"
          value={effectiveSlug}
          onChange={(e) => {
            setSlugDirty(true);
            setSlug(slugify(e.target.value));
          }}
        />
        <DcrField enabled={dcrEnabled} onChange={setDcrEnabled} />
      </div>
    </Modal>
  );
}

interface Dependencies {
  applications: number;
  resources: number;
  providers: number;
  policies: number;
  policySets: number;
  liveDcr: number;
}

function DeleteZoneDialog({
  zone,
  isActive,
  busy,
  onClose,
  onConfirm,
}: {
  zone: Zone | null;
  isActive: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [deps, setDeps] = useState<Dependencies | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");

  useEffect(() => {
    if (!zone) return;
    setDeps(null);
    setConfirmText("");
    setLoadError(null);
    setLoading(true);
    let cancelled = false;
    (async () => {
      try {
        const [applications, resources, providers, policies, policySets, dcr] = await Promise.all([
          consoleApi.applications.list(zone.id),
          consoleApi.resources.list(zone.id),
          consoleApi.providers.list(zone.id),
          consoleApi.policies.list(zone.id),
          consoleApi.policySets.list(zone.id),
          zone.dcr_enabled
            ? consoleApi.zones.dcrStatus(zone.id)
            : Promise.resolve({ live_dcr_applications: 0 }),
        ]);
        if (cancelled) return;
        setDeps({
          applications: applications.length,
          resources: resources.length,
          providers: providers.length,
          policies: policies.length,
          policySets: policySets.length,
          liveDcr: dcr.live_dcr_applications ?? 0,
        });
      } catch (err) {
        if (!cancelled) setLoadError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [zone]);

  const total = deps
    ? deps.applications + deps.resources + deps.providers + deps.policies + deps.policySets
    : 0;
  const confirmed = confirmText.trim() === zone?.name;

  const rows: { label: string; value: number }[] = deps
    ? [
        { label: "Applications", value: deps.applications },
        { label: "Resources", value: deps.resources },
        { label: "Providers", value: deps.providers },
        { label: "Policies", value: deps.policies },
        { label: "Policy sets", value: deps.policySets },
      ]
    : [];

  return (
    <Modal
      open={zone !== null}
      onClose={onClose}
      title="Delete zone"
      description={`This permanently deletes "${zone?.name ?? ""}" and everything inside it. This cannot be undone.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={onConfirm}
            loading={busy}
            disabled={!confirmed || loading || loadError !== null}
          >
            Delete zone
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Checking dependencies…
          </div>
        ) : loadError ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            Could not load dependencies: {loadError}
          </p>
        ) : deps ? (
          <>
            <div>
              <p className="text-sm text-foreground">
                {total === 0
                  ? "This zone has no dependent objects."
                  : `This will permanently remove ${total} object${total === 1 ? "" : "s"} in this zone:`}
              </p>
              {total > 0 ? (
                <ul className="mt-2 divide-y divide-border rounded-md border border-border">
                  {rows
                    .filter((r) => r.value > 0)
                    .map((r) => (
                      <li
                        key={r.label}
                        className="flex items-center justify-between px-3 py-2 text-sm"
                      >
                        <span className="text-muted-foreground">{r.label}</span>
                        <span className="font-medium text-foreground">{r.value}</span>
                      </li>
                    ))}
                </ul>
              ) : null}
            </div>

            {deps.liveDcr > 0 ? (
              <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                {deps.liveDcr} live dynamically-registered client
                {deps.liveDcr === 1 ? "" : "s"} will be revoked along with their runtime sessions.
              </p>
            ) : null}

            {isActive ? (
              <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                This is your active zone. Another zone will become active after deletion.
              </p>
            ) : null}

            <Field
              label={`Type "${zone?.name ?? ""}" to confirm`}
              placeholder={zone?.name ?? ""}
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              autoFocus
            />
          </>
        ) : null}
      </div>
    </Modal>
  );
}
