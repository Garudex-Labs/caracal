/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders the collapsible, left-attached Console navigation sidebar.
*/
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { NavIcon } from "@/components/console/NavIcon";
import { LockBadge } from "@/components/ui";
import { cx } from "@/lib/cx";
import { NAV_GROUPS } from "@/platform/nav/navModel";
import { useTheme } from "@/platform/theme";

function isActive(pathname: string, to: string): boolean {
  if (to === "/app") return pathname === "/app";
  return pathname === to || pathname.startsWith(`${to}/`);
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
            <span className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-muted-foreground" />
          ) : null}
        </span>
        {!collapsed ? (
          <>
            <span className="flex-1 truncate">{label}</span>
            {locked ? <LockBadge /> : null}
          </>
        ) : null}
      </Link>
      {collapsed && hover ? (
        <span
          role="tooltip"
          className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 flex -translate-y-1/2 items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs font-medium text-popover-foreground shadow-md"
        >
          {label}
          {locked ? <LockBadge /> : null}
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
          {NAV_GROUPS.map((group) => (
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
                    to={item.to}
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
    </div>
  );
}
