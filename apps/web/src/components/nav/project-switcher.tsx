// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Project switcher for the app chrome. A project is the mandatory working
// context for resources: there is no "no project" browsing state and no way
// to deselect. The store resolves a single-project org naturally; with
// several projects the trigger asks for an explicit pick, and an org without
// projects surfaces as a setup state pointing at organization administration.

import { useQueryClient } from "@tanstack/react-query";
import { Building2, Check, ChevronsUpDown, FolderKanban, Settings2 } from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCurrentOrg } from "@/hooks/use-current-org";
import { useCurrentProject } from "@/hooks/use-current-project";
import { canManageOrganization } from "@/lib/permissions";
import { cn } from "@/lib/utils";

export function ProjectSwitcher({ className }: { className?: string }) {
	const { currentOrg, isLoading: orgsLoading, orgs } = useCurrentOrg();
	const { projects, currentProject, preferredProject, setCurrentProject, isLoading, needsSelection, noProjects } = useCurrentProject();
	const displayedProject = currentProject ?? preferredProject;
	const queryClient = useQueryClient();

	// Switching projects replaces the working context entirely. The URL rewrite
	// below usually forces a full navigation, but on hosts without subdomain
	// support it does not - so the cache is dropped explicitly to guarantee no
	// previous-project data stays visible, cached, or selectable.
	const selectProject = (slug: string) => {
		if (slug === currentProject?.slug) return;
		setCurrentProject(slug);
		queryClient.clear();
	};

	if (orgsLoading) return null;

	// No tenant context: send the user to explicit selection, never guess.
	// Plain anchor: /onboarding lives outside the project basepath.
	if (!currentOrg) {
		if (orgs.length === 0) return null;
		return (
			<a
				href="/onboarding"
				className={cn(
					"flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border px-2 text-xs font-medium text-muted-foreground outline-none ring-ring transition-colors hover:border-input hover:text-foreground focus-visible:ring-2",
					className,
				)}
			>
				<Building2 aria-hidden="true" className="h-3.5 w-3.5" />
				Select organization
			</a>
		);
	}

	const triggerText = displayedProject
		? displayedProject.name
		: noProjects
			? "No projects"
			: isLoading
				? "Loading…"
				: "Select project";

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={
					displayedProject
						? `Project: ${displayedProject.name} in ${currentOrg.name}`
						: `Select a project in ${currentOrg.name}`
				}
				className={cn(
					"flex h-8 max-w-56 shrink-0 items-center gap-1.5 rounded-md border px-2 text-sm outline-none ring-ring transition-colors hover:border-input hover:bg-accent/40 focus-visible:ring-2",
					needsSelection ? "border-primary-accent/50" : "border-border",
					className,
				)}
			>
				<FolderKanban aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-primary-accent" />
				<span className="truncate text-xs font-medium">{triggerText}</span>
				<span className="hidden truncate font-mono text-[10px] text-muted-foreground lg:inline">
					{currentOrg.slug}
				</span>
				<ChevronsUpDown aria-hidden="true" className="h-3 w-3 shrink-0 text-muted-foreground" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-64">
				<DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground">
					Projects in {currentOrg.name}
				</DropdownMenuLabel>
				<div className="max-h-72 overflow-y-auto overscroll-contain">
					{isLoading ? (
						<DropdownMenuItem disabled>Loading projects…</DropdownMenuItem>
					) : noProjects ? (
						<div className="px-2 py-2 text-xs text-muted-foreground">
							This organization has no projects yet. An organization admin can create one to start working.
						</div>
					) : (
						projects.map((project) => (
							<DropdownMenuItem
								key={project.id}
									onSelect={() => selectProject(project.slug)}
								className="gap-2"
							>
								<FolderKanban className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
								<span className="min-w-0 flex-1">
									<span className="block truncate text-sm">{project.name}</span>
									<span className="block truncate font-mono text-[10px] text-muted-foreground">
										{currentOrg.slug}/{project.slug}
									</span>
								</span>
								{project.role && (
									<span className="text-[10px] capitalize text-muted-foreground">{project.role}</span>
								)}
								{project.slug === displayedProject?.slug && (
									<Check className="h-3.5 w-3.5 shrink-0 text-primary-accent" />
								)}
							</DropdownMenuItem>
						))
					)}
				</div>
				{canManageOrganization(currentOrg) ? (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem asChild>
							{/* Plain anchor: leaves project context, so the URL must drop the prefix. */}
							<a href="/organization" className="gap-2">
								<Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
								Manage organization
							</a>
						</DropdownMenuItem>
					</>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
