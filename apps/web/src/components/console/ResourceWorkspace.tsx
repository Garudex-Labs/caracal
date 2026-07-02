/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides the reusable list-and-detail workspace used by Console object pages.
*/
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useSearch } from "@tanstack/react-router";

import { ModulePage } from "@/components/console/ModulePage";
import {
  Button,
  DataTable,
  Drawer,
  EmptyState,
  FilterMenu,
  Pagination,
  SearchInput,
  Select,
  Skeleton,
  useCopyToClipboard,
  type Column,
  type Crumb,
  type FilterGroup,
  type SortState,
} from "@/components/ui";
import { cx } from "@/lib/cx";

export interface SortOption {
  id: string;
  label: string;
}

export interface WorkspaceEmpty {
  title: string;
  description: string;
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
  filters,
  sortOptions,
  sortComparators,
  sortValues,
  initialSort,
  pageSize = 8,
  empty,
  detail,
  headerExtra,
  toolbarExtra,
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
  // Single-select filter groups rendered as one uniform funnel dropdown in the toolbar.
  // Filtering itself is applied by the caller (the rows passed in are already filtered);
  // this only renders the shared control and reports selections via each group's onChange.
  filters?: FilterGroup[];
  sortOptions?: SortOption[];
  // Comparator per sort option id. When provided, the selected dropdown option orders the
  // rows; without it the sort dropdown is inert (legacy behavior preserved for callers that
  // do not pass comparators).
  sortComparators?: Record<string, (a: T, b: T) => number>;
  // Value accessor per sortable column id. When provided, clicking that column header sorts
  // the rows by the returned value and toggles direction, so column-header sorting is real
  // rather than a cosmetic glyph. Takes precedence over the dropdown while a column is active.
  sortValues?: Partial<Record<string, (row: T) => string | number>>;
  initialSort?: SortState;
  pageSize?: number;
  empty: WorkspaceEmpty;
  detail?: {
    title: (row: T) => string;
    description?: (row: T) => string;
    render: (row: T) => ReactNode;
    width?: string;
    // Optional custom leading icon for the drawer header. Defaults to an initials monogram.
    icon?: (row: T) => ReactNode;
  };
  headerExtra?: ReactNode;
  // Inline controls rendered in the toolbar (search) row itself, after the filter/sort
  // controls and before any right-aligned primary action. Use for page-specific compact
  // controls that belong on the same line as search rather than in a separate block.
  toolbarExtra?: ReactNode;
}) {
  // A citation or guided link can arrive with ?focus=<slug>, which pre-fills the search so
  // the page opens narrowed to the exact item the operator was sent to.
  const focusParam = useSearch({ strict: false }) as { focus?: string };
  const initialFocus = typeof focusParam.focus === "string" ? focusParam.focus : "";
  const [query, setQuery] = useState(initialFocus);
  const [sortChoice, setSortChoice] = useState(sortOptions?.[0]?.id ?? "");
  const [sort, setSort] = useState<SortState | undefined>(initialSort);
  const [page, setPage] = useState(1);
  const [pageSizeValue, setPageSizeValue] = useState(pageSize);
  const [selected, setSelected] = useState<T | null>(null);

  useEffect(() => {
    setPage(1);
  }, [query, sortChoice, sort, pageSizeValue]);

  // When the selected row leaves the dataset (e.g. it was deleted), close the detail drawer
  // so it never lingers on a stale item.
  useEffect(() => {
    if (selected === null) return;
    const key = rowKey(selected);
    if (!rows.some((row) => rowKey(row) === key)) setSelected(null);
  }, [rows, selected, rowKey]);

  const filtered = useMemo(() => {
    if (!query.trim()) return rows;
    return rows.filter((row) => search.match(row, query.toLowerCase()));
  }, [rows, query, search]);

  // When a focus link narrows the list to a single item, open its detail once so the page
  // lands the reader directly on the cited item rather than just its filtered row.
  const focusOpened = useRef(false);
  useEffect(() => {
    if (focusOpened.current || !initialFocus || loading || !detail) return;
    if (filtered.length === 1) {
      setSelected(filtered[0]);
      focusOpened.current = true;
    }
  }, [initialFocus, loading, detail, filtered]);

  const sorted = useMemo(() => {
    const accessor = sort ? sortValues?.[sort.column] : undefined;
    if (sort && accessor) {
      const dir = sort.direction === "asc" ? 1 : -1;
      return [...filtered].sort((a, b) => {
        const av = accessor(a);
        const bv = accessor(b);
        if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
        return String(av).localeCompare(String(bv)) * dir;
      });
    }
    const comparator = sortComparators?.[sortChoice];
    if (!comparator) return filtered;
    return [...filtered].sort(comparator);
  }, [filtered, sort, sortValues, sortComparators, sortChoice]);

  const paged = useMemo(
    () => sorted.slice((page - 1) * pageSizeValue, page * pageSizeValue),
    [sorted, page, pageSizeValue],
  );

  function toggleSort(column: string) {
    setSort((prev) =>
      prev?.column === column
        ? { column, direction: prev.direction === "asc" ? "desc" : "asc" }
        : { column, direction: "asc" },
    );
  }

  // A filter group is "active" when it has moved off its default (first) option. We track
  // this so a filter that excludes everything does not get mistaken for an empty dataset.
  const filtersActive = (filters ?? []).some(
    (group) => group.value !== (group.options[0]?.id ?? ""),
  );
  const searchActive = query.trim().length > 0;

  // The toolbar is always present so the page frame never reflows between empty, loading,
  // and populated states. Controls lock only when there is genuinely nothing to act on:
  // loading, or no data at all. When the visible rows are empty *because* a search or filter
  // excluded them, the controls stay enabled so the operator can always change or clear them
  // and recover - they are never trapped by their own selection.
  const controlsLocked = loading || (rows.length === 0 && !filtersActive && !searchActive);

  const noMatches = (searchActive || filtersActive) && paged.length === 0;

  return (
    <ModulePage title={title} description={description} breadcrumbs={breadcrumbs}>
      {headerExtra ? <div className="mb-4">{headerExtra}</div> : null}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SearchInput
          placeholder={search.placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={controlsLocked}
          aria-label={search.placeholder}
          className="w-full sm:w-72"
        />
        {filters && filters.length > 0 && !controlsLocked ? <FilterMenu groups={filters} /> : null}
        {toolbarExtra ?? null}
        {sortOptions && sortOptions.length > 0 ? (
          <div className="w-44">
            <Select
              value={sortChoice}
              onChange={(e) => setSortChoice(e.target.value)}
              disabled={controlsLocked}
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
        {primaryAction ? (
          <div className="ml-auto">
            <Button onClick={primaryAction.onClick} mutating>
              {primaryAction.label}
            </Button>
          </div>
        ) : null}
      </div>

      <DataTable
        columns={columns}
        rows={paged}
        rowKey={rowKey}
        loading={loading}
        skeletonRows={pageSizeValue}
        sort={sort}
        onSortChange={toggleSort}
        onRowClick={detail ? (row) => setSelected(row) : undefined}
        empty={
          <EmptyState
            bordered={false}
            title={noMatches ? "No matches" : empty.title}
            description={
              noMatches
                ? "No items match the current search and filters. Adjust or clear them to see more."
                : empty.description
            }
            action={
              noMatches ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setQuery("");
                    for (const group of filters ?? []) {
                      const first = group.options[0]?.id;
                      if (first !== undefined && group.value !== first) group.onChange(first);
                    }
                  }}
                >
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        }
      />

      {loading ? (
        <div className="flex h-[49px] items-center justify-end gap-2 border-x border-b border-border bg-card px-4">
          <Skeleton className="h-4 w-40" />
        </div>
      ) : filtered.length > 0 ? (
        <div className="border-x border-b border-border bg-card">
          <Pagination
            page={page}
            pageSize={pageSizeValue}
            total={filtered.length}
            onPageChange={setPage}
            onPageSizeChange={setPageSizeValue}
          />
        </div>
      ) : null}

      {detail ? (
        <Drawer
          open={selected !== null}
          onClose={() => setSelected(null)}
          title={selected ? detail.title(selected) : ""}
          description={selected && detail.description ? detail.description(selected) : undefined}
          icon={
            selected
              ? (detail.icon?.(selected) ?? <Monogram label={detail.title(selected)} />)
              : undefined
          }
          width={detail.width}
        >
          {selected ? detail.render(selected) : null}
        </Drawer>
      ) : null}
    </ModulePage>
  );
}

/* ---- shared detail-panel building blocks for a consistent drawer layout ---- */

// A square monogram derived from an object's name, used as the leading icon in detail
// drawers so every panel opens with a consistent visual anchor.
export function Monogram({ label }: { label: string }) {
  const initials =
    label
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0]?.toUpperCase() ?? "")
      .join("") || "•";
  return (
    <span className="grid h-9 w-9 place-items-center rounded-md border border-border bg-muted text-xs font-semibold text-muted-foreground">
      {initials}
    </span>
  );
}

// A hero row pinned to the top of a detail panel: status badges on the left, primary
// actions (e.g. Edit) pushed to the right. The badges and the action live in separate groups
// so a long row of badges wraps on its own without ever colliding with the action button.
export function DetailHeader({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border pb-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
      {action ? <div className="flex flex-shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}

// A titled section with an optional trailing action, so every panel groups content the same
// way. Sections are separated by the panel's container gap, not ad-hoc top borders.
export function DetailSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex min-h-7 items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {title}
        </h3>
        {action ?? null}
      </div>
      {children}
    </section>
  );
}

// A bordered key/value card. Each DetailField is a responsive two-column row so labels and
// values align cleanly and use the full panel width.
export function DetailGroup({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <DetailSection title={title} action={action}>
      <dl className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {children}
      </dl>
    </DetailSection>
  );
}

export function DetailField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 px-3 py-2.5 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-xs font-medium text-muted-foreground sm:pt-px">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-foreground">{children}</dd>
    </div>
  );
}

// A consistent destructive footer block for irreversible actions across every detail panel.
export function DangerZone({
  description,
  actionLabel,
  onAction,
}: {
  description: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <DetailSection title="Danger zone">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-3">
        <p className="min-w-0 text-xs text-muted-foreground">{description}</p>
        <Button variant="danger" size="sm" mutating onClick={onAction} className="flex-shrink-0">
          {actionLabel}
        </Button>
      </div>
    </DetailSection>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="break-all font-mono text-xs text-foreground">{children}</span>;
}

// An inline value with a copy affordance, for identifiers and other reference strings that
// operators routinely copy out of a detail panel. The value sits in a subtle field and the
// copy button is a clearly bordered control that never overlaps the text.
export function CopyValue({ value, mono = true }: { value: string; mono?: boolean }) {
  const copy = useCopyToClipboard();
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex min-w-0 max-w-full items-stretch gap-1.5">
      <span
        className={cx(
          "min-w-0 flex-1 self-center break-all",
          mono ? "font-mono text-xs text-foreground" : "break-words text-sm text-foreground",
        )}
      >
        {value}
      </span>
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy"}
        title={copied ? "Copied" : "Copy"}
        onClick={() =>
          void copy(value, {
            onSuccess: () => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            },
          })
        }
        className={cx(
          "grid h-6 w-6 flex-shrink-0 place-items-center self-start rounded border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
          copied
            ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
            : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        {copied ? (
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15V5a2 2 0 0 1 2-2h10" />
          </svg>
        )}
      </button>
    </span>
  );
}
