/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the zones management route.
*/
import { appLink } from "@/platform/nav/appLink";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { DcrField } from "@/components/console/DcrField";
import { ModulePage } from "@/components/console/ModulePage";
import {
  CopyValue,
  DangerZone,
  DetailField,
  DetailGroup,
  DetailHeader,
  DetailSection,
} from "@/components/console/ResourceWorkspace";
import {
  Badge,
  Button,
  DataTable,
  Drawer,
  EmptyState,
  Field,
  IdentityAvatar,
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
  useCreateZone,
  useDeleteZone,
  useUpdateZone,
  useZones,
} from "@/platform/api/hooks";
import { useSession } from "@/platform/auth";
import { getActiveZoneId } from "@/platform/state/localInstall";
import type { Zone, ZonePatchInput } from "@/platform/api/types";

const PAGE_SIZE = 8;

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/zones")({
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

// The control plane is the authority on live dynamic clients: a PATCH that disables DCR
// while clients are still live returns 409 dcr_shutdown_required with the live count under
// a FOR UPDATE lock. Reading it back lets the UI force an explicit keep/revoke decision even
// when the optimistic pre-check could not see the clients (status fetch failed or raced).
function liveDcrFromError(error: unknown): number | null {
  if (error instanceof ConsoleApiError && error.code === "dcr_shutdown_required") {
    const detail = error.detail as { live_dcr_applications?: unknown } | undefined;
    const count = detail?.live_dcr_applications;
    return typeof count === "number" ? count : 0;
  }
  return null;
}

function ZonesPage() {
  const toast = useToast();
  const session = useSession();
  const zonesQuery = useZones();
  const createZone = useCreateZone();
  const updateZone = useUpdateZone();
  const deleteZone = useDeleteZone();

  const owner = session.data?.user?.name || session.data?.user?.email || "You";

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState>({ column: "name", direction: "asc" });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [createOpen, setCreateOpen] = useState(false);
  const [detailTarget, setDetailTarget] = useState<Zone | null>(null);
  const [editTarget, setEditTarget] = useState<Zone | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Zone | null>(null);
  const [dcrShutdown, setDcrShutdown] = useState<{
    zone: Zone;
    input: ZonePatchInput;
    liveCount: number;
  } | null>(null);
  const activeId = getActiveZoneId();

  const zones = useMemo(() => zonesQuery.data ?? [], [zonesQuery.data]);

  useEffect(() => {
    setPage(1);
  }, [query, sort, pageSize]);

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
    () => visible.slice((page - 1) * pageSize, page * pageSize),
    [visible, page, pageSize],
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
      truncate: true,
      cell: (zone) => (
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-foreground">{zone.name}</span>
          {zone.id === activeId ? (
            <span className="flex-shrink-0">
              <Badge tone="success">Active</Badge>
            </span>
          ) : null}
        </div>
      ),
    },
    {
      id: "slug",
      header: "Slug",
      sortable: true,
      truncate: true,
      cell: (zone) => (
        <span className="block truncate font-mono text-xs text-muted-foreground">{zone.slug}</span>
      ),
    },
    {
      id: "owner",
      header: "Owner",
      truncate: true,
      cell: () => <span className="block truncate text-sm text-muted-foreground">{owner}</span>,
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
        <div
          className="flex justify-end gap-1"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
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

  if (zonesQuery.isLoading) {
    return (
      <ModulePage
        title="Zones"
        description="Zones are Caracal's primary trust boundary."
        breadcrumbs={[{ label: "Console", to: appLink() }, { label: "Zones" }]}
      >
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <SearchInput placeholder="Search zones…" disabled className="w-full sm:w-64" />
          <div className="ml-auto">
            <Button disabled aria-disabled>
              New zone
            </Button>
          </div>
        </div>
        <DataTable
          columns={columns}
          rows={[]}
          rowKey={(zone) => zone.id}
          loading
          skeletonRows={pageSize}
        />
        <div className="flex h-[49px] items-center justify-end gap-2 border-x border-b border-border bg-card px-4">
          <Skeleton className="h-4 w-40" />
        </div>
      </ModulePage>
    );
  }

  if (zonesQuery.isError) {
    return (
      <ModulePage
        title="Zones"
        description="Zones are Caracal's primary trust boundary."
        breadcrumbs={[{ label: "Console", to: appLink() }, { label: "Zones" }]}
      >
        <EmptyState
          title="Zones unavailable"
          description="The control plane did not respond, so zones could not be loaded. Check platform health in Diagnostics; this view recovers automatically once the control plane is reachable."
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button onClick={() => zonesQuery.refetch()} loading={zonesQuery.isFetching}>
                Retry
              </Button>
              <Link to={appLink("/diagnostics")}>
                <Button variant="secondary">Open Diagnostics</Button>
              </Link>
            </div>
          }
        />
      </ModulePage>
    );
  }

  return (
    <ModulePage
      title="Zones"
      description="Zones are Caracal's primary trust boundary. Each zone is owned by your account and isolates its own applications, resources, policies, and audit."
      breadcrumbs={[{ label: "Console", to: appLink() }, { label: "Zones" }]}
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SearchInput
          placeholder="Search zones…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={zones.length === 0}
          aria-label="Search zones"
          className="w-full sm:w-64"
        />
        <div className="ml-auto">
          <Button onClick={() => setCreateOpen(true)}>New zone</Button>
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={paged}
        rowKey={(zone) => zone.id}
        loading={zonesQuery.isLoading}
        skeletonRows={pageSize}
        sort={sort}
        onSortChange={toggleSort}
        onRowClick={(zone) => setDetailTarget(zone)}
        empty={
          <EmptyState
            bordered={false}
            title={query ? "No matching zones" : "No zones yet"}
            description={
              query
                ? "Try a different search term."
                : "Create your first zone to start managing applications, resources, and policies."
            }
          />
        }
      />

      {visible.length > 0 ? (
        <div className="border-x border-b border-border bg-card">
          <Pagination
            page={page}
            pageSize={pageSize}
            total={visible.length}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        </div>
      ) : null}

      <ZoneDetailDrawer
        zone={detailTarget}
        isActive={detailTarget?.id === activeId}
        owner={owner}
        onClose={() => setDetailTarget(null)}
        onSwitch={() => {
          if (!detailTarget) return;
          selectZone(detailTarget.id);
          toast({
            tone: "success",
            title: "Active zone switched",
            description: detailTarget.name,
          });
        }}
        onEdit={() => {
          setEditTarget(detailTarget);
          setDetailTarget(null);
        }}
        onDelete={() => {
          setDeleteTarget(detailTarget);
          setDetailTarget(null);
        }}
      />

      <ZoneFormModal
        open={createOpen}
        mode="create"
        busy={createZone.isPending}
        onClose={() => setCreateOpen(false)}
        onSubmit={async (values) => {
          try {
            const zone = await createZone.mutateAsync({
              name: values.name,
              // Omit the slug when the operator did not customise it so the control plane
              // auto-generates a unique one (matching the TUI, which never sends a slug on
              // create and relies on server-side dedup). An explicit slug is still honoured.
              slug: values.slug || undefined,
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
          // Disabling DCR on a zone that still has live dynamic clients forces an
          // explicit operator decision: keep them running through a drain window, or
          // revoke them now. Pre-check so the prompt appears before the write; if the
          // status is known to be zero, send keep_live so the backend skips the gate.
          // If the status is unknown (fetch failed/raced), do NOT assume zero, so send
          // without a shutdown choice and let the backend's authoritative 409 drive the
          // keep/revoke prompt, so live clients are never silently kept.
          if (editTarget.dcr_enabled && !values.dcrEnabled) {
            let liveCount: number | null = null;
            try {
              liveCount = (await consoleApi.zones.dcrStatus(editTarget.id)).live_dcr_applications;
            } catch {
              liveCount = null;
            }
            if (liveCount !== null && liveCount > 0) {
              setDcrShutdown({ zone: editTarget, input, liveCount });
              return;
            }
            if (liveCount === 0) input.dcr_shutdown = "keep_live";
          }
          try {
            await updateZone.mutateAsync({ id: editTarget.id, input });
            setEditTarget(null);
            toast({ tone: "success", title: "Zone updated", description: values.name });
          } catch (err) {
            const live = liveDcrFromError(err);
            if (live !== null) {
              setDcrShutdown({ zone: editTarget, input, liveCount: live });
              return;
            }
            toast({ tone: "error", title: "Update failed", description: errorMessage(err) });
          }
        }}
      />

      <DeleteZoneDialog
        zone={deleteTarget}
        isActive={deleteTarget?.id === activeId}
        busy={deleteZone.isPending}
        revoking={updateZone.isPending}
        onRevokeDcr={async () => {
          if (!deleteTarget) return;
          await updateZone.mutateAsync({
            id: deleteTarget.id,
            input: { dcr_enabled: false, dcr_shutdown: "revoke_live" },
          });
          toast({
            tone: "info",
            title: "Dynamic clients revoked",
            description: "Live DCR clients and their sessions were revoked.",
          });
        }}
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
      <DcrShutdownDialog
        request={dcrShutdown}
        busy={updateZone.isPending}
        onClose={() => setDcrShutdown(null)}
        onChoose={async (mode) => {
          if (!dcrShutdown) return;
          const input: ZonePatchInput = { ...dcrShutdown.input, dcr_shutdown: mode };
          try {
            await updateZone.mutateAsync({ id: dcrShutdown.zone.id, input });
            setDcrShutdown(null);
            setEditTarget(null);
            toast({
              tone: mode === "revoke_live" ? "info" : "success",
              title: "Zone updated",
              description:
                mode === "revoke_live" ? "Dynamic clients revoked." : "Dynamic clients kept live.",
            });
          } catch (err) {
            toast({ tone: "error", title: "Update failed", description: errorMessage(err) });
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
              onSubmit({
                name: name.trim(),
                slug: slugDirty ? effectiveSlug.trim() : "",
                dcrEnabled,
              })
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
          info="Human-readable name for this zone, shown across the console. A zone is your primary trust boundary, isolating its own applications, resources, policies, and audit."
          placeholder="Production"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        <Field
          label="Slug"
          info="Lowercase identifier used in URLs and tokens to reference this zone. Generated from the name; must be unique."
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

function useZoneDependencies(zone: Zone | null): {
  deps: Dependencies | null;
  loading: boolean;
  error: string | null;
} {
  const [deps, setDeps] = useState<Dependencies | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!zone) return;
    setDeps(null);
    setError(null);
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
          consoleApi.zones.dcrStatus(zone.id).catch(() => ({ live_dcr_applications: 0 })),
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
        if (!cancelled) setError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [zone]);

  return { deps, loading, error };
}

// The clickable zone detail panel, opened on Enter: identity, configuration, and a live
// inventory of what the zone contains, with the
// same switch/edit/delete actions surfaced inline.
function ZoneDetailDrawer({
  zone,
  isActive,
  owner,
  onClose,
  onSwitch,
  onEdit,
  onDelete,
}: {
  zone: Zone | null;
  isActive: boolean;
  owner: string;
  onClose: () => void;
  onSwitch: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { deps, loading, error } = useZoneDependencies(zone);

  const contents: { label: string; value: number; to: string }[] = deps
    ? [
        { label: "Applications", value: deps.applications, to: appLink("/applications") },
        { label: "Resources", value: deps.resources, to: appLink("/resources") },
        { label: "Providers", value: deps.providers, to: appLink("/providers") },
        { label: "Policies", value: deps.policies, to: appLink("/policies") },
        { label: "Policy sets", value: deps.policySets, to: appLink("/policy-sets") },
      ]
    : [];

  return (
    <Drawer
      open={zone !== null}
      onClose={onClose}
      title={zone?.name ?? ""}
      description={zone?.slug ?? undefined}
      icon={zone ? <IdentityAvatar seed={zone.id || zone.slug} size="lg" /> : undefined}
      width="max-w-lg"
    >
      {zone ? (
        <div className="flex flex-col gap-6">
          <DetailHeader
            action={
              <>
                {!isActive ? (
                  <Button variant="secondary" size="sm" onClick={onSwitch}>
                    Switch to
                  </Button>
                ) : null}
                <Button variant="secondary" size="sm" onClick={onEdit}>
                  Edit
                </Button>
              </>
            }
          >
            {isActive ? <Badge tone="success">Active</Badge> : null}
            {zone.dcr_enabled ? (
              <Badge tone="neutral">DCR enabled</Badge>
            ) : (
              <Badge tone="muted">DCR off</Badge>
            )}
          </DetailHeader>

          <DetailGroup title="Identity">
            <DetailField label="Name">{zone.name}</DetailField>
            <DetailField label="Slug">
              <CopyValue value={zone.slug} />
            </DetailField>
            <DetailField label="Zone ID">
              <CopyValue value={zone.id} />
            </DetailField>
            <DetailField label="Owner">{owner}</DetailField>
            <DetailField label="Created">{new Date(zone.created_at).toLocaleString()}</DetailField>
            {zone.updated_at && zone.updated_at !== zone.created_at ? (
              <DetailField label="Updated">
                {new Date(zone.updated_at).toLocaleString()}
              </DetailField>
            ) : null}
          </DetailGroup>

          <DetailSection title="Contents">
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner className="h-4 w-4" /> Loading inventory…
              </div>
            ) : error ? (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                Could not load contents: {error}
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3 [&>*]:bg-card">
                {contents.map((item) => (
                  <Link
                    key={item.label}
                    to={item.to}
                    onClick={onClose}
                    className="flex flex-col gap-1 px-3 py-2.5 transition-colors hover:bg-accent/50"
                  >
                    <span className="text-lg font-semibold tabular-nums text-foreground">
                      {item.value}
                    </span>
                    <span className="text-[11px] text-muted-foreground">{item.label}</span>
                  </Link>
                ))}
              </div>
            )}
            {deps && deps.liveDcr > 0 ? (
              <p className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                {deps.liveDcr} live dynamically-registered client{deps.liveDcr === 1 ? "" : "s"}{" "}
                currently authenticating in this zone.
              </p>
            ) : null}
          </DetailSection>

          <DangerZone
            description="Archive this zone and revoke access to everything it contains."
            actionLabel="Delete"
            onAction={onDelete}
          />
        </div>
      ) : null}
    </Drawer>
  );
}

function DeleteZoneDialog({
  zone,
  isActive,
  busy,
  revoking,
  onRevokeDcr,
  onClose,
  onConfirm,
}: {
  zone: Zone | null;
  isActive: boolean;
  busy: boolean;
  revoking: boolean;
  onRevokeDcr: () => Promise<void>;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [deps, setDeps] = useState<Dependencies | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [revokeError, setRevokeError] = useState<string | null>(null);

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
          // A zone can still hold live DCR clients even after DCR is switched off
          // (existing identities live until they expire), so always check the count.
          consoleApi.zones.dcrStatus(zone.id).catch(() => ({ live_dcr_applications: 0 })),
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
  }, [zone, reloadToken]);

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

  async function revokeNow() {
    setRevokeError(null);
    try {
      await onRevokeDcr();
      setReloadToken((n) => n + 1);
    } catch (err) {
      setRevokeError(errorMessage(err));
    }
  }

  return (
    <Modal
      open={zone !== null}
      onClose={onClose}
      title="Delete zone"
      description={`Deleting archives "${zone?.name ?? ""}" and removes console and admin-API access to everything it contains. This cannot be undone.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy || revoking}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={onConfirm}
            loading={busy}
            disabled={!confirmed || loading || revoking || loadError !== null}
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
                  : `Deleting will archive this zone and make ${total} object${total === 1 ? "" : "s"} inside it inaccessible:`}
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
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-3">
                <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
                  {deps.liveDcr} live dynamically-registered client
                  {deps.liveDcr === 1 ? "" : "s"} will keep authenticating until{" "}
                  {deps.liveDcr === 1 ? "it expires" : "they expire"}.
                </p>
                <p className="mt-1 text-xs text-amber-700/90 dark:text-amber-400/90">
                  Deleting the zone does not revoke them. To cut off access immediately, revoke them
                  first. This archives the identities and revokes their sessions and agents.
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-2"
                  onClick={revokeNow}
                  loading={revoking}
                  disabled={busy}
                >
                  Disable DCR &amp; revoke live clients
                </Button>
                {revokeError ? (
                  <p className="mt-2 text-xs text-destructive">Revoke failed: {revokeError}</p>
                ) : null}
              </div>
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

// Forces an explicit keep-or-revoke decision when DCR is turned off while dynamic
// clients are still live, surfacing the runtime impact of each path before it commits.
function DcrShutdownDialog({
  request,
  busy,
  onClose,
  onChoose,
}: {
  request: { zone: Zone; input: ZonePatchInput; liveCount: number } | null;
  busy: boolean;
  onClose: () => void;
  onChoose: (mode: "keep_live" | "revoke_live") => void | Promise<void>;
}) {
  if (!request) return null;
  const { zone, liveCount } = request;
  const plural = liveCount === 1 ? "" : "s";
  return (
    <Modal
      open={request !== null}
      onClose={onClose}
      title="Disable dynamic client registration"
      description={`"${zone.name}" has ${liveCount} live dynamic client${plural}. Choose what happens to them.`}
      footer={
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => onChoose("keep_live")}
          className="border border-border p-4 text-left transition-colors hover:border-foreground/40 disabled:opacity-60"
        >
          <div className="text-sm font-medium text-foreground">Keep existing clients live</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Blocks new registrations only. The {liveCount} live client{plural} keep working until
            they expire or are revoked later. Use this for a graceful drain window.
          </p>
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onChoose("revoke_live")}
          className="border border-destructive/40 p-4 text-left transition-colors hover:border-destructive disabled:opacity-60"
        >
          <div className="text-sm font-medium text-destructive">Revoke all live clients now</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Archives the {liveCount} dynamic identit{liveCount === 1 ? "y" : "ies"}, revokes their
            sessions, and terminates related ephemeral agents immediately. Use this to stop DCR
            access at once.
          </p>
        </button>
      </div>
    </Modal>
  );
}
