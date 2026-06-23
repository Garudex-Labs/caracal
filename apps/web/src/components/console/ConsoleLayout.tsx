/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file is the authenticated Console shell: top bar, zone switcher, and side navigation.
*/
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useState } from "react";

import { LockBadge, Tooltip } from "@/components/ui";
import { cx } from "@/lib/cx";
import { ZoneSwitcher } from "@/components/console/ZoneSwitcher";
import { signOut } from "@/platform/auth";
import { NAV_GROUPS } from "@/platform/nav/navModel";
import {
  activeZones,
  getActiveZone,
  getInstallation,
  setActiveZoneId,
} from "@/platform/state/localInstall";

function isActive(pathname: string, to: string): boolean {
  if (to === "/app") return pathname === "/app";
  return pathname === to || pathname.startsWith(`${to}/`);
}

export function ConsoleLayout() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const installation = getInstallation();
  const [zones] = useState(() => activeZones());
  const [activeZoneId, setActive] = useState<string | null>(() => getActiveZone()?.id ?? null);

  async function handleSignOut() {
    await signOut();
    navigate({ to: "/sign-in" });
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 flex items-center justify-between gap-4 border-b border-border bg-background/95 px-4 py-2.5 backdrop-blur">
        <div className="flex items-center gap-3">
          <Link to="/app" className="flex items-center gap-2">
            <div className="grid h-7 w-7 place-items-center rounded-sm bg-foreground text-sm font-bold text-background">
              C
            </div>
            <span className="font-mono text-sm font-semibold tracking-tight">
              {installation.name || "Caracal"}
            </span>
          </Link>
          <span className="hidden text-xs text-muted-foreground sm:inline">Community Edition</span>
          <div className="ml-2">
            <ZoneSwitcher
              zones={zones}
              activeZoneId={activeZoneId}
              onSelect={(id) => {
                setActiveZoneId(id);
                setActive(id);
              }}
            />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <a
            href="https://docs.caracal.run"
            target="_blank"
            rel="noreferrer"
            className="hidden text-sm text-muted-foreground hover:text-foreground sm:inline"
          >
            Docs
          </a>
          <button
            onClick={handleSignOut}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-accent"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[1400px]">
        <aside className="hidden w-60 shrink-0 border-r border-border px-3 py-5 md:block">
          <nav className="flex flex-col gap-5">
            {NAV_GROUPS.map((group) => (
              <div key={group.id}>
                <div className="px-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                  {group.label}
                </div>
                <ul className="mt-1.5 flex flex-col gap-0.5">
                  {group.items.map((item) => {
                    const active = isActive(pathname, item.to);
                    return (
                      <li key={item.id}>
                        <Link
                          to={item.to}
                          className={cx(
                            "flex items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors",
                            active
                              ? "bg-accent font-medium text-foreground"
                              : "text-muted-foreground hover:bg-accent hover:text-foreground",
                          )}
                        >
                          <span>{item.label}</span>
                          {item.locked ? (
                            <Tooltip label="Available in Caracal Enterprise">
                              <LockBadge />
                            </Tooltip>
                          ) : null}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>
        </aside>

        <main className="scrollbar-thin min-w-0 flex-1 px-5 py-6 md:px-8">
          <div className="mx-auto w-full max-w-6xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
