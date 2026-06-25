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

const STORE_KEY = "caracal.notifications";
const MAX_ENTRIES = 50;
// Notifications are transient: anything older than this is pruned automatically so the
// bell stays a recent, relevant feed instead of an ever-growing log.
const TTL_MS = 24 * 60 * 60 * 1000;

const listeners = new Set<() => void>();
let snapshot: NotificationRecord[] | null = null;

function load(): NotificationRecord[] {
  if (typeof localStorage === "undefined") return [];
  const raw = localStorage.getItem(STORE_KEY);
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
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
  }
  for (const listener of listeners) listener();
}

function current(): NotificationRecord[] {
  if (snapshot === null) snapshot = load();
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
