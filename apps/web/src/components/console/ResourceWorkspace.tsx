/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides the reusable list-and-detail workspace used by Console object pages.
*/
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { ModulePage } from "@/components/console/ModulePage";
import {
  Button,
  DataTable,
  Drawer,
  EmptyState,
  Pagination,
  SearchInput,
  Select,
  type Column,
  type Crumb,
  type SortState,
} from "@/components/ui";

export interface SortOption {
  id: string;
  label: string;
}

export interface WorkspaceEmpty {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function ResourceWorkspace<T>({
  title,
  description,
  breadcrumbs,
  primaryAction,
  rows,
  loading,
  columns,
  rowKey,
  search,
  sortOptions,
  initialSort,
  pageSize = 8,
  empty,
  detail,
  headerExtra,
}: {
  title: string;
  description: string;
  breadcrumbs: Crumb[];
  primaryAction?: { label: string; onClick: () => void };
  rows: T[];
  loading: boolean;
  columns: Column<T>[];
  rowKey: (row: T) => string;
  search: { placeholder: string; match: (row: T, query: string) => boolean };
  sortOptions?: SortOption[];
  initialSort?: SortState;
  pageSize?: number;
  empty: WorkspaceEmpty;
  detail?: {
    title: (row: T) => string;
    description?: (row: T) => string;
    render: (row: T) => ReactNode;
    width?: string;
  };
  headerExtra?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [sortChoice, setSortChoice] = useState(sortOptions?.[0]?.id ?? "");
  const [sort, setSort] = useState<SortState | undefined>(initialSort);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<T | null>(null);

  useEffect(() => {
    setPage(1);
  }, [query, sortChoice, sort]);

  const filtered = useMemo(() => {
    if (!query.trim()) return rows;
    return rows.filter((row) => search.match(row, query.toLowerCase()));
  }, [rows, query, search]);

  const paged = useMemo(
    () => filtered.slice((page - 1) * pageSize, page * pageSize),
    [filtered, page, pageSize],
  );

  function toggleSort(column: string) {
    setSort((prev) =>
      prev?.column === column
        ? { column, direction: prev.direction === "asc" ? "desc" : "asc" }
        : { column, direction: "asc" },
    );
  }

  const showToolbar = loading || rows.length > 0;

  return (
    <ModulePage
      title={title}
      description={description}
      breadcrumbs={breadcrumbs}
      actions={
        primaryAction ? (
          <Button onClick={primaryAction.onClick}>{primaryAction.label}</Button>
        ) : undefined
      }
    >
      {headerExtra ? <div className="mb-4">{headerExtra}</div> : null}

      {showToolbar ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <SearchInput
            placeholder={search.placeholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full sm:w-72"
          />
          {sortOptions && sortOptions.length > 0 ? (
            <div className="w-44">
              <Select
                value={sortChoice}
                onChange={(e) => setSortChoice(e.target.value)}
                aria-label="Sort by"
              >
                {sortOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
        </div>
      ) : null}

      <DataTable
        columns={columns}
        rows={paged}
        rowKey={rowKey}
        loading={loading}
        sort={sort}
        onSortChange={toggleSort}
        onRowClick={detail ? (row) => setSelected(row) : undefined}
        empty={
          <EmptyState
            title={query ? "No matches" : empty.title}
            description={query ? "Try a different search term." : empty.description}
            action={
              !query && empty.actionLabel && empty.onAction ? (
                <Button onClick={empty.onAction}>{empty.actionLabel}</Button>
              ) : undefined
            }
          />
        }
      />

      {!loading && filtered.length > 0 ? (
        <div className="mt-3 overflow-hidden rounded-lg border border-border bg-card">
          <Pagination
            page={page}
            pageSize={pageSize}
            total={filtered.length}
            onPageChange={setPage}
          />
        </div>
      ) : null}

      {detail ? (
        <Drawer
          open={selected !== null}
          onClose={() => setSelected(null)}
          title={selected ? detail.title(selected) : ""}
          description={selected && detail.description ? detail.description(selected) : undefined}
          width={detail.width}
        >
          {selected ? detail.render(selected) : null}
        </Drawer>
      ) : null}
    </ModulePage>
  );
}

/* ---- shared detail-panel building blocks for a consistent drawer layout ---- */

export function DetailField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-2.5">
      <dt className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm text-foreground">{children}</dd>
    </div>
  );
}

export function DetailGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-border pt-4 first:border-t-0 first:pt-0">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {title}
      </h3>
      <dl className="mt-1 divide-y divide-border">{children}</dl>
    </section>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs text-foreground">{children}</span>;
}
