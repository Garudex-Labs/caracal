// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute } from "@tanstack/react-router";
import { lazy } from "react";
import { searchString } from "@/lib/search-params";
const AuditLogPage = lazy(() => import("@/pages/admin/audit-log"));

export type AuditLogSearch = {
	search?: string;
};

export const Route = createFileRoute("/operator/audit-log")({
	component: AuditLogPage,
	validateSearch: (search: Record<string, unknown>): AuditLogSearch => ({
		search: searchString(search.search),
	}),
});
