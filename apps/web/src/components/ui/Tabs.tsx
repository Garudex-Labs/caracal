/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides the console tab controls: an underline tab bar and a segmented single-select panel switcher.
*/
import { useState, type ReactNode } from "react";

import { cx } from "@/lib/cx";

export interface TabItem {
  id: string;
  label: string;
  count?: number;
}

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: TabItem[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-6 border-b border-border">
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={cx(
              "relative -mb-px flex items-center gap-1.5 pb-3 text-xs font-medium tracking-wide outline-none transition-colors",
              "focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              selected ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
            {typeof tab.count === "number" ? (
              <span className="rounded-full bg-muted px-1.5 py-px text-[10px] font-semibold text-muted-foreground">
                {tab.count}
              </span>
            ) : null}
            {selected ? (
              <span className="absolute inset-x-0 -bottom-px h-px bg-foreground" />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

// One selectable segment of a SegmentedTabs control: a short label, an optional count, and the panel
// shown when it is active.
export interface Segment {
  key: string;
  label: string;
  count?: number;
  panel: ReactNode;
}

// The standard compact tool-artifact switcher: every segment sits in a single pill row and only the
// selected panel occupies vertical space, so any surface with several sections stays uniform and
// short regardless of how much it carries. Segments with no content should simply be omitted by the
// caller; the first segment leads. Renders nothing when given no segments.
export function SegmentedTabs({
  segments,
  className,
}: {
  segments: Segment[];
  className?: string;
}) {
  const [active, setActive] = useState(segments[0]?.key ?? "");
  const current = segments.find((segment) => segment.key === active) ?? segments[0];
  if (!current) return null;
  return (
    <div className={cx("flex flex-col gap-2", className)}>
      <div role="tablist" className="flex flex-wrap gap-1 rounded-lg bg-muted/50 p-1">
        {segments.map((segment) => {
          const selected = current.key === segment.key;
          return (
            <button
              key={segment.key}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setActive(segment.key)}
              className={cx(
                "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
                selected
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {segment.label}
              {typeof segment.count === "number" ? (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {segment.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" className="rounded-lg border border-border bg-background/40 p-3">
        {current.panel}
      </div>
    </div>
  );
}
