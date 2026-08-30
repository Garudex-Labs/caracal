// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0


import { useRoleGuard, type Role } from "@/hooks/use-role-guard";
import type { AuthContext } from "@/lib/api";

export function RoleGuard({ minRole, children, context }: { minRole: Role; children: React.ReactNode; context?: AuthContext }) {
  const { ready } = useRoleGuard(minRole, context);
  // Block rendering until role is confirmed to prevent flicker
  // of protected content before redirect
  if (!ready) return <div className="flex h-screen w-full items-center justify-center" />;
  return <>{children}</>;
}
