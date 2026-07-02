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
import { NotificationsMenu } from "@/components/console/NotificationsMenu";
import { LanguageMenu } from "@/components/console/LanguageMenu";
import { Sidebar } from "@/components/console/Sidebar";
import { UtilityRail } from "@/components/console/UtilityRail";
import { ErrorState } from "@/components/ErrorState";
import { Tooltip } from "@/components/ui/Tooltip";
import { ViewOnlyProvider } from "@/components/ui/ViewOnly";
import { useSystemZoneView } from "@/platform/api/hooks";
import { isHideLockedPath } from "@/platform/nav/hideLock";
import { cx } from "@/lib/cx";

const SYSTEM_ZONE_VIEW_REASON =
  "This is Caracal's internal system zone, shown read-only for transparency. Caracal governs it through its own policies, so changes are disabled here.";

const COLLAPSE_KEY = "caracal.sidebar.collapsed";

function readCollapsed(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(COLLAPSE_KEY) === "1";
}

export function ConsoleLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const systemView = useSystemZoneView();
  // A hide-locked route is presented as if it does not exist: in the read-only system-zone
  // viewer the enterprise, Operator, and settings screens render the same standalone not-found
  // page a genuinely unknown route would, so a direct URL reveals nothing.
  const hideLocked = isHideLockedPath(pathname, systemView);

  // The Operator is a full-height workspace, so its route fills the content region
  // exactly: the main area stops scrolling and the workspace flexes to fit between the
  // navbar above and the utility rail beside it, matching how the left sidebar bounds it.
  // The trailing segment is the optional conversation number, so both /app/ai and
  // /app/ai/<number> are the workspace.
  const flush = /\/app\/ai(?:\/|$)/.test(pathname);

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

  // Render the standalone not-found page for a hide-locked route, replacing the whole shell so
  // the page is indistinguishable from one that does not exist. Placed after every hook so the
  // hook order stays stable across renders.
  if (hideLocked) return <ErrorState code={404} />;

  return (
    <ViewOnlyProvider readOnly={systemView} reason={SYSTEM_ZONE_VIEW_REASON}>
      {systemView ? (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-[100] border-[3px] border-pink-500 shadow-[inset_0_0_12px_rgba(236,72,153,0.45)]"
        />
      ) : null}
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
              className="absolute inset-0 bg-overlay/30 backdrop-blur-sm"
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
              {systemView ? (
                <Tooltip label={SYSTEM_ZONE_VIEW_REASON} side="bottom" align="end">
                  <span
                    tabIndex={0}
                    className="inline-flex items-center gap-1.5 rounded-full border border-pink-500/40 bg-pink-500/10 px-2.5 py-1 text-xs font-medium text-pink-600 outline-none focus-visible:ring-2 focus-visible:ring-pink-500 dark:text-pink-400"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      className="h-3.5 w-3.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <rect x="3" y="11" width="18" height="11" rx="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                    View only
                  </span>
                </Tooltip>
              ) : null}
              <NotificationsMenu />
              <LanguageMenu />
            </div>
          </header>

          <main
            className={cx(
              "scrollbar-thin min-w-0 flex-1 px-5 py-6 md:px-8",
              flush ? "flex flex-col overflow-hidden" : "overflow-y-auto",
            )}
          >
            <div className={cx("w-full", flush && "flex min-h-0 flex-1 flex-col")}>
              <Outlet />
            </div>
          </main>
        </div>

        <UtilityRail />

        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
        <GuidedSetup />
      </div>
    </ViewOnlyProvider>
  );
}
