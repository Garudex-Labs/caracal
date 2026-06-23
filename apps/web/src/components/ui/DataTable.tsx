/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides the sortable, loading-aware data table for the Console UI.
*/
import type { ReactNode } from "react";

import { cx } from "@/lib/cx";
import { Skeleton } from "./Primitives";

export type SortDirection = "asc" | "desc";

export interface Column<T> {
  id: string;
  header: string;
  sortable?: boolean;
  align?: "left" | "right";
  width?: string;
  cell: (row: T) => ReactNode;
}

export interface SortState {
  column: string;
  direction: SortDirection;
}

function SortGlyph({ active, direction }: { active: boolean; direction: SortDirection }) {
  return (
    <span
      className={cx(
        "inline-flex flex-col leading-none",
        active ? "text-foreground" : "text-muted-foreground/40",
      )}
    >
      <svg
        width="8"
        height="8"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        className={cx(
          active && direction === "asc" ? "text-foreground" : "text-muted-foreground/40",
        )}
      >
        <path d="m6 15 6-6 6 6" />
      </svg>
    </span>
  );
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  skeletonRows = 5,
  sort,
  onSortChange,
  empty,
  onRowClick,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  skeletonRows?: number;
  sort?: SortState;
  onSortChange?: (column: string) => void;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="scrollbar-thin overflow-x-auto">
        <table className="w-full min-w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left">
              {columns.map((col) => {
                const active = sort?.column === col.id;
                return (
                  <th
                    key={col.id}
                    style={col.width ? { width: col.width } : undefined}
                    className={cx(
                      "px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground",
                      col.align === "right" && "text-right",
                    )}
                  >
                    {col.sortable && onSortChange ? (
                      <button
                        onClick={() => onSortChange(col.id)}
                        className={cx(
                          "inline-flex items-center gap-1 outline-none transition-colors hover:text-foreground",
                          col.align === "right" && "flex-row-reverse",
                        )}
                      >
                        {col.header}
                        <SortGlyph active={Boolean(active)} direction={sort?.direction ?? "asc"} />
                      </button>
                    ) : (
                      col.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading
              ? Array.from({ length: skeletonRows }).map((_, rowIndex) => (
                  <tr key={`skeleton-${rowIndex}`}>
                    {columns.map((col) => (
                      <td key={col.id} className="px-4 py-3">
                        <Skeleton className="h-4 w-full max-w-[160px]" />
                      </td>
                    ))}
                  </tr>
                ))
              : rows.map((row) => (
                  <tr
                    key={rowKey(row)}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className={cx(
                      "transition-colors",
                      onRowClick && "cursor-pointer hover:bg-accent/50",
                    )}
                  >
                    {columns.map((col) => (
                      <td
                        key={col.id}
                        className={cx(
                          "px-4 py-3 align-middle",
                          col.align === "right" && "text-right",
                        )}
                      >
                        {col.cell(row)}
                      </td>
                    ))}
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
      {!loading && rows.length === 0 && empty ? <div className="p-2">{empty}</div> : null}
    </div>
  );
}
