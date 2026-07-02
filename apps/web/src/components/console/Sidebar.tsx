/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders the collapsible, left-attached Console navigation sidebar.
*/
import { navTarget } from "@/platform/nav/appLink";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { NavIcon } from "@/components/console/NavIcon";
import { ProfileMenu } from "@/components/console/ProfileMenu";
import { cx } from "@/lib/cx";
import { useSystemZoneView } from "@/platform/api/hooks";
import { isHideLockedPath } from "@/platform/nav/hideLock";
import { NAV_GROUPS } from "@/platform/nav/navModel";
import { useHiddenNavItems } from "@/platform/state/sidebarPrefs";
import { useTheme } from "@/platform/theme";

function isActive(pathname: string, to: string): boolean {
  // The pathname is /:accountId/:orgId/:zoneId/app/...; nav targets are flat (/app, /app/audit),
  // so match on the /app suffix, which is stable across accounts and zones. The dashboard (/app)
  // is active only on the exact app root, never on a deeper page.
  if (to === "/app") return pathname.endsWith("/app");
  return pathname.endsWith(to) || pathname.includes(`${to}/`);
}

function LockGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function SidebarItem({
  to,
  label,
  iconName,
  active,
  locked,
  collapsed,
  onNavigate,
}: {
  to: string;
  label: string;
  iconName: string;
  active: boolean;
  locked?: boolean;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <li
      className="relative"
      data-tour={`nav-${iconName}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Link
        to={to}
        onClick={onNavigate}
        aria-label={label}
        className={cx(
          "group flex items-center rounded-md text-sm transition-colors",
          collapsed ? "h-9 w-9 justify-center" : "gap-3 px-2.5 py-2",
          active
            ? "bg-accent font-medium text-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <span className="relative flex-shrink-0">
          <NavIcon name={iconName} />
          {locked && collapsed ? (
            <span className="absolute -right-1 -top-1 grid h-3 w-3 place-items-center rounded-full bg-background text-muted-foreground">
              <LockGlyph className="h-2.5 w-2.5" />
            </span>
          ) : null}
        </span>
        {!collapsed ? (
          <>
            <span className="flex-1 truncate">{label}</span>
            {locked ? (
              <LockGlyph className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/70" />
            ) : null}
          </>
        ) : null}
      </Link>
      {collapsed && hover ? (
        <span
          role="tooltip"
          className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 flex -translate-y-1/2 items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs font-medium text-popover-foreground shadow-md"
        >
          {label}
          {locked ? (
            <span className="flex items-center gap-1 text-muted-foreground">
              <LockGlyph className="h-3 w-3" />
              Enterprise
            </span>
          ) : null}
        </span>
      ) : null}
    </li>
  );
}

export function Sidebar({
  pathname,
  collapsed,
  onToggle,
  onNavigate,
}: {
  pathname: string;
  collapsed: boolean;
  onToggle: () => void;
  onNavigate?: () => void;
}) {
  const theme = useTheme();
  const systemView = useSystemZoneView();
  const hidden = useHiddenNavItems();
  const hiddenSet = new Set(hidden);
  const groups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) => !hiddenSet.has(item.id) && !isHideLockedPath(item.to, systemView),
    ),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="flex h-full flex-col bg-background">
      <div
        className={cx(
          "flex h-14 flex-shrink-0 items-center border-b border-border",
          collapsed ? "justify-center px-2" : "px-3",
        )}
      >
        <button
          onClick={onToggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={cx(
            "group flex items-center rounded-md transition-colors hover:bg-accent",
            collapsed ? "h-10 w-10 justify-center" : "w-full gap-2.5 p-1.5",
          )}
        >
          <img
            src={theme === "light" ? "/caracal_sq_light.png" : "/caracal_sq.png"}
            alt="Caracal"
            className="h-8 w-8 flex-shrink-0 rounded-md object-cover"
          />
          {!collapsed ? (
            <span className="flex min-w-0 flex-col items-start leading-tight">
              <span className="font-mono text-sm font-semibold tracking-tight text-foreground">
                Caracal
              </span>
              <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                Community Edition
              </span>
            </span>
          ) : null}
        </button>
      </div>

      <nav className="scrollbar-thin flex-1 overflow-y-auto px-2 py-3">
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <div key={group.id}>
              {!collapsed ? (
                <div className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                  {group.label}
                </div>
              ) : (
                <div className="mx-auto mb-1 h-px w-6 bg-border first:hidden" />
              )}
              <ul className={cx("flex flex-col gap-0.5", collapsed && "items-center")}>
                {group.items.map((item) => (
                  <SidebarItem
                    key={item.id}
                    to={navTarget(item.to)}
                    label={item.label}
                    iconName={item.id}
                    active={isActive(pathname, item.to)}
                    locked={item.locked}
                    collapsed={collapsed}
                    onNavigate={onNavigate}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      </nav>

      <div
        className={cx(
          "flex-shrink-0 border-t border-border py-2",
          collapsed ? "flex justify-center px-2" : "px-2",
        )}
      >
        <ProfileMenu collapsed={collapsed} />
      </div>
    </div>
  );
}
