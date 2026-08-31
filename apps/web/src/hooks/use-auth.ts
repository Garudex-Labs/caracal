// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Auth guards backed by the Better Auth session (HttpOnly cookie). A cached
// registry JWT in sessionStorage means "signed in"; when it is absent we
// attempt a silent mint from the session cookie before redirecting.

import { useEffect, useSyncExternalStore } from "react";
import { useRouter, useLocation } from "@tanstack/react-router";
import { auth, ensureAccessToken, setUserRole, getUserRole, getAccessToken, clearSession, hasActiveAuthContext, type AuthContext } from "@/lib/api";
import { canonicalLoginUrl, currentPathAsNext } from "@/lib/safe-next";

function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError || (typeof navigator !== "undefined" && !navigator.onLine);
}

// The operator console has its own sign-in; tenant users keep the generic one.
function inOperatorArea(pathname: string): boolean {
  return pathname === "/operator" || pathname.startsWith("/operator/");
}

function inOperatorAuthArea(pathname: string): boolean {
  return inOperatorArea(pathname) || pathname === "/operator-login";
}

function redirectToLogin(router: ReturnType<typeof useRouter>, pathname: string, context: AuthContext) {
  if (context === "operator" || inOperatorAuthArea(pathname)) {
    router.navigate({ to: "/operator-login", replace: true });
    return;
  }
  // Canonical, org-free auth surface: a hard navigation drops the org subdomain
  // and the project basepath so login is never rendered inside a tenant it has
  // not proven the user belongs to; the destination rides in `next` only.
  window.location.assign(canonicalLoginUrl(currentPathAsNext()));
}

function authContextForPathname(pathname: string): AuthContext {
  return inOperatorArea(pathname) ? "operator" : "tenant";
}

function subscribe(cb: () => void) {
  window.addEventListener("storage", cb);
  return () => window.removeEventListener("storage", cb);
}

function getAuthSnapshot(context: AuthContext) {
  if (typeof window === "undefined") return "";
  const key = getAccessToken(context);
  const role = getUserRole(context);
  if (key) return role || "pending";
  if (hasActiveAuthContext(context)) return "refreshing";
  // No cached JWT. The HttpOnly session cookie may still be live (new tab),
  // so mark as "refreshing" and attempt a silent mint before redirecting.
  return "";
}

function getServerSnapshot() {
  return "ssr";
}

export function useAuthGuard(contextOverride?: AuthContext) {
  const router = useRouter();
  const { pathname } = useLocation();
  const context = contextOverride ?? authContextForPathname(pathname);
  const snapshot = useSyncExternalStore(subscribe, () => getAuthSnapshot(context), getServerSnapshot);
  const isSSR = snapshot === "ssr";
  const hasToken = !isSSR && snapshot !== "" && snapshot !== "refreshing";
  const isRefreshing = snapshot === "refreshing";
  const ready = hasToken && snapshot !== "pending";
  const role = ready ? snapshot : null;

  useEffect(() => {
    if (isSSR) return;

    // No cached JWT: try a silent mint from the session cookie.
    if (isRefreshing) {
      ensureAccessToken(context).then((token) => {
        if (token) {
          window.dispatchEvent(new Event("storage"));
        } else {
          clearSession(context);
          window.dispatchEvent(new Event("storage"));
          redirectToLogin(router, pathname, context);
        }
      });
      return;
    }

    if (!hasToken && pathname !== "/login" && pathname !== "/operator-login") {
      redirectToLogin(router, pathname, context);
      return;
    }
    if (!hasToken) return;

    if (snapshot === "pending") {
      auth.whoami(context).then((user) => {
        setUserRole(user.role, context);
        window.dispatchEvent(new Event("storage"));
      }).catch((err) => {
        if (isNetworkError(err)) return;
        clearSession(context);
        window.dispatchEvent(new Event("storage"));
        redirectToLogin(router, pathname, context);
      });
    }
  }, [isSSR, hasToken, isRefreshing, snapshot, pathname, context, router]);

  return { ready, role };
}

/**
 * Optional auth - resolves immediately for unauthenticated users.
 * Authenticated users get their role resolved via whoami.
 * Does NOT redirect to login.
 */
export function useOptionalAuth(context: AuthContext = "tenant") {
  const snapshot = useSyncExternalStore(subscribe, () => getAuthSnapshot(context), getServerSnapshot);
  const hasToken = snapshot !== "" && snapshot !== "refreshing" && snapshot !== "ssr";
  const ready = !hasToken || snapshot !== "pending";
  const role = (hasToken && snapshot !== "pending") ? snapshot : null;
  const isAuthenticated = hasToken && snapshot !== "pending";

  useEffect(() => {
    if (hasToken && snapshot === "pending") {
      auth.whoami(context).then((user) => {
        setUserRole(user.role, context);
        window.dispatchEvent(new Event("storage"));
      }).catch((err) => {
        if (isNetworkError(err)) return;
        clearSession(context);
        window.dispatchEvent(new Event("storage"));
      });
    }
  }, [context, hasToken, snapshot]);

  return { ready, role, isAuthenticated };
}
