/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides the underline tab control matching the landing page pattern.
*/
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
