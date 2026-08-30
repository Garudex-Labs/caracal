// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute } from "@tanstack/react-router";
import { lazy } from "react";
const OrganizationAuditLogPage = lazy(() => import("@/pages/organization/audit-log"));

export const Route = createFileRoute("/organization/audit-log")({
	component: OrganizationAuditLogPage,
});
