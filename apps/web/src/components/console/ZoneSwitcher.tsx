/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders the always-visible, searchable zone switcher.
*/
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { cx } from "@/lib/cx";
import type { Zone } from "@/platform/api/types";

export function ZoneSwitcher({
  zones,
  activeZoneId,
  onSelect,
}: {
  zones: Zone[];
  activeZoneId: string | null;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const active = zones.find((zone) => zone.id === activeZoneId) ?? zones[0] ?? null;

  useEffect(() => {
    if (open) {
      setQuery("");
      const id = window.setTimeout(() => searchRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return zones;
    return zones.filter(
      (zone) => zone.name.toLowerCase().includes(q) || zone.slug.toLowerCase().includes(q),
    );
  }, [zones, query]);

  const searchable = zones.length > 6;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-accent"
      >
        <span className="grid h-5 w-5 place-items-center rounded bg-foreground text-[10px] font-bold text-background">
          Z
        </span>
        <span className="font-medium text-foreground">{active ? active.name : "No zone"}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            className="absolute left-0 z-20 mt-1 w-72 rounded-md border border-border bg-popover p-1 shadow-lg"
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
            }}
          >
            <div className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Switch zone
            </div>
            {searchable ? (
              <div className="px-1 pb-1">
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search zones…"
                  className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-ring"
                />
              </div>
            ) : null}
            <div className="scrollbar-thin max-h-72 overflow-y-auto">
              {zones.length === 0 ? (
                <div className="px-2 py-2 text-sm text-muted-foreground">No active zones.</div>
              ) : filtered.length === 0 ? (
                <div className="px-2 py-2 text-sm text-muted-foreground">No matching zones.</div>
              ) : (
                filtered.map((zone) => (
                  <button
                    key={zone.id}
                    onClick={() => {
                      onSelect(zone.id);
                      setOpen(false);
                    }}
                    className={cx(
                      "flex w-full items-center justify-between gap-3 rounded px-2 py-1.5 text-left text-sm hover:bg-accent",
                      zone.id === active?.id && "bg-accent",
                    )}
                  >
                    <span className="truncate text-foreground">{zone.name}</span>
                    <span className="flex items-center gap-2">
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {zone.slug}
                      </span>
                      {zone.id === active?.id ? (
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          className="text-foreground"
                        >
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      ) : null}
                    </span>
                  </button>
                ))
              )}
            </div>
            <div className="my-1 h-px bg-border" />
            <Link
              to="/app/zones"
              onClick={() => setOpen(false)}
              className="block rounded px-2 py-1.5 text-sm text-foreground hover:bg-accent"
            >
              Manage zones
            </Link>
          </div>
        </>
      ) : null}
    </div>
  );
}
