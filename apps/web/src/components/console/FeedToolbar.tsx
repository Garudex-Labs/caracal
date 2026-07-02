/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides the inline feed toolbar that aligns a Filters popover and the loaded count on the workspace search row.
*/
import { useEffect, useRef, useState, type ReactNode } from "react";

import { cx } from "@/lib/cx";

// A segmented tab control for switching between the views of a single workspace, designed
// to sit inline on the feed toolbar row.
export function FeedTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: readonly { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex h-9 items-center gap-0.5 rounded-md border border-border bg-muted/50 p-0.5"
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={value === tab.id}
          onClick={() => onChange(tab.id)}
          className={cx(
            "h-8 rounded px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
            value === tab.id
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

// An inline toolbar designed to sit on the same row as the workspace search box. It keeps
// everything on one line: a Filters button whose labeled fields drop into a floating panel,
// an optional control beside it, and the loaded count pushed to the right.
export function FeedToolbar({
  extra,
  trailing,
  activeFilters = 0,
  loaded,
  noun,
  children,
}: {
  extra?: ReactNode;
  trailing?: ReactNode;
  activeFilters?: number;
  loaded: number;
  noun: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      {children ? (
        <div ref={ref} className="relative">
          <button
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-haspopup="dialog"
            className={cx(
              "inline-flex h-9 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors",
              open || activeFilters > 0
                ? "border-foreground/20 bg-accent text-foreground"
                : "border-border text-muted-foreground hover:bg-surface hover:text-foreground",
            )}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 5h18l-7 8v5l-4 2v-7z" />
            </svg>
            Filters
            {activeFilters > 0 ? (
              <span className="grid h-4 min-w-4 place-items-center rounded-full bg-foreground px-1 text-[10px] font-semibold text-background">
                {activeFilters}
              </span>
            ) : null}
          </button>
          {open ? (
            <div className="animate-pop-in absolute left-0 top-full z-[60] mt-1.5 w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-border bg-popover p-3 shadow-xl">
              <div className="grid gap-2.5 sm:grid-cols-2">{children}</div>
            </div>
          ) : null}
        </div>
      ) : null}

      {extra}

      <div className="ml-auto flex items-center gap-4">
        <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:inline-flex">
          {loaded} {noun}
          {loaded === 1 ? "" : "s"}
        </span>
        {trailing}
      </div>
    </>
  );
}
