/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders the navbar notifications bell: a dropdown of stored Console notifications.
*/
import { useEffect, useMemo, useRef, useState } from "react";

import { cx } from "@/lib/cx";
import {
  clearNotifications,
  markAllRead,
  pruneExpired,
  removeNotification,
  useNotifications,
  useUnreadCount,
  type NotificationTone,
} from "@/platform/state/notifications";

const TONE_DOT: Record<NotificationTone, string> = {
  success: "bg-emerald-500",
  error: "bg-destructive",
  info: "bg-muted-foreground",
};

const PRUNE_INTERVAL_MS = 60_000;

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

export function NotificationsMenu() {
  const notifications = useNotifications();
  const unread = useUnreadCount();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  // Self-cleaning feed: prune expired entries on mount and on a steady interval so the bell
  // never accumulates stale notifications even while the tab stays open.
  useEffect(() => {
    pruneExpired();
    const timer = window.setInterval(pruneExpired, PRUNE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!open) return;
    pruneExpired();
    if (unread > 0) markAllRead();
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
  }, [open, unread]);

  // Reset the search each time the panel closes so it always reopens showing everything.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return notifications;
    return notifications.filter(
      (n) => n.title.toLowerCase().includes(q) || (n.description ?? "").toLowerCase().includes(q),
    );
  }, [notifications, query]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        className={cx(
          "relative grid h-9 w-9 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
          open && "bg-accent text-foreground",
        )}
      >
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
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 ? (
          <span className="absolute right-1 top-1 grid min-h-4 min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 z-40 mt-2 flex h-[28rem] w-80 flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-lg">
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <span className="text-sm font-semibold text-foreground">Notifications</span>
            {notifications.length > 0 ? (
              <button
                onClick={clearNotifications}
                className="text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                Clear all
              </button>
            ) : null}
          </div>

          {notifications.length > 0 ? (
            <div className="border-b border-border px-2.5 py-2">
              <div className="relative">
                <svg
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <circle cx="11" cy="11" r="7" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search notifications…"
                  aria-label="Search notifications"
                  className="h-8 w-full rounded-md border border-border bg-background pl-8 pr-2.5 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/25"
                />
              </div>
            </div>
          ) : null}

          {notifications.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center px-3 text-center">
              <p className="text-sm text-muted-foreground">You're all caught up</p>
              <p className="mt-1 text-xs text-muted-foreground/70">
                Activity and alerts will appear here.
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center px-3 text-center">
              <p className="text-sm text-muted-foreground">No matches</p>
              <p className="mt-1 text-xs text-muted-foreground/70">
                No notifications match &ldquo;{query}&rdquo;.
              </p>
            </div>
          ) : (
            <div className="scrollbar-thin min-h-0 flex-1 divide-y divide-border overflow-y-auto">
              {filtered.map((n) => (
                <div
                  key={n.id}
                  className="group flex items-start gap-2.5 px-3 py-2.5 transition-colors hover:bg-accent"
                >
                  <span
                    className={cx("mt-1.5 h-2 w-2 flex-shrink-0 rounded-full", TONE_DOT[n.tone])}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{n.title}</p>
                    {n.description ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">{n.description}</p>
                    ) : null}
                    <p className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                      {relativeTime(n.ts)}
                    </p>
                  </div>
                  <button
                    aria-label="Dismiss notification"
                    onClick={() => removeNotification(n.id)}
                    className="flex-shrink-0 text-muted-foreground/0 transition-colors hover:text-foreground group-hover:text-muted-foreground"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M6 6l12 12M6 18 18 6" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
