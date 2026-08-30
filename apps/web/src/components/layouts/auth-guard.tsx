// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { useAuthGuard, useOptionalAuth } from "@/hooks/use-auth";
import type { AuthContext } from "@/lib/api";

export function AuthGuard({ children, context }: { children: React.ReactNode; context?: AuthContext }) {
  const { ready } = useAuthGuard(context);
  // Block rendering until auth state is confirmed to prevent flicker
  // of protected content before redirect
  if (!ready) return <div className="flex h-screen w-full items-center justify-center" />;
  return <>{children}</>;
}

/**
 * Allows unauthenticated browsing - renders children regardless of auth state.
 * Resolves role for authenticated users so sidebar can show/hide admin items.
 */
export function OptionalAuthGuard({ children, context }: { children: React.ReactNode; context?: AuthContext }) {
  useOptionalAuth(context);
  // Render children immediately to prevent hydration mismatch
  return <>{children}</>;
}
