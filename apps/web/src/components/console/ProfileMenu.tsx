/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders the top-right profile menu: identity, zone switching, and account actions.
*/
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { cx } from "@/lib/cx";
import { useActiveZone } from "@/platform/api/hooks";
import { signOut, useSession } from "@/platform/auth";
import { getProfile } from "@/platform/state/localInstall";

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

export function ProfileMenu() {
  const navigate = useNavigate();
  const session = useSession();
  const { zones, activeZone, selectZone } = useActiveZone();
  const [open, setOpen] = useState(false);
  const [zoneSearch, setZoneSearch] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const profile = getProfile();
  const fullName = profile.fullName || session.data?.user?.name || "Owner";
  const email = session.data?.user?.email ?? "";

  useEffect(() => {
    if (!open) setZoneSearch("");
  }, [open]);

  const filteredZones = useMemo(() => {
    const q = zoneSearch.trim().toLowerCase();
    const list = q
      ? zones.filter((z) => z.name.toLowerCase().includes(q) || z.slug.toLowerCase().includes(q))
      : zones;
    return list.slice(0, 6);
  }, [zones, zoneSearch]);

  async function handleSignOut() {
    setOpen(false);
    await signOut();
    navigate({ to: "/sign-in" });
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={cx(
          "flex items-center gap-2.5 rounded-lg bg-background py-1.5 pl-1.5 pr-2.5 text-left transition-colors hover:bg-accent",
          open && "bg-accent",
        )}
      >
        <Avatar avatar={profile.avatar} name={fullName} size={30} />
        <span className="hidden min-w-0 flex-col leading-tight sm:flex">
          <span className="max-w-[12rem] truncate text-sm font-medium text-foreground">
            {fullName}
          </span>
          <span className="max-w-[12rem] truncate text-[11px] text-muted-foreground">
            {activeZone ? activeZone.name : "No active zone"}
          </span>
        </span>
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-40 mt-2 w-72 overflow-hidden rounded-xl border border-border bg-popover shadow-lg">
            <div className="flex items-center gap-3 border-b border-border p-3">
              <Avatar avatar={profile.avatar} name={fullName} size={40} />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-foreground">{fullName}</div>
                {email ? (
                  <div className="truncate text-xs text-muted-foreground">{email}</div>
                ) : null}
                <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                  {profile.accountId}
                </div>
              </div>
            </div>

            <div className="border-b border-border p-2">
              <div className="flex items-center justify-between px-1.5 pb-1">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                  Active zone
                </span>
                <Link
                  to="/app/zones"
                  onClick={() => setOpen(false)}
                  className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
                >
                  Manage
                </Link>
              </div>
              {zones.length === 0 ? (
                <Link
                  to="/app/zones"
                  onClick={() => setOpen(false)}
                  className="block rounded-md px-1.5 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  No zones yet — create one
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
            </div>

            <div className="p-1.5">
              <MenuLink
                to="/app/settings"
                onClick={() => setOpen(false)}
                label="Profile & settings"
              >
                <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" />
                <path d="M4 20a8 8 0 0 1 16 0" />
              </MenuLink>
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
                onClick={handleSignOut}
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
        </>
      ) : null}
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
