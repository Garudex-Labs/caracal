// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

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
 * Login URL for a hard navigation after session expiry, carrying the current
 * location so sign-in returns the user to the page they were on.
 */
export function sessionExpiredLoginUrl(): string {
  if (typeof window !== "undefined" && isOperatorPath(window.location.pathname)) {
    return "/operator-login";
  }
  const next = currentPathAsNext();
  return next
    ? `/login?reason=session_expired&next=${encodeURIComponent(next)}`
    : "/login?reason=session_expired";
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
