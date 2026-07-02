/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file holds the browser-local notifications center that backs the navbar bell dropdown.
*/
import { useSyncExternalStore } from "react";

export type NotificationTone = "success" | "error" | "info";

export interface NotificationRecord {
  id: string;
  tone: NotificationTone;
  title: string;
  description?: string;
  ts: number;
  read: boolean;
}

const STORE_PREFIX = "caracal.notifications";
const MAX_ENTRIES = 50;
// Notifications are transient: anything older than this is pruned automatically so the
// bell stays a recent, relevant feed instead of an ever-growing log.
const TTL_MS = 24 * 60 * 60 * 1000;

// Notifications are scoped to the bound account so a different login never sees another account's
// feed and a backend purge (which drops the account binding) starts a clean bucket. The bound
// account is read directly from localStorage to avoid a dependency cycle with the identity store;
// when none is bound the feed falls back to a shared anonymous bucket.
function storeKey(): string {
  if (typeof localStorage === "undefined") return STORE_PREFIX;
  const owner = localStorage.getItem("caracal.owner");
  return owner ? `${STORE_PREFIX}.${owner.replace(/^"|"$/g, "")}` : STORE_PREFIX;
}

const listeners = new Set<() => void>();
let snapshot: NotificationRecord[] | null = null;
let snapshotKey: string | null = null;

function load(): NotificationRecord[] {
  if (typeof localStorage === "undefined") return [];
  const raw = localStorage.getItem(storeKey());
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as NotificationRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Drops entries past their TTL. Returns the same reference when nothing expired so callers
// can cheaply detect whether a persist is needed.
function prune(list: NotificationRecord[]): NotificationRecord[] {
  const cutoff = Date.now() - TTL_MS;
  const kept = list.filter((n) => n.ts >= cutoff);
  return kept.length === list.length ? list : kept;
}

function persist(next: NotificationRecord[]): void {
  snapshot = next;
  snapshotKey = storeKey();
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(storeKey(), JSON.stringify(next));
  }
  for (const listener of listeners) listener();
}

function current(): NotificationRecord[] {
  // Reload when the bound account changed, so the bell follows the active identity and never shows
  // a previous login's feed without needing the store to import the identity module.
  const key = storeKey();
  if (snapshot === null || snapshotKey !== key) {
    snapshot = load();
    snapshotKey = key;
  }
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function makeId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function pushNotification(entry: {
  tone: NotificationTone;
  title: string;
  description?: string;
}): void {
  const record: NotificationRecord = {
    id: makeId(),
    tone: entry.tone,
    title: entry.title,
    description: entry.description,
    ts: Date.now(),
    read: false,
  };
  persist([record, ...current()].slice(0, MAX_ENTRIES));
}

export function markAllRead(): void {
  const list = current();
  if (!list.some((n) => !n.read)) return;
  persist(list.map((n) => (n.read ? n : { ...n, read: true })));
}

export function removeNotification(id: string): void {
  persist(current().filter((n) => n.id !== id));
}

export function clearNotifications(): void {
  if (current().length === 0) return;
  persist([]);
}

// Re-reads the feed for the now-bound account and notifies the bell, so switching account or a
// purge immediately reflects the right bucket. Also drops the legacy unscoped key so a feed
// written before scoping never resurfaces across identities.
export function refreshNotificationsForIdentity(): void {
  if (typeof localStorage !== "undefined") localStorage.removeItem(STORE_PREFIX);
  snapshot = load();
  snapshotKey = storeKey();
  for (const listener of listeners) listener();
}

// Removes any entries past their TTL, persisting only when something actually expired.
// Driven on an interval and on menu open so the feed self-cleans without a backend.
export function pruneExpired(): void {
  const list = current();
  const next = prune(list);
  if (next !== list) persist(next);
}

export function useNotifications(): NotificationRecord[] {
  return useSyncExternalStore(subscribe, current, current);
}

export function useUnreadCount(): number {
  const list = useNotifications();
  return list.reduce((count, n) => (n.read ? count : count + 1), 0);
}
