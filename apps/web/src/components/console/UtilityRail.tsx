/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders the right-edge utility rail: Contact us, Customize, and Sponsor us actions.
*/
import { navTarget } from "@/platform/nav/appLink";
import Cal, { getCalApi } from "@calcom/embed-react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { cx } from "@/lib/cx";
import { useSystemZoneView } from "@/platform/api/hooks";
import { isCommunity } from "@/platform/edition/edition";
import { isHideLockedPath } from "@/platform/nav/hideLock";
import { NAV_GROUPS } from "@/platform/nav/navModel";
import { PINNED_NAV_ITEMS, toggleNavItem, useHiddenNavItems } from "@/platform/state/sidebarPrefs";
import { toggleTheme, useTheme } from "@/platform/theme";

const CAL_LINK = "rawx18/caracal-enterprise-sales";
const SPONSOR_LINK = "https://github.com/sponsors/RAWx18";
const ISSUE_LINK = "https://github.com/Garudex-Labs/caracal/issues/new/choose";

type OpenPanel = "contact" | "customize" | null;

export function UtilityRail({ className }: { className?: string }) {
  const [open, setOpen] = useState<OpenPanel>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const theme = useTheme();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const systemView = useSystemZoneView();

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(null);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <aside
      ref={rootRef}
      className={cx(
        "hidden w-12 flex-shrink-0 flex-col items-center border-l border-border md:flex",
        className,
      )}
    >
      <div className="flex h-14 w-full flex-shrink-0 items-center justify-center border-b border-border">
        <RailButton
          label={theme === "dark" ? "Light mode" : "Dark mode"}
          onClick={toggleTheme}
          icon={
            theme === "dark" ? (
              <>
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
              </>
            ) : (
              <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
            )
          }
        />
      </div>

      <div className="flex flex-col items-center gap-1.5 py-3">
        <RailButton
          label="Customize"
          active={open === "customize"}
          onClick={() => setOpen((v) => (v === "customize" ? null : "customize"))}
          panel={open === "customize" ? <CustomizePanel /> : null}
          icon={
            <>
              <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
              <path d="M1 14h6M9 8h6M17 16h6" />
            </>
          }
        />

        {isHideLockedPath("/app/ai", systemView) ? null : (
          <RailButton
            label="Caracal Operator"
            to={navTarget("/app/ai")}
            active={/\/app\/ai(?:\/|$)/.test(pathname)}
            icon={
              <>
                <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9z" />
                <path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17z" />
              </>
            }
          />
        )}
      </div>

      <div className="mt-auto flex flex-col items-center gap-1.5 border-t border-border py-3">
        <RailButton
          label="Contact us"
          active={open === "contact"}
          onClick={() => setOpen((v) => (v === "contact" ? null : "contact"))}
          panel={open === "contact" ? <ContactPanel /> : null}
          icon={
            <>
              <path d="M3 8.5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
              <path d="m3.5 8 8.5 6 8.5-6" />
            </>
          }
        />

        <RailButton
          label="Report an issue"
          href={ISSUE_LINK}
          icon={
            <>
              <rect x="8" y="6" width="8" height="12" rx="4" />
              <path d="M19 7l-2 1.5M5 7l2 1.5M3 12h3M18 12h3M19 17l-2-1.5M5 17l2-1.5M12 3v2M9 5l1 1.5h4L15 5" />
            </>
          }
        />

        {isCommunity() ? (
          <RailButton
            label="Sponsor us"
            href={SPONSOR_LINK}
            icon={
              <path d="M19 14c1.5-1.5 3-3.3 3-5.5A4.5 4.5 0 0 0 12 5 4.5 4.5 0 0 0 2 8.5C2 12 6 15 12 20c2-1.7 4.5-3.7 7-6Z" />
            }
          />
        ) : null}
      </div>
    </aside>
  );
}

function RailButton({
  label,
  icon,
  active,
  onClick,
  href,
  to,
  panel,
}: {
  label: string;
  icon: ReactNode;
  active?: boolean;
  onClick?: () => void;
  href?: string;
  to?: string;
  panel?: ReactNode;
}) {
  const content = (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {icon}
    </svg>
  );

  const className = cx(
    "group relative grid h-9 w-9 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
    active && "bg-accent text-foreground",
  );

  const floatingLabel = (
    <span className="pointer-events-none absolute right-full top-1/2 z-50 mr-2 -translate-y-1/2 flex items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs font-medium text-popover-foreground opacity-0 shadow-md transition-opacity group-hover:opacity-100">
      {label}
    </span>
  );

  if (to) {
    return (
      <Link to={to} aria-label={label} className={className}>
        {content}
        {floatingLabel}
      </Link>
    );
  }

  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" aria-label={label} className={className}>
        {content}
        {floatingLabel}
      </a>
    );
  }

  return (
    <button onClick={onClick} aria-label={label} className={className}>
      {content}
      {!active ? floatingLabel : null}
      {panel}
    </button>
  );
}

function ContactPanel() {
  const theme = useTheme();

  useEffect(() => {
    (async () => {
      const cal = await getCalApi();
      cal("ui", { theme, hideEventTypeDetails: false, layout: "month_view" });
    })();
  }, [theme]);

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="absolute bottom-0 right-full z-40 mr-2 w-[34rem] max-w-[calc(100vw-5rem)] cursor-default overflow-hidden rounded-xl border border-border bg-popover text-left shadow-xl"
    >
      <div className="border-b border-border px-4 py-3">
        <p className="text-sm font-semibold text-foreground">Talk to sales</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Book an Enterprise call - SSO, multi-tenancy, and managed services.
        </p>
      </div>
      <div className="scrollbar-thin max-h-[32rem] overflow-y-auto">
        <Cal
          calLink={CAL_LINK}
          style={{ width: "100%", height: "520px", overflow: "scroll" }}
          config={{ layout: "month_view", theme }}
        />
      </div>
    </div>
  );
}

function CustomizePanel() {
  const systemView = useSystemZoneView();
  const hidden = useHiddenNavItems();
  const hiddenSet = new Set(hidden);
  const groups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !isHideLockedPath(item.to, systemView)),
  })).filter((group) => group.items.length > 0);

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="absolute right-full top-0 z-40 mr-2 w-72 cursor-default overflow-hidden rounded-xl border border-border bg-popover text-left shadow-xl"
    >
      <div className="border-b border-border px-3 py-2.5">
        <p className="text-sm font-semibold text-foreground">Customize sidebar</p>
        <p className="mt-0.5 text-xs text-muted-foreground">Choose which pages appear.</p>
      </div>
      <div className="scrollbar-thin max-h-80 overflow-y-auto p-2">
        {groups.map((group) => (
          <div key={group.id} className="mb-2 last:mb-0">
            <div className="px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              {group.label}
            </div>
            {group.items.map((item) => {
              const pinned = PINNED_NAV_ITEMS.has(item.id);
              const visible = pinned || !hiddenSet.has(item.id);
              return (
                <label
                  key={item.id}
                  className={cx(
                    "flex items-center justify-between gap-2 rounded-md px-1.5 py-1.5 text-sm",
                    pinned ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-accent",
                  )}
                >
                  <span className="truncate text-foreground">{item.label}</span>
                  <input
                    type="checkbox"
                    checked={visible}
                    disabled={pinned}
                    onChange={() => toggleNavItem(item.id)}
                    className="h-4 w-4 flex-shrink-0 accent-foreground"
                  />
                </label>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
