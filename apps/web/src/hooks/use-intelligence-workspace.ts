// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCurrentOrg } from "@/hooks/use-current-org";
import { useCurrentProject } from "@/hooks/use-current-project";
import { intelligence } from "@/lib/api";
import type { HistoryCategory, IntelligenceRange, IntelligenceResourceQuery } from "@/lib/types";

const STALE_MS = 60 * 1000;

export function useIntelligenceContext() {
	const { currentOrg } = useCurrentOrg();
	const { currentProject, noProjects, needsSelection, isLoading } = useCurrentProject();
	return {
		org: currentOrg?.slug,
		project: currentProject?.slug,
		projectName: currentProject?.name,
		noProjects,
		needsSelection,
		contextLoading: isLoading,
	};
}

export function useIntelligenceBriefing(org?: string, project?: string, range: IntelligenceRange = "7d") {
	return useQuery({
		queryKey: ["intelligence", org, project, "briefing", range],
		queryFn: () => intelligence.briefing(org || "", project || "", range),
		enabled: !!org && !!project,
		staleTime: STALE_MS,
	});
}

export function useIntelligenceResources(
	org?: string,
	project?: string,
	query: IntelligenceResourceQuery = { range: "7d" },
) {
	return useQuery({
		queryKey: ["intelligence", org, project, "resources", query],
		queryFn: () => intelligence.resources(org || "", project || "", query),
		enabled: !!org && !!project,
		staleTime: STALE_MS,
		placeholderData: keepPreviousData,
	});
}

export function useIntelligenceCompare(
	org?: string,
	project?: string,
	range: IntelligenceRange = "7d",
	a?: string,
	b?: string,
) {
	return useQuery({
		queryKey: ["intelligence", org, project, "resources", "compare", range, a, b],
		queryFn: () => intelligence.compare(org || "", project || "", range, a || "", b || ""),
		enabled: !!org && !!project && !!a && !!b && a !== b,
		staleTime: STALE_MS,
	});
}

export function useIntelligenceResourceVersions(
	org?: string,
	project?: string,
	resource?: string,
	range: IntelligenceRange = "7d",
) {
	return useQuery({
		queryKey: ["intelligence", org, project, "resources", resource, "versions", range],
		queryFn: () => intelligence.resourceVersions(org || "", project || "", resource || "", range),
		enabled: !!org && !!project && !!resource,
		staleTime: STALE_MS,
	});
}

export function useIntelligenceHistory(
	org?: string,
	project?: string,
	range: IntelligenceRange = "7d",
	params: { resource?: string; category?: HistoryCategory; page?: number; pageSize?: number } = {},
) {
	return useQuery({
		queryKey: ["intelligence", org, project, "history", range, params],
		queryFn: () => intelligence.history(org || "", project || "", range, params),
		enabled: !!org && !!project,
		staleTime: STALE_MS,
		placeholderData: keepPreviousData,
	});
}
