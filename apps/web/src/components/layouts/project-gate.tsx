// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Project context gate for project-facing application routes. A project is the
// mandatory working context for every project resource, so this gate never
// lets a project-facing route render without a valid project in the URL. It
// establishes a project in the URL (deterministic redirect), asks the user to
// pick one, surfaces a setup state when there are none, or rejects a URL that
// names a project outside the organization - it never silently adopts a cached
// or arbitrary project. Organization- and account-scoped routes pass through
// untouched.

import { useEffect, type ReactNode } from "react";
import { useRouterState } from "@tanstack/react-router";
import { Building2, FolderKanban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCurrentOrg } from "@/hooks/use-current-org";
import { useCurrentProject } from "@/hooks/use-current-project";
import { decideProjectGate } from "@/lib/project-gate";
import { canManageOrganization } from "@/lib/permissions";
import {
	getTenant,
	isProjectFreePath,
	orgOrigin,
	pathWithoutProjectPrefix,
	supportsOrgSubdomains,
} from "@/lib/tenant-host";

function GateShell({ children }: { children: ReactNode }) {
	return (
		<div className="mx-auto flex min-h-[60vh] w-full max-w-xl flex-col items-center justify-center gap-4 px-4 py-12 text-center">
			{children}
		</div>
	);
}

function Blocking() {
	return <div className="flex h-full w-full items-center justify-center" aria-busy="true" />;
}

export function ProjectGate({ children }: { children: ReactNode }) {
	// Reactive to client navigation; stripped defensively so the classification
	// holds whether or not the router reports the basepath in the pathname.
	const rawPath = useRouterState({ select: (s) => s.location.pathname });
	const { currentOrg, isLoading: orgLoading, orgs } = useCurrentOrg();
	const {
		projects,
		isLoading: projectsLoading,
		currentProject,
		preferredProject,
		urlProjectInvalid,
		needsSelection,
		noProjects,
		setCurrentProject,
	} = useCurrentProject();

	const { urlProject } = getTenant();
	const inApp = pathWithoutProjectPrefix(rawPath, urlProject);
	const isFree = isProjectFreePath(inApp);

	const decision = decideProjectGate({
		isProjectFree: isFree,
		orgLoading,
		hasOrg: !!currentOrg,
		projectsLoading,
		currentProject,
		preferredProject,
		urlProjectInvalid,
		needsSelection,
		noProjects,
	});

	// The canonical destination when the current URL is not it yet: establish a
	// project in the URL, and/or move a subdomain deployment reached on a plain
	// host onto the authoritative org host. Both are hard navigations so the
	// router basepath - and every scoped request - is rebuilt for the context.
	const redirectTarget = canonicalDestination(decision, {
		hostOrg: getTenant().hostOrg,
		currentOrgSlug: currentOrg?.slug,
		currentProjectSlug: currentProject?.slug,
		inApp,
	});
	useEffect(() => {
		if (redirectTarget) window.location.assign(redirectTarget);
	}, [redirectTarget]);
	if (redirectTarget) return <Blocking />;

	switch (decision.kind) {
		case "render":
			return <>{children}</>;
		case "needsOrg":
			return (
				<GateShell>
					<Building2 className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
					<div>
						<h1 className="text-lg font-semibold">Select an organization</h1>
						<p className="mt-1 text-sm text-muted-foreground">
							Choose an organization from the switcher to continue.
						</p>
					</div>
					{orgs.length === 0 && (
						<Button asChild size="sm">
							<a href="/onboarding">Set up your workspace</a>
						</Button>
					)}
				</GateShell>
			);
		case "notFound":
			return (
				<GateShell>
					<FolderKanban className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
					<div>
						<h1 className="text-lg font-semibold">Project not found</h1>
						<p className="mt-1 text-sm text-muted-foreground">
							This project does not exist in this organization, or you do not have access to it.
						</p>
					</div>
					<Button asChild size="sm">
						<a href="/">Choose a project</a>
					</Button>
				</GateShell>
			);
		case "noProjects":
			return (
				<GateShell>
					<FolderKanban className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
					<div>
						<h1 className="text-lg font-semibold">No projects yet</h1>
						<p className="mt-1 text-sm text-muted-foreground">
							{currentOrg?.name ?? "This organization"} has no projects you can access.{" "}
							{canManageOrganization(currentOrg)
								? "Create one to start working."
								: "Ask an organization admin to add you to a project."}
						</p>
					</div>
					{canManageOrganization(currentOrg) && (
						<Button asChild size="sm">
							<a href="/organization/projects">Manage projects</a>
						</Button>
					)}
				</GateShell>
			);
		case "picker":
			return (
				<GateShell>
					<FolderKanban className="h-8 w-8 text-primary-accent" aria-hidden="true" />
					<div>
						<h1 className="text-lg font-semibold">Choose a project</h1>
						<p className="mt-1 text-sm text-muted-foreground">
							Select a project in {currentOrg?.name} to continue.
						</p>
					</div>
					<div className="flex w-full flex-col gap-2">
						{projects.map((project) => (
							<button
								key={project.id}
								type="button"
								onClick={() => setCurrentProject(project.slug)}
								className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-left text-sm outline-none ring-ring transition-colors hover:border-input hover:bg-accent/40 focus-visible:ring-2"
							>
								<FolderKanban className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
								<span className="min-w-0 flex-1 truncate">{project.name}</span>
								<span className="font-mono text-[10px] text-muted-foreground">{project.slug}</span>
							</button>
						))}
					</div>
				</GateShell>
			);
		default:
			return <Blocking />;
	}
}

interface DestinationContext {
	hostOrg: string | null;
	currentOrgSlug: string | undefined;
	currentProjectSlug: string | undefined;
	inApp: string;
}

/** The canonical URL to navigate to, or null when the current URL is canonical. */
function canonicalDestination(
	decision: ReturnType<typeof decideProjectGate>,
	ctx: DestinationContext,
): string | null {
	if (decision.kind !== "redirect" && decision.kind !== "render") return null;
	const rest = ctx.inApp === "/" ? "/" : ctx.inApp;
	const search = window.location.search;
	// Subdomain deployments: the org host is authoritative. On a plain host with
	// a known org, move to the org subdomain (carrying the resolved project).
	const wantsSubdomain = !ctx.hostOrg && !!ctx.currentOrgSlug && supportsOrgSubdomains(window.location.hostname);
	const projectSlug = decision.kind === "redirect" ? decision.projectSlug : ctx.currentProjectSlug;
	if (!projectSlug) return null;
	if (wantsSubdomain) {
		return `${orgOrigin(ctx.currentOrgSlug!)}/${projectSlug}${rest}${search}`;
	}
	if (decision.kind === "redirect") {
		return `/${projectSlug}${rest}${search}`;
	}
	return null;
}
