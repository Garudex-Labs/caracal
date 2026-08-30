// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0


import { useEffect, useSyncExternalStore } from "react";
import { useLocation, useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { getUserRole, type AuthContext } from "@/lib/api";
import { isOperatorPath } from "@/lib/safe-next";

/** Canonical role type matching the backend 3-tier deployment RBAC. */
export type Role = "operator" | "reviewer" | "user";

/** Ordered from most to least privileged. */
const ROLE_HIERARCHY: Role[] = ["operator", "reviewer", "user"];

/** Display labels for UI rendering. */
export const ROLE_LABELS: Record<Role, string> = {
  operator: "Operator",
  reviewer: "Reviewer",
  user: "Viewer",
};

/** Returns true if `userRole` is at or above `minRole` in the hierarchy. */
export function hasMinRole(userRole: string | null, minRole: Role): boolean {
  if (!userRole) return false;
  const userIdx = ROLE_HIERARCHY.indexOf(userRole as Role);
  const minIdx = ROLE_HIERARCHY.indexOf(minRole);
  if (userIdx === -1) return false;
  return userIdx <= minIdx;
}

function subscribe(cb: () => void) {
  window.addEventListener("storage", cb);
  return () => window.removeEventListener("storage", cb);
}

function getRoleSnapshot(context: AuthContext) {
  if (typeof window === "undefined") return "";
  return getUserRole(context) || "";
}

function getServerSnapshot() {
  return "ssr";
}

/**
 * Guard hook that checks if the current user meets a minimum role.
 * Redirects to "/" if the role is insufficient.
 */
export function useRoleGuard(minRole: Role, contextOverride?: AuthContext) {
  const router = useRouter();
  const { pathname } = useLocation();
  const context: AuthContext = contextOverride ?? (isOperatorPath(pathname) ? "operator" : "tenant");
  const role = useSyncExternalStore(subscribe, () => getRoleSnapshot(context), getServerSnapshot);
  const isSSR = role === "ssr";
  const ready = !isSSR && role !== "" && hasMinRole(role, minRole);

  useEffect(() => {
    if (isSSR) return;
    if (role !== "" && !hasMinRole(role, minRole)) {
      toast.error("You do not have permission to access this page.");
      if (minRole === "operator" && isOperatorPath(pathname)) {
        router.navigate({ to: "/operator-login", replace: true });
        return;
      }
      router.navigate({ to: "/", replace: true });
    }
  }, [context, isSSR, role, minRole, pathname, router]);

  return { ready };
}
