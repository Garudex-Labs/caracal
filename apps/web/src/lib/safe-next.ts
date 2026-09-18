// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { canonicalAuthOriginPrefix } from "./tenant-host.ts";

/**
 * Client-side mirror of the server's `_is_safe_next` in
 * caracal-server/api/routes/auth.py: a safe return path is relative-only -
 * a single leading "/", never "//" (protocol-relative), never a backslash.
 * Both sides must agree or a crafted `next` becomes an open redirect.
 *
 * Control characters are rejected outright: the browser's URL parser strips
 * tabs, newlines, and carriage returns *before* resolving, so `/%0A/evil.com`
 * decodes to `/\n/evil.com` (which passes the naive checks) and then collapses
 * to `//evil.com` at navigation time - a protocol-relative open redirect.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

export function isSafeNext(path: string | null | undefined): path is string {
  return (
    typeof path === "string" &&
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !path.includes("\\") &&
    !CONTROL_CHARS.test(path)
  );
}

export function isOperatorPath(path: string | null | undefined): boolean {
  return typeof path === "string" && (path === "/operator" || path.startsWith("/operator/"));
}

export function isTenantNext(path: string | null | undefined): path is string {
  return isSafeNext(path) && !isOperatorPath(path) && path !== "/operator-login";
}

/** The path to send the user to after auth: `next` when safe, else the fallback. */
export function safeNext(path: string | null | undefined, fallback = "/"): string {
  return isSafeNext(path) ? path : fallback;
}

/** Normal tenant login must never return into the operator control plane. */
export function tenantNext(path: string | null | undefined, fallback = "/"): string {
  return isTenantNext(path) ? path : fallback;
}

/**
 * The canonical login URL: always the org-free auth host and the bare `/login`
 * route, with no query string whatsoever. The previous location is never
 * carried in `next` (or any other param), so a session ended for one workspace
 * cannot leak that location, and sign-in can never bounce back into a workspace
 * it cannot establish. Returns a relative path when the current origin is
 * already canonical; an absolute base-host URL when it must escape an org
 * subdomain.
 */
export function canonicalLoginUrl(): string {
  return `${canonicalAuthOriginPrefix()}/login`;
}

/**
 * Login URL for a hard navigation after session expiry or any authentication
 * failure. Tenant users always land on the canonical bare `/login`; operator
 * surfaces keep their dedicated console sign-in. No return path or reason is
 * ever attached, so the login flow starts clean every time.
 */
export function sessionExpiredLoginUrl(): string {
  if (typeof window !== "undefined" && isOperatorPath(window.location.pathname)) {
    return "/operator-login";
  }
  return canonicalLoginUrl();
}

/**
 * The current location encoded as a `next` value, or undefined when the page
 * is not worth returning to (home, or any auth page - returning to those
 * would loop).
 */
export function currentPathAsNext(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const path = window.location.pathname + window.location.search;
  if (
    path === "/" ||
    path.startsWith("/login") ||
    path.startsWith("/operator-login") ||
    isOperatorPath(path) ||
    path.startsWith("/register") ||
    path.startsWith("/device")
  ) {
    return undefined;
  }
  return isSafeNext(path) ? path : undefined;
}
