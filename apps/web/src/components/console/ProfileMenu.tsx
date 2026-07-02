/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders the profile menu in the sidebar footer: identity, zone switching, and account actions.
*/
import { appLink } from "@/platform/nav/appLink";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { ConfirmDialog } from "@/components/ui";
import { cx } from "@/lib/cx";
import { useActiveZone, useSystemZoneView, exitSystemZoneView } from "@/platform/api/hooks";
import { isHideLockedPath } from "@/platform/nav/hideLock";
import { signOut, useSession } from "@/platform/auth";
import { useProfile, resolveDisplayName } from "@/platform/state/localInstall";
import { toggleTheme, useTheme } from "@/platform/theme";

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "C";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function Avatar({ avatar, name, size }: { avatar: string; name: string; size: number }) {
  return avatar ? (
    <img
      src={avatar}
      alt=""
      className="rounded-full object-cover"
      style={{ width: size, height: size }}
    />
  ) : (
    <span
      className="grid place-items-center rounded-full bg-foreground font-semibold text-background"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {initialsOf(name)}
    </span>
  );
}

export function ProfileMenu({ collapsed = false }: { collapsed?: boolean }) {
  const navigate = useNavigate();
  const session = useSession();
  const { zones, activeZone, selectZone } = useActiveZone();
  const theme = useTheme();
  const systemView = useSystemZoneView();
  const [open, setOpen] = useState(false);
  const [zoneSearch, setZoneSearch] = useState("");
  const [signOutOpen, setSignOutOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const profile = useProfile();
  const fullName = profile.fullName || session.data?.user?.name || "Owner";
  const profileName = resolveDisplayName(fullName, profile.displayName) || fullName;
  const email = session.data?.user?.email ?? "";

  useEffect(() => {
    if (!open) {
      setZoneSearch("");
      return;
    }
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const filteredZones = useMemo(() => {
    const q = zoneSearch.trim().toLowerCase();
    const list = q
      ? zones.filter((z) => z.name.toLowerCase().includes(q) || z.slug.toLowerCase().includes(q))
      : zones;
    return list.slice(0, 6);
  }, [zones, zoneSearch]);

  async function confirmSignOut() {
    setOpen(false);
    await signOut();
    navigate({ to: "/sign-in" });
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Account menu"
        title={collapsed ? profileName : undefined}
        className={cx(
          "flex items-center rounded-lg transition-colors hover:bg-accent",
          collapsed ? "h-10 w-10 justify-center" : "w-full gap-2.5 p-1.5",
          open && "bg-accent",
        )}
      >
        <Avatar avatar={profile.avatar} name={profileName} size={collapsed ? 30 : 32} />
        {!collapsed ? (
          <>
            <span className="flex min-w-0 flex-1 flex-col text-left leading-tight">
              <span className="truncate text-sm font-medium text-foreground">{profileName}</span>
              <span className="truncate text-[11px] text-muted-foreground">
                {systemView ? "System zone" : activeZone ? activeZone.name : "No active zone"}
              </span>
            </span>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="flex-shrink-0 text-muted-foreground"
              aria-hidden="true"
            >
              <path d="m7 15 5 5 5-5M7 9l5-5 5 5" />
            </svg>
          </>
        ) : null}
      </button>

      {open ? (
        <div className="absolute bottom-full left-0 z-40 mb-2 w-72 overflow-hidden rounded-xl border border-border bg-popover shadow-lg">
          <div className="flex items-center gap-3 border-b border-border p-3">
            <Avatar avatar={profile.avatar} name={profileName} size={40} />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-foreground">{profileName}</div>
              {profile.displayName.trim() && profile.displayName.trim() !== fullName ? (
                <div className="truncate text-xs text-muted-foreground">{fullName}</div>
              ) : null}
              {email ? <div className="truncate text-xs text-muted-foreground">{email}</div> : null}
              <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                {profile.accountId}
              </div>
            </div>
          </div>

          <div className="border-b border-border p-2">
            {systemView ? (
              <button
                onClick={() => exitSystemZoneView("/app/zones")}
                className="flex w-full items-center gap-2 rounded-md px-1.5 py-2 text-left text-sm text-foreground hover:bg-accent"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="flex-shrink-0 text-muted-foreground"
                  aria-hidden="true"
                >
                  <rect x="3" y="3" width="7" height="7" rx="1" />
                  <rect x="14" y="3" width="7" height="7" rx="1" />
                  <rect x="3" y="14" width="7" height="7" rx="1" />
                  <rect x="14" y="14" width="7" height="7" rx="1" />
                </svg>
                <span className="truncate">Manage zones</span>
              </button>
            ) : (
              <>
                <div className="flex items-center justify-between px-1.5 pb-1">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Active zone
                  </span>
                  <Link
                    to={appLink("/zones")}
                    onClick={() => setOpen(false)}
                    className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
                  >
                    Manage
                  </Link>
                </div>
                {zones.length === 0 ? (
                  <Link
                    to={appLink("/zones")}
                    onClick={() => setOpen(false)}
                    className="block rounded-md px-1.5 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    No zones yet. Create one
                  </Link>
                ) : (
                  <>
                    {zones.length > 6 ? (
                      <input
                        value={zoneSearch}
                        onChange={(e) => setZoneSearch(e.target.value)}
                        placeholder="Search zones…"
                        className="mb-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-ring"
                      />
                    ) : null}
                    <div className="scrollbar-thin max-h-44 overflow-y-auto">
                      {filteredZones.map((zone) => {
                        const isActive = zone.id === activeZone?.id;
                        return (
                          <button
                            key={zone.id}
                            onClick={() => {
                              selectZone(zone.id);
                              setOpen(false);
                            }}
                            className={cx(
                              "flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1.5 text-left text-sm hover:bg-accent",
                              isActive && "bg-accent",
                            )}
                          >
                            <span className="truncate text-foreground">{zone.name}</span>
                            {isActive ? (
                              <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                                className="flex-shrink-0 text-foreground"
                              >
                                <path d="M20 6 9 17l-5-5" />
                              </svg>
                            ) : (
                              <span className="truncate font-mono text-[10px] text-muted-foreground">
                                {zone.slug}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </>
            )}
          </div>

          <div className="p-1.5">
            {isHideLockedPath("/app/settings", systemView) ? null : (
              <MenuLink
                to={appLink("/settings")}
                onClick={() => setOpen(false)}
                label="Profile & settings"
              >
                <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" />
                <path d="M4 20a8 8 0 0 1 16 0" />
              </MenuLink>
            )}

            <button
              onClick={toggleTheme}
              className="flex w-full items-center justify-between gap-2.5 rounded-md px-2 py-2 text-sm text-foreground transition-colors hover:bg-accent"
            >
              <span className="flex items-center gap-2.5">
                {theme === "dark" ? (
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-muted-foreground"
                  >
                    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
                  </svg>
                ) : (
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-muted-foreground"
                  >
                    <circle cx="12" cy="12" r="4" />
                    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
                  </svg>
                )}
                Theme
              </span>
              <span className="text-xs text-muted-foreground">
                {theme === "dark" ? "Dark" : "Light"}
              </span>
            </button>

            <a
              href="https://docs.caracal.run"
              target="_blank"
              rel="noreferrer"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2.5 rounded-md px-2 py-2 text-sm text-foreground transition-colors hover:bg-accent"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-muted-foreground"
              >
                <path d="M4 5a2 2 0 0 1 2-2h10v18H6a2 2 0 0 1-2-2V5Z" />
                <path d="M8 7h6M8 11h6" />
              </svg>
              Documentation
            </a>
          </div>

          <div className="border-t border-border p-1.5">
            <button
              onClick={() => {
                setOpen(false);
                setSignOutOpen(true);
              }}
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-sm text-destructive transition-colors hover:bg-destructive/10"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3" />
                <path d="m16 17 5-5-5-5M21 12H9" />
              </svg>
              Sign out
            </button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={signOutOpen}
        onClose={() => setSignOutOpen(false)}
        title="Sign out"
        description="Are you sure you want to sign out of Caracal? You will need to sign in again to continue."
        confirmLabel="Sign out"
        tone="danger"
        onConfirm={confirmSignOut}
      />
    </div>
  );
}

function MenuLink({
  to,
  onClick,
  label,
  children,
}: {
  to: string;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      onClick={onClick}
      className="flex items-center gap-2.5 rounded-md px-2 py-2 text-sm text-foreground transition-colors hover:bg-accent"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-muted-foreground"
      >
        {children}
      </svg>
      {label}
    </Link>
  );
}
