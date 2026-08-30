// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute } from "@tanstack/react-router";
import { lazy } from "react";
const OrganizationMembersPage = lazy(() => import("@/pages/organization/members"));

export const Route = createFileRoute("/_authed/organization/members")({
	component: OrganizationMembersPage,
});
