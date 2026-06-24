/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file is the authenticated Console shell: a left-attached collapsible sidebar and a top navbar with the profile menu.
*/
import { Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { CommandPalette } from "@/components/console/CommandPalette";
import { CommandTrigger } from "@/components/console/CommandTrigger";
import { GuidedSetup } from "@/components/console/GuidedSetup";
import { PlatformStatus } from "@/components/console/PlatformStatus";
import { LanguageMenu } from "@/components/console/LanguageMenu";
import { Sidebar } from "@/components/console/Sidebar";
import { cx } from "@/lib/cx";

const COLLAPSE_KEY = "caracal.sidebar.collapsed";

function readCollapsed(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(COLLAPSE_KEY) === "1";
}

export function ConsoleLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    }
  }, [collapsed]);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <aside
        className={cx(
          "hidden flex-shrink-0 border-r border-border transition-[width] duration-200 md:block",
          collapsed ? "w-16" : "w-60",
        )}
      >
        <Sidebar
          pathname={pathname}
          collapsed={collapsed}
          onToggle={() => setCollapsed((v) => !v)}
        />
      </aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-foreground/20 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          />
          <div className="absolute left-0 top-0 h-full w-60 border-r border-border bg-background shadow-xl">
            <Sidebar
              pathname={pathname}
              collapsed={false}
              onToggle={() => setMobileOpen(false)}
              onNavigate={() => setMobileOpen(false)}
            />
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 flex-shrink-0 items-center justify-between gap-3 border-b border-border bg-background/95 px-4 backdrop-blur">
          <button
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
            className="grid h-9 w-9 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div className="hidden items-center gap-2 md:flex">
            <CommandTrigger onOpen={() => setPaletteOpen(true)} />
            <PlatformStatus />
          </div>

          <div className="flex items-center gap-2">
            <LanguageMenu />
          </div>
        </header>

        <main className="scrollbar-thin min-w-0 flex-1 overflow-y-auto px-5 py-6 md:px-8">
          <div className="w-full">
            <Outlet />
          </div>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <GuidedSetup />
    </div>
  );
}
