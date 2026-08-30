// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute, Outlet } from "@tanstack/react-router";
import { RoleGuard } from "@/components/layouts/role-guard";

function UserLayout() {
  return (
    <RoleGuard minRole="user">
      <Outlet />
    </RoleGuard>
  );
}

export const Route = createFileRoute("/_authed/_user")({
  component: UserLayout,
});
