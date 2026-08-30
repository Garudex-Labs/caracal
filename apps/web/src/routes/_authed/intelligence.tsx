// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute } from "@tanstack/react-router";
import { lazy } from "react";
const IntelligenceLayout = lazy(() => import("@/pages/project/intelligence/layout"));

export const Route = createFileRoute("/_authed/intelligence")({
	validateSearch: (
		search: Record<string, unknown>,
	): { range?: string; resource?: string; signal?: string; breakdown?: string; focus?: string; sort?: string; q?: string; page?: number; a?: string; b?: string; category?: string } => {
		const out: { range?: string; resource?: string; signal?: string; breakdown?: string; focus?: string; sort?: string; q?: string; page?: number; a?: string; b?: string; category?: string } = {};
		if (typeof search.range === "string") out.range = search.range;
		if (typeof search.resource === "string") out.resource = search.resource;
		if (typeof search.signal === "string") out.signal = search.signal;
		if (typeof search.breakdown === "string") out.breakdown = search.breakdown;
		if (typeof search.focus === "string") out.focus = search.focus;
		if (typeof search.sort === "string") out.sort = search.sort;
		if (typeof search.q === "string") out.q = search.q;
		if (typeof search.page === "number" && Number.isInteger(search.page) && search.page > 0) out.page = search.page;
		if (typeof search.a === "string") out.a = search.a;
		if (typeof search.b === "string") out.b = search.b;
		if (typeof search.category === "string") out.category = search.category;
		return out;
	},
	component: IntelligenceLayout,
});
