/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file holds per-account guide progress: forward-only statuses, deterministic merging, and the browser cache behind the account record.
*/

// A guide's lifecycle only moves forward: "unseen" (never auto-launched), "seen" (launched
// once; may still resume from the launcher), "done" (retired; never shown again). Because
// statuses never regress, any two records - browser cache vs. account record, or two
// concurrent writers - merge deterministically by keeping the furthest progress per guide,
// so no ordering of writes can ever resurrect a retired guide.
export type GuideStatus = "unseen" | "seen" | "done";

/** Progress per guide id. Absent ids are "unseen". */
export type GuideMap = Record<string, GuideStatus>;

export const CONSOLE_SETUP_GUIDE = "consoleSetup";

const CACHE_KEY = "caracal.guides";

const RANK: Record<GuideStatus, number> = { unseen: 0, seen: 1, done: 2 };

export function guideRank(status: GuideStatus): number {
  return RANK[status];
}

/** Parse a serialized guide map, dropping anything malformed rather than failing. */
export function parseGuides(raw: unknown): GuideMap {
  if (typeof raw !== "string" || raw === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const map: GuideMap = {};
  for (const [key, status] of Object.entries(parsed)) {
    if (status === "seen" || status === "done") map[key] = status;
  }
  return map;
}

/** Merge two guide maps, keeping the furthest progress for each guide. */
export function mergeGuides(a: GuideMap, b: GuideMap): GuideMap {
  const merged: GuideMap = { ...a };
  for (const [key, status] of Object.entries(b)) {
    const current = merged[key];
    if (!current || RANK[status] > RANK[current]) merged[key] = status;
  }
  return merged;
}

export function serializeGuides(map: GuideMap): string {
  return JSON.stringify(map);
}

// The cache exists only so guide decisions render instantly and survive a briefly
// unreachable backend; the account record is authoritative and wins via merge.
export function readGuidesCache(): GuideMap {
  if (typeof localStorage === "undefined") return {};
  return parseGuides(localStorage.getItem(CACHE_KEY) ?? "");
}

export function writeGuidesCache(map: GuideMap): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(CACHE_KEY, serializeGuides(map));
}

export function clearGuidesCache(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(CACHE_KEY);
}
