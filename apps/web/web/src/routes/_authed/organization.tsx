// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Layout for the organization administration area (active org, owner/admin
// only - the shell renders not-found for anyone else, mirroring the API).

import { createFileRoute } from "@tanstack/react-router";
import { lazy } from "react";
const OrganizationShell = lazy(() => import("@/pages/organization/shell"));

export const Route = createFileRoute("/_authed/organization")({
	component: OrganizationShell,
});
