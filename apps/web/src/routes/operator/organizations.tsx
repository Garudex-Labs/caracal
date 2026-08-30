// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute } from "@tanstack/react-router";
import { lazy } from "react";
import { searchString } from "@/lib/search-params";
const OperatorOrganizationsPage = lazy(() => import("@/pages/operator/organizations"));

export type OperatorOrgsSearch = {
	q?: string;
	status?: "active" | "suspended";
	sort?: "created" | "name" | "members" | "projects" | "activity";
	order?: "asc" | "desc";
	page?: number;
};

const sortKeys = ["created", "name", "members", "projects", "activity"] as const;

export const Route = createFileRoute("/operator/organizations")({
	component: OperatorOrganizationsPage,
	validateSearch: (search: Record<string, unknown>): OperatorOrgsSearch => ({
		q: searchString(search.q),
		status:
			search.status === "active" || search.status === "suspended"
				? search.status
				: undefined,
		sort: sortKeys.includes(search.sort as (typeof sortKeys)[number])
			? (search.sort as OperatorOrgsSearch["sort"])
			: undefined,
		order: search.order === "asc" || search.order === "desc" ? search.order : undefined,
		page:
			typeof search.page === "number" && Number.isInteger(search.page) && search.page > 0
				? search.page
				: undefined,
	}),
});
