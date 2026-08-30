// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { createContext, useCallback, useContext, useMemo } from "react";
import { Link, Outlet, useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { Activity } from "lucide-react";
import { PageHeader } from "@/components/layouts/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/skeleton-layouts";
import { useIntelligenceContext } from "@/hooks/use-intelligence-workspace";
import type { IntelligenceRange } from "@/lib/types";
import { cn } from "@/lib/utils";
import { RANGES, RangeSelector } from "./shared";

const MODES = [
	{ to: "/intelligence", label: "Summary" },
	{ to: "/intelligence/resources", label: "Resources" },
	{ to: "/intelligence/history", label: "History" },
] as const;

type IntelligenceWorkspaceValue = {
	org?: string;
	project?: string;
	projectName?: string;
	range: IntelligenceRange;
	resource?: string;
	setContext: (patch: Record<string, unknown>) => void;
};

const IntelligenceWorkspaceContext = createContext<IntelligenceWorkspaceValue | null>(null);

export function useIntelligenceWorkspace() {
	const value = useContext(IntelligenceWorkspaceContext);
	if (!value) throw new Error("useIntelligenceWorkspace must be used inside IntelligenceLayout");
	return value;
}

function IntelligenceModes({ pathname, range, resource }: { pathname: string; range: IntelligenceRange; resource?: string }) {
	const preservedSearch = { range, ...(resource ? { resource } : {}) };
	return (
		<nav className="flex h-11 items-end gap-5" aria-label="Intelligence views">
			{MODES.map((mode) => {
				const active = mode.to === "/intelligence" ? pathname === mode.to : pathname.startsWith(mode.to);
				return (
					<Link
						key={mode.to}
						to={mode.to}
						search={preservedSearch}
						aria-current={active ? "page" : undefined}
						className={cn(
							"flex h-full items-center border-b-2 text-xs font-medium",
							active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
						)}
					>
						{mode.label}
					</Link>
				);
			})}
		</nav>
	);
}

export default function IntelligenceLayout() {
	const navigate = useNavigate();
	const { pathname } = useLocation();
	const search = useSearch({ strict: false }) as { range?: IntelligenceRange; resource?: string };
	const range = search.range && RANGES.some((candidate) => candidate.value === search.range) ? search.range : "7d";
	const { org, project, projectName, noProjects, contextLoading } = useIntelligenceContext();
	const setContext = useCallback(
		(patch: Record<string, unknown>) =>
			navigate({ to: ".", search: (current: Record<string, unknown>) => ({ ...current, ...patch }) }),
		[navigate],
	);
	const value = useMemo(
		() => ({ org, project, projectName, range, resource: search.resource, setContext }),
		[org, project, projectName, range, search.resource, setContext],
	);

	return (
		<IntelligenceWorkspaceContext.Provider value={value}>
			<PageHeader
				title="Intelligence"
				breadcrumbs={[{ label: projectName || "Project" }]}
				actionButtonsLeft={<IntelligenceModes pathname={pathname} range={range} resource={search.resource} />}
				actionButtonsRight={<RangeSelector range={range} onChange={(next) => setContext({ range: next, page: 1 })} />}
			/>
			{contextLoading ? (
				<div className="p-6"><TableSkeleton rows={7} cols={4} /></div>
			) : noProjects || !project ? (
				<div className="p-6">
					<EmptyState icon={Activity} title="No project selected" description="Intelligence follows the active project. Select or create a project to begin." />
				</div>
			) : (
				<main className="mx-auto w-full max-w-350 px-4 py-6 sm:px-6 lg:px-8">
					<Outlet />
				</main>
			)}
		</IntelligenceWorkspaceContext.Provider>
	);
}
