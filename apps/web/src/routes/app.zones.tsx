/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the zones management route.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { ModulePage } from "@/components/console/ModulePage";
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  Field,
  Modal,
  Pagination,
  SearchInput,
  Select,
  Tabs,
  Textarea,
  Tooltip,
  useToast,
  type Column,
  type SortState,
} from "@/components/ui";
import {
  addZone,
  archiveZone,
  listZones,
  setActiveZoneId,
  type ZoneRecord,
} from "@/platform/state/localInstall";

const PAGE_SIZE = 8;

export const Route = createFileRoute("/app/zones")({
  component: ZonesPage,
});

function ZonesPage() {
  const toast = useToast();
  const [zones, setZones] = useState<ZoneRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("active");
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState("created");
  const [sort, setSort] = useState<SortState>({ column: "name", direction: "asc" });
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<ZoneRecord | null>(null);

  function refresh() {
    setZones(listZones());
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      refresh();
      setLoading(false);
    }, 450);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    setPage(1);
  }, [tab, query, sortBy, sort]);

  const counts = useMemo(
    () => ({
      active: zones.filter((z) => z.status === "active").length,
      archived: zones.filter((z) => z.status === "archived").length,
    }),
    [zones],
  );

  const visible = useMemo(() => {
    const status = tab === "archived" ? "archived" : "active";
    const filtered = zones
      .filter((zone) => zone.status === status)
      .filter((zone) => {
        if (!query.trim()) return true;
        const q = query.toLowerCase();
        return zone.name.toLowerCase().includes(q) || zone.slug.toLowerCase().includes(q);
      });

    const sorted = [...filtered].sort((a, b) => {
      const dir = sort.direction === "asc" ? 1 : -1;
      if (sort.column === "name") return a.name.localeCompare(b.name) * dir;
      if (sort.column === "slug") return a.slug.localeCompare(b.slug) * dir;
      return (Date.parse(a.createdAt) - Date.parse(b.createdAt)) * dir;
    });

    if (sortBy === "name") sorted.sort((a, b) => a.name.localeCompare(b.name));
    return sorted;
  }, [zones, tab, query, sort, sortBy]);

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

  const columns: Column<ZoneRecord>[] = [
    {
      id: "name",
      header: "Name",
      sortable: true,
      cell: (zone) => (
        <div>
          <div className="font-medium text-foreground">{zone.name}</div>
          {zone.description ? (
            <div className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
              {zone.description}
            </div>
          ) : null}
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
      id: "status",
      header: "Status",
      cell: (zone) =>
        zone.status === "active" ? (
          <Badge tone="success">Active</Badge>
        ) : (
          <Badge tone="muted">Archived</Badge>
        ),
    },
    {
      id: "created",
      header: "Created",
      sortable: true,
      cell: (zone) => (
        <span className="text-xs text-muted-foreground">
          {new Date(zone.createdAt).toLocaleDateString()}
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
          {zone.status === "active" ? (
            <>
              <Tooltip label="Make this the active zone">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setActiveZoneId(zone.id);
                    toast({
                      tone: "success",
                      title: "Active zone switched",
                      description: zone.name,
                    });
                  }}
                >
                  Switch
                </Button>
              </Tooltip>
              <Tooltip label="Archive this zone">
                <Button variant="ghost" size="sm" onClick={() => setArchiveTarget(zone)}>
                  Archive
                </Button>
              </Tooltip>
            </>
          ) : (
            <span className="px-2 text-xs text-muted-foreground">—</span>
          )}
        </div>
      ),
    },
  ];

  return (
    <ModulePage
      title="Zones"
      description="Zones are Caracal's primary trust boundary. Create, switch, configure, and archive them here."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Zones" }]}
      actions={<Button onClick={() => setCreateOpen(true)}>New zone</Button>}
    >
      <div className="mb-4">
        <Tabs
          tabs={[
            { id: "active", label: "Active", count: counts.active },
            { id: "archived", label: "Archived", count: counts.archived },
          ]}
          active={tab}
          onChange={setTab}
        />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SearchInput
          placeholder="Search zones…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full sm:w-64"
        />
        <div className="w-40">
          <Select value={sortBy} onChange={(e) => setSortBy(e.target.value)} aria-label="Sort by">
            <option value="created">Newest first</option>
            <option value="name">Name</option>
          </Select>
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={paged}
        rowKey={(zone) => zone.id}
        loading={loading}
        sort={sort}
        onSortChange={toggleSort}
        empty={
          <EmptyState
            title={
              query
                ? "No matching zones"
                : tab === "archived"
                  ? "No archived zones"
                  : "No zones yet"
            }
            description={
              query
                ? "Try a different search term."
                : tab === "archived"
                  ? "Archived zones will appear here."
                  : "Create your first zone to start managing applications, resources, and policies."
            }
            action={
              !query && tab === "active" ? (
                <Button onClick={() => setCreateOpen(true)}>Create zone</Button>
              ) : undefined
            }
          />
        }
      />

      {!loading && visible.length > 0 ? (
        <div className="mt-3 overflow-hidden rounded-lg border border-border bg-card">
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={visible.length}
            onPageChange={setPage}
          />
        </div>
      ) : null}

      <CreateZoneModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(name) => {
          refresh();
          toast({ tone: "success", title: "Zone created", description: name });
        }}
      />

      <ConfirmDialog
        open={archiveTarget !== null}
        onClose={() => setArchiveTarget(null)}
        title="Archive zone"
        description={`Archiving "${archiveTarget?.name ?? ""}" hides it from active operations. You can still view it under the Archived tab.`}
        confirmLabel="Archive zone"
        tone="danger"
        onConfirm={() => {
          if (!archiveTarget) return;
          archiveZone(archiveTarget.id);
          refresh();
          toast({ tone: "info", title: "Zone archived", description: archiveTarget.name });
        }}
      />
    </ModulePage>
  );
}

function CreateZoneModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
    }
  }, [open]);

  function submit() {
    if (!name.trim()) return;
    setBusy(true);
    addZone({ name: name.trim(), description: description.trim() });
    setBusy(false);
    onCreated(name.trim());
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create zone"
      description="A zone isolates applications, resources, policies, and audit."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={!name.trim()}>
            Create zone
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
        <Textarea
          label="Description"
          placeholder="Live workloads and production agents."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
    </Modal>
  );
}
