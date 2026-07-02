/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides the keyboard-driven command palette for fast Console navigation and actions.
*/
import { navTarget } from "@/platform/nav/appLink";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { NavIcon } from "@/components/console/NavIcon";
import { LockBadge } from "@/components/ui";
import { cx } from "@/lib/cx";
import { useActiveZone, useSystemZoneView } from "@/platform/api/hooks";
import { isHideLockedPath } from "@/platform/nav/hideLock";
import { NAV_GROUPS } from "@/platform/nav/navModel";
import { setTheme, useTheme } from "@/platform/theme";

interface Command {
  id: string;
  section: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  locked?: boolean;
  keywords: string;
  run: () => void;
}

function ActionIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const { zones, activeZone, selectZone } = useActiveZone();
  const theme = useTheme();
  const systemView = useSystemZoneView();

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const commands = useMemo<Command[]>(() => {
    const go = (to: string) => () => {
      onClose();
      navigate({ to: to === "/app" || to.startsWith("/app/") ? navTarget(to) : to });
    };

    const nav: Command[] = NAV_GROUPS.flatMap((group) =>
      group.items
        .filter((item) => !isHideLockedPath(item.to, systemView))
        .map((item) => ({
          id: `nav:${item.id}`,
          section: group.label,
          label: item.label,
          hint: item.locked ? "Enterprise" : undefined,
          icon: <NavIcon name={item.id} />,
          locked: item.locked,
          keywords: `${item.label} ${group.label}`.toLowerCase(),
          run: go(item.to),
        })),
    );

    const zoneCommands: Command[] = zones.map((zone) => ({
      id: `zone:${zone.id}`,
      section: "Switch zone",
      label: zone.name,
      hint: zone.id === activeZone?.id ? "Active" : zone.slug,
      icon: <NavIcon name="zones" />,
      keywords: `${zone.name} ${zone.slug} switch zone`.toLowerCase(),
      run: () => {
        selectZone(zone.id);
        onClose();
      },
    }));

    const actions: Command[] = [
      {
        id: "action:diagnostics",
        section: "Actions",
        label: "Open Diagnostics",
        hint: "Platform health",
        icon: <NavIcon name="diagnostics" />,
        keywords: "diagnostics health status doctor incident troubleshoot",
        run: go("/app/diagnostics"),
      },
      {
        id: "action:zones",
        section: "Actions",
        label: "Manage zones",
        icon: <NavIcon name="zones" />,
        keywords: "manage zones create new zone",
        run: go("/app/zones"),
      },
      {
        id: "action:theme",
        section: "Actions",
        label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
        hint: theme === "dark" ? "Dark" : "Light",
        icon:
          theme === "dark" ? (
            <ActionIcon>
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
            </ActionIcon>
          ) : (
            <ActionIcon>
              <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
            </ActionIcon>
          ),
        keywords: "theme dark light appearance mode",
        run: () => {
          setTheme(theme === "dark" ? "light" : "dark");
          onClose();
        },
      },
      {
        id: "action:docs",
        section: "Actions",
        label: "Open documentation",
        icon: (
          <ActionIcon>
            <path d="M4 5a2 2 0 0 1 2-2h10v18H6a2 2 0 0 1-2-2V5Z" />
            <path d="M8 7h6M8 11h6" />
          </ActionIcon>
        ),
        keywords: "documentation docs help guide",
        run: () => {
          onClose();
          window.open("https://docs.caracal.run", "_blank", "noreferrer");
        },
      },
    ];

    return [...nav, ...zoneCommands, ...actions];
  }, [navigate, onClose, zones, activeZone, selectZone, theme, systemView]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    const terms = q.split(/\s+/);
    return commands.filter((command) => terms.every((term) => command.keywords.includes(term)));
  }, [commands, query]);

  const sections = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, { command: Command; index: number }[]>();
    results.forEach((command, index) => {
      if (!map.has(command.section)) {
        map.set(command.section, []);
        order.push(command.section);
      }
      map.get(command.section)!.push({ command, index });
    });
    return order.map((label) => ({ label, items: map.get(label)! }));
  }, [results]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((value) => (results.length ? (value + 1) % results.length : 0));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((value) => (results.length ? (value - 1 + results.length) % results.length : 0));
      } else if (event.key === "Enter") {
        event.preventDefault();
        results[active]?.run();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, results, active, onClose]);

  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pt-[12vh]">
      <div
        className="animate-overlay-in fixed inset-0 bg-overlay/40 backdrop-blur-[1px]"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="animate-pop-in relative z-10 w-full max-w-xl overflow-hidden rounded-xl border border-border bg-popover shadow-2xl"
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            className="flex-shrink-0 text-muted-foreground"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.2-3.2" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search or jump to…"
            className="h-12 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            aria-label="Search commands"
          />
          <kbd className="hidden flex-shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:block">
            ESC
          </kbd>
        </div>

        <div ref={listRef} className="scrollbar-thin max-h-[min(60vh,28rem)] overflow-y-auto py-2">
          {results.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No matches for “{query}”.
            </p>
          ) : (
            sections.map((section) => (
              <div key={section.label} className="mb-1.5 last:mb-0">
                <div className="px-4 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                  {section.label}
                </div>
                {section.items.map(({ command, index }) => (
                  <button
                    key={command.id}
                    data-index={index}
                    onClick={command.run}
                    onMouseMove={() => setActive(index)}
                    className={cx(
                      "flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors",
                      index === active ? "bg-accent text-foreground" : "text-foreground",
                    )}
                  >
                    <span className="flex-shrink-0 text-muted-foreground">{command.icon}</span>
                    <span className="flex-1 truncate">{command.label}</span>
                    {command.locked ? <LockBadge /> : null}
                    {command.hint && !command.locked ? (
                      <span className="flex-shrink-0 font-mono text-[10px] text-muted-foreground">
                        {command.hint}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <Key>↑</Key>
              <Key>↓</Key>
              navigate
            </span>
            <span className="flex items-center gap-1">
              <Key>↵</Key>
              open
            </span>
          </span>
          <span>
            {results.length} result{results.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Key({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-muted px-1 py-px font-mono text-[10px] text-muted-foreground">
      {children}
    </kbd>
  );
}
