/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file holds the per-tab read-only system-zone viewer latch shared by the API client and the console hooks.
*/

// The query parameter that opens the reserved system zone in a new, read-only viewer tab, and
// the per-tab sessionStorage latch it sets. The flag is latched so it survives in-tab navigation
// (which drops the query string) while staying strictly per-tab: a normal tab is never switched
// into the viewer, and the shared active-zone storage is never touched.
const SYSTEM_ZONE_VIEW_PARAM = "systemZone";
const SYSTEM_ZONE_VIEW_KEY = "caracal.systemZoneView";

// Whether this browser tab is the read-only system-zone viewer. Reads the URL parameter first,
// latching it so a later in-tab navigation that drops the query string still resolves to the
// viewer, then falls back to the latch. Pure and synchronous so the API client can consult it on
// every request without React, which lets it fail closed on any mutating call from this tab.
export function isSystemZoneViewTab(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get(SYSTEM_ZONE_VIEW_PARAM) === "1") {
      window.sessionStorage.setItem(SYSTEM_ZONE_VIEW_KEY, "1");
      return true;
    }
    return window.sessionStorage.getItem(SYSTEM_ZONE_VIEW_KEY) === "1";
  } catch {
    return false;
  }
}

// Clears the per-tab viewer latch. Paired with a full navigation away from the viewer, so the
// destination loads as a normal Console tab.
export function clearSystemZoneViewLatch(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(SYSTEM_ZONE_VIEW_KEY);
  } catch {
    // sessionStorage may be unavailable; the absent latch still resolves to the normal Console.
  }
}
