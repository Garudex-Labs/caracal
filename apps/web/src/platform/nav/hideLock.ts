/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines hide-locked navigation: pages presented as if they do not exist in a given context.
*/

// Beyond the operator's show/hide sidebar preference - which only removes a page from the
// sidebar while the route still works - a hide-locked page is presented as if it does not
// exist: it is removed from every navigation surface and rendered as not-found on direct
// access, and the operator cannot reveal it. The read-only system-zone viewer is a transparency
// view of how Caracal self-governs, so the enterprise upsell surfaces, the Operator workspace,
// and the settings screens are not part of it and must not appear to exist there.
const SYSTEM_VIEW_HIDE_LOCKED_PREFIXES = ["/app/ai", "/app/settings", "/app/enterprise"];

// Whether a path is hide-locked in the current context. The only context today is the read-only
// system-zone viewer; outside it nothing is hide-locked, so this is a no-op for the normal Console.
// Paths may be flat nav targets (/app/ai) or full account/org/zone-scoped pathnames
// (/acc/org/zone/app/ai), so the prefix is matched anywhere in the path.
export function isHideLockedPath(pathname: string, systemView: boolean): boolean {
  if (!systemView) return false;
  return SYSTEM_VIEW_HIDE_LOCKED_PREFIXES.some(
    (prefix) => pathname.endsWith(prefix) || pathname.includes(`${prefix}/`),
  );
}
