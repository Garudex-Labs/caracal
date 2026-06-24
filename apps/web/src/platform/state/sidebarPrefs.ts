/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file holds browser-local sidebar customization: which navigation items the operator hides.
*/
import { useSyncExternalStore } from "react";

const STORE_KEY = "caracal.sidebar.hidden";

// Items the operator can never hide, so the Console always has a way back to its home and settings.
export const PINNED_NAV_ITEMS = new Set(["dashboard", "settings"]);

const listeners = new Set<() => void>();
let snapshot: string[] | null = null;

function load(): string[] {
  if (typeof localStorage === "undefined") return [];
  const raw = localStorage.getItem(STORE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as string[];
    return Array.isArray(parsed) ? parsed.filter((id) => !PINNED_NAV_ITEMS.has(id)) : [];
  } catch {
    return [];
  }
}

function persist(next: string[]): void {
  snapshot = next;
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
  }
  for (const listener of listeners) listener();
}

function current(): string[] {
  if (snapshot === null) snapshot = load();
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function toggleNavItem(id: string): void {
  if (PINNED_NAV_ITEMS.has(id)) return;
  const list = current();
  persist(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
}

export function useHiddenNavItems(): string[] {
  return useSyncExternalStore(subscribe, current, current);
}
